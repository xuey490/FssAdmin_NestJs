import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver } from 'neo4j-driver';
import { Neo4jGraph } from '@langchain/neo4j';
import { LLMGraphTransformer } from '@langchain/community/experimental/graph_transformers/llm';
import { Document } from '@langchain/core/documents';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';

@Injectable()
export class TaixuGraphService implements OnModuleDestroy {
  private readonly logger = new Logger(TaixuGraphService.name);
  private driver: Driver | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 模块销毁时关闭 Neo4j 驱动，释放其连接池。
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.driver) return;

    try {
      await this.driver.close();
      this.logger.log('Neo4j 驱动已关闭');
    } catch (error) {
      this.logger.warn(`关闭 Neo4j 驱动失败: ${(error as Error)?.message}`);
    } finally {
      this.driver = null;
    }
  }

  /**
   * 获取 Neo4j 数据库连接配置。
   * 从应用配置中读取 Bolt URL、用户名和密码。
   * @returns Neo4j 连接配置对象
   */
  private getNeo4jConfig() {
    const url = this.configService.get<string>('taixu.neo4j.boltUrl') || '';
    const username = this.configService.get<string>('taixu.neo4j.username') || '';
    const password = this.configService.get<string>('taixu.neo4j.password') || '';
    return { url, username, password };
  }

  /**
   * 获取 Neo4j 驱动实例（单例）。
   * 首次调用时根据配置创建驱动，之后复用已创建的实例。
   * @returns Neo4j 驱动实例，若配置不完整则返回 null
   */
  private getDriver() {
    if (this.driver) return this.driver;
    const { url, username, password } = this.getNeo4jConfig();
    if (!url || !username) return null;
    this.driver = neo4j.driver(url, neo4j.auth.basic(username, password));
    return this.driver;
  }

  /**
   * 生成 Neo4j 节点标签前缀。
   * 以 tenantId 和 libraryNumber 构造隔离的标签前缀，防止不同知识库的节点冲突。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @returns 节点标签前缀字符串
   */
  getLabelPrefix(tenantId: number, libraryNumber: string) {
    const prefix =
      this.configService.get<string>('taixu.neo4j.labelPrefix') ||
      this.configService.get<string>('taixu.qdrant.collectionPrefix') ||
      'taixu_rag_';
    return `${prefix}${tenantId}_${libraryNumber}`;
  }

  /**
   * 批量写入文档分块节点到 Neo4j。
   * 创建或更新 Chunk 节点，并按顺序建立 NEXT/PREV 相邻关系。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param chunks - 文档分块列表，每块包含索引和文本
   */
  async upsertChunkNodes(tenantId: number, libraryNumber: string, chunks: Array<{ chunkIndex: number; text: string }>) {
    const driver = this.getDriver();
    if (!driver) return;
    const label = this.getLabelPrefix(tenantId, libraryNumber);
    const session = driver.session();
    try {
      const rows = chunks.map((c) => ({
        tenantId,
        libraryNumber,
        chunkIndex: c.chunkIndex,
        text: c.text.slice(0, 2000),
      }));
      await session.run(
        `UNWIND $rows AS row
         MERGE (n:\`${label}\` {chunk_index: row.chunkIndex})
         SET n.tenant_id=row.tenantId, n.library_number=row.libraryNumber, n.text=row.text`,
        { rows },
      );

      const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
      const rels = sorted.slice(1).map((c, idx) => ({
        from: sorted[idx].chunkIndex,
        to: c.chunkIndex,
      }));
      if (rels.length) {
        await session.run(
          `UNWIND $rels AS rel
           MATCH (a:\`${label}\` {chunk_index: rel.from})
           MATCH (b:\`${label}\` {chunk_index: rel.to})
           MERGE (a)-[:NEXT]->(b)
           MERGE (b)-[:PREV]->(a)`,
          { rels },
        );
      }
    } finally {
      await session.close();
    }
  }

  /**
   * 并发池执行器。
   * 保持结果顺序，限制同时进行的任务数，避免一次性打满外部接口。
   * @param items - 待处理的项目列表
   * @param concurrency - 并发数
   * @param fn - 异步处理函数
   * @returns 处理结果数组，顺序与输入一致
   */
  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * 对齐 taixu graph_store：用 LLM 抽取实体关系图并写入 Neo4j。
   * 节点 type 前缀化（tenant_library）以隔离不同知识库。
   * ponytail: 需要 Neo4j 已安装 APOC（与 taixu 一致）；跨库相同实体 id 会合并到同一节点，属可接受上限。
   */
  async addDocumentGraph(
    tenantId: number,
    libraryNumber: string,
    texts: string[],
    llm: BaseLanguageModel,
    opts?: { concurrency?: number },
  ) {
    const { url, username, password } = this.getNeo4jConfig();
    if (!url || !username) {
      this.logger.warn('Neo4j graph extraction skipped: TAIXU_NEO4J_BOLT_URL or TAIXU_NEO4J_USERNAME is empty');
      return;
    }
    const chunks = texts.map((t) => String(t || '').trim()).filter(Boolean);
    if (!chunks.length) return;

    const prefix = `${this.getLabelPrefix(tenantId, libraryNumber)}_`;
    const transformer = new LLMGraphTransformer({ llm });
    const documents = chunks.map((t) => new Document({ pageContent: t }));
    // 并行抽取（库自带 convertToGraphDocuments 是串行，这里用并发池对齐 taixu ThreadPoolExecutor）
    const concurrency = Math.max(1, Math.min(32, Number(opts?.concurrency) || 5));
    const graphDocuments = await this.mapWithConcurrency(documents, concurrency, (doc) =>
      transformer.processResponse(doc),
    );

    // 每个 Node 实例只前缀一次（relationship 端点可能与 nodes 共享实例，避免重复前缀）
    const prefixed = new Set<object>();
    const applyPrefix = (node: { type: string }) => {
      if (prefixed.has(node as object)) return;
      node.type = prefix + node.type;
      prefixed.add(node as object);
    };
    for (const gd of graphDocuments) {
      gd.nodes.forEach((n) => applyPrefix(n));
      gd.relationships.forEach((r) => {
        applyPrefix(r.source);
        applyPrefix(r.target);
      });
    }

    const graph = new Neo4jGraph({ url, username, password });
    try {
      // baseEntityLabel/includeSource=false：仅落地前缀化实体与关系，便于按前缀清理
      await graph.addGraphDocuments(graphDocuments, { baseEntityLabel: false, includeSource: false });
    } finally {
      await graph.close().catch(() => undefined);
    }
  }

  /**
   * 根据 Chunk 索引批量查询 Neo4j 节点。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param chunkIndexes - Chunk 索引数组
   * @returns 匹配的 Chunk 数据列表（含索引和文本）
   */
  async getChunksByIndexes(tenantId: number, libraryNumber: string, chunkIndexes: number[]) {
    const driver = this.getDriver();
    if (!driver) return [];
    if (!chunkIndexes.length) return [];
    const label = this.getLabelPrefix(tenantId, libraryNumber);
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (n:\`${label}\`) WHERE n.chunk_index IN $chunkIndexes
         RETURN n.chunk_index AS chunkIndex, n.text AS text
         ORDER BY n.chunk_index`,
        { chunkIndexes },
      );
      return res.records.map((r) => ({
        chunkIndex: Number(r.get('chunkIndex')),
        text: String(r.get('text') ?? ''),
      }));
    } finally {
      await session.close();
    }
  }

  private neo4jLimit(value: number) {
    // Neo4j 5+ LIMIT 必须是整数；JS number 会以 20.0 形式传入导致报错
    return neo4j.int(Math.max(0, Math.floor(Number(value) || 0)));
  }

  /**
   * 获取指定 Chunk 的相邻节点。
   * 通过 NEXT/PREV 关系查找邻接节点，支持多级扩散。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param chunkIndexes - 起始 Chunk 索引数组
   * @param limit - 最大返回数量，默认 50
   * @returns 相邻 Chunk 数据列表
   */
  async getNeighborChunks(tenantId: number, libraryNumber: string, chunkIndexes: number[], limit = 50) {
    const driver = this.getDriver();
    if (!driver) return [];
    if (!chunkIndexes.length) return [];
    const label = this.getLabelPrefix(tenantId, libraryNumber);
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (n:\`${label}\`) WHERE n.chunk_index IN $chunkIndexes
         MATCH (n)-[:NEXT|PREV*0..2]->(m:\`${label}\`)
         RETURN DISTINCT m.chunk_index AS chunkIndex, m.text AS text
         ORDER BY m.chunk_index
         LIMIT $limit`,
        { chunkIndexes, limit: this.neo4jLimit(limit) },
      );
      return res.records.map((r) => ({
        chunkIndex: Number(r.get('chunkIndex')),
        text: String(r.get('text') ?? ''),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 关键词全文搜索。
   * 在 Neo4j 中按文本包含关系模糊匹配指定关键词。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param keyword - 搜索关键词
   * @param limit - 最大返回数量，默认 20
   * @returns 匹配的 Chunk 数据列表
   */
  async keywordSearch(tenantId: number, libraryNumber: string, keyword: string, limit = 20) {
    const driver = this.getDriver();
    if (!driver) return [];
    const kw = keyword.trim();
    if (!kw) return [];
    const label = this.getLabelPrefix(tenantId, libraryNumber);
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (n:\`${label}\`)
         WHERE toLower(n.text) CONTAINS toLower($kw)
         RETURN n.chunk_index AS chunkIndex, n.text AS text
         ORDER BY n.chunk_index
         LIMIT $limit`,
        { kw, limit: this.neo4jLimit(limit) },
      );
      return res.records.map((r) => ({
        chunkIndex: Number(r.get('chunkIndex')),
        text: String(r.get('text') ?? ''),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 按标签前缀删除 Neo4j 中所有相关节点及关系。
   * 同时清理 Chunk 节点和 LLM 抽取的实体节点。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   */
  async deleteByPrefix(tenantId: number, libraryNumber: string) {
    const driver = this.getDriver();
    if (!driver) return;
    const label = this.getLabelPrefix(tenantId, libraryNumber);
    const session = driver.session();
    try {
      // 同时清理 chunk 节点（label 等于前缀）与 LLM 实体节点（label 形如 前缀_Type）
      // ponytail: 全表扫描标签，库规模大时可改用 APOC periodic.iterate 分批删除
      await session.run(
        `MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH $prefix) DETACH DELETE n`,
        { prefix: label },
      );
    } finally {
      await session.close();
    }
  }
}
