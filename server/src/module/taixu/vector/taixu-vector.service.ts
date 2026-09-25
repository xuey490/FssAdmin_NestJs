import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { QdrantVectorStore } from '@langchain/qdrant';
import { Document } from '@langchain/core/documents';
import { TaixuLlmService } from '../llm/taixu-llm.service';
import { TaixuLlmRuntimeService } from '../llm/taixu-llm-runtime.service';
import { normalizeTaixuDistance } from '../llm/taixu-llm-config.util';

type QdrantDistance = 'Cosine' | 'Euclid' | 'Dot';

@Injectable()
export class TaixuVectorService implements OnModuleDestroy {
  /** Qdrant 客户端惰性单例：避免每次访问都新建实例（各自持有独立 HTTP 连接池） */
  private qdrantClient: QdrantClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly llmService: TaixuLlmService,
    private readonly llmRuntime: TaixuLlmRuntimeService,
  ) {}

  /**
   * 获取 Qdrant 客户端实例（惰性单例）。
   * 从配置中读取 Qdrant URL 和超时时间，若未配置 URL 则返回 null。
   * @returns Qdrant 客户端实例或 null
   */
  private get client() {
    if (this.qdrantClient) {
      return this.qdrantClient;
    }

    const url = this.configService.get<string>('taixu.qdrant.url') || '';
    if (!url) return null;

    const timeout = Number(this.configService.get<number>('taixu.qdrant.timeout') ?? 30);
    this.qdrantClient = new QdrantClient({ url, timeout: timeout * 1000 });
    return this.qdrantClient;
  }

  /**
   * 模块销毁时释放客户端引用。
   * @qdrant/js-client-rest 为 REST 客户端（无显式 close API），释放引用即可随进程回收。
   */
  onModuleDestroy(): void {
    this.qdrantClient = null;
  }

  /**
   * 确保 Qdrant 集合存在。
   * 检查指定名称的集合是否已存在，若不存在则创建新集合。
   * @param client - Qdrant 客户端实例
   * @param collectionName - 集合名称
   * @param vectorSize - 向量维度
   * @param distance - 距离度量方式，默认为 Cosine
   */
  private async ensureCollection(
    client: QdrantClient,
    collectionName: string,
    vectorSize: number,
    distance: QdrantDistance = 'Cosine',
  ) {
    const exists = await client.collectionExists(collectionName).then((r) => r.exists).catch(() => false);
    if (exists) return;
    await client.createCollection(collectionName, {
      vectors: { size: vectorSize, distance },
    });
  }

  getCollectionName(tenantId: number, libraryNumber: string) {
    const prefix = this.configService.get<string>('taixu.qdrant.collectionPrefix') || 'taixu_rag_';
    return `${prefix}${tenantId}_${libraryNumber}`;
  }

  /**
   * 批量写入文档分块到 Qdrant 向量库。
   * 自动创建或复用集合，使用 Embedding 模型编码后分批存储。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param chunks - 文档分块列表，每块包含文本和索引
   * @param opts - 可选参数，包含来源 ID、RAG 配置和进度回调
   */
  async upsertDocumentChunks(
    tenantId: number,
    libraryNumber: string,
    chunks: Array<{ text: string; chunkIndex: number }>,
    opts?: {
      sourceId?: string;
      rag?: Record<string, any>;
      onProgress?: (done: number, total: number) => void;
    },
  ) {
    const client = this.client;
    if (!client) return;
    if (!chunks.length) return;
    const collectionName = this.getCollectionName(tenantId, libraryNumber);
    const settingDim = Number((opts?.rag as any)?.dimensions);
    const envDim = Number(this.configService.get<number>('taixu.qdrant.vectorSize') ?? 1024);
    const vectorSize = Number.isFinite(settingDim) && settingDim > 0 ? settingDim : envDim;
    const distance = normalizeTaixuDistance((opts?.rag as any)?.distance);
    await this.ensureCollection(client, collectionName, vectorSize, distance);
    // Fail fast if no embedding model is configured — avoids silently using an unauthenticated model
    // 复用一次 embeddings + store，避免每批重建带来的额外往返
    const embeddings = await this.llmRuntime.newEmbeddings({ rag: opts?.rag }).catch((e: any) => {
      throw new Error(`Embedding 模型未配置或初始化失败: ${e?.message ?? e}`);
    });
    const store = await QdrantVectorStore.fromExistingCollection(embeddings, {
      client,
      collectionName,
    }).catch(async () => {
      return QdrantVectorStore.fromTexts([], [], embeddings, { client, collectionName } as any);
    });

    const batchSize = Math.max(1, Number(this.configService.get<number>('taixu.qdrant.embedBatch') ?? 64));
    const total = chunks.length;
    // 顺序分批写入（不加并发），每批一次 embed+upsert，便于汇报进度
    for (let i = 0; i < total; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const docs = batch.map(
        (c) =>
          new Document({
            pageContent: c.text,
            metadata: { tenant_id: tenantId, library_number: libraryNumber, chunk_index: c.chunkIndex },
          }),
      );
      await store.addDocuments(docs);
      opts?.onProgress?.(Math.min(total, i + batch.length), total);
    }
  }

  /**
   * 执行向量相似性搜索。
   * 从指定集合中检索与查询最相似的 k 个文档。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   * @param query - 查询文本
   * @param k - 返回的文档数量
   * @param opts - 可选参数，包含来源 ID 和 RAG 配置
   * @returns 检索到的文档列表
   */
  async similaritySearch(
    tenantId: number,
    libraryNumber: string,
    query: string,
    k: number,
    opts?: { sourceId?: string; rag?: Record<string, any> },
  ) {
    const client = this.client;
    if (!client) return [];
    const collectionName = this.getCollectionName(tenantId, libraryNumber);
    const embeddings = await this.llmRuntime.newEmbeddings({ rag: opts?.rag }).catch((e: any) => {
      throw new Error(`Embedding 模型未配置或初始化失败: ${e?.message ?? e}`);
    });
    const store = await QdrantVectorStore.fromExistingCollection(embeddings, {
      client,
      collectionName,
    });
    return store.similaritySearch(query, k);
  }

  /**
   * 删除指定知识库的 Qdrant 集合。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 知识库编号
   */
  async deleteCollection(tenantId: number, libraryNumber: string) {
    const client = this.client;
    if (!client) return;
    const collectionName = this.getCollectionName(tenantId, libraryNumber);
    await client.deleteCollection(collectionName).catch(() => undefined);
  }
}
