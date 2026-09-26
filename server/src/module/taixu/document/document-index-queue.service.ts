import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Redis from 'ioredis';
import { RedisService } from '../../../redis/redis.service';
import { CacheEnum } from '../../../common/enum/index';
import { TaixuSystemDocumentEntity } from './entities/taixu-system-document.entity';
import { TaixuDocumentIndexProcessorService } from './document-index-processor.service';
import { TaixuDocumentIndexTracker } from './document-index-tracker.service';
import {
  DOC_INDEX_ENQUEUED_SET,
  DOC_INDEX_PAUSED_KEY,
  DOC_INDEX_QUEUE_KEY,
  type DocumentIndexJob,
} from './document-index.types';

@Injectable()
export class TaixuDocumentIndexQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaixuDocumentIndexQueueService.name);
  private stop = false;
  private paused = false;
  private workerPromise: Promise<void> | null = null;
  private workerClient: Redis | null = null;
  /** worker 连接建立中（原子守卫）：防止并发 enqueue 重复派生连接 */
  private spawningWorker = false;
  private lastConsumedAt = 0;
  private lastErrorAt = 0;
  private lastErrorMessage = '';

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly indexTracker: TaixuDocumentIndexTracker,
    private readonly processor: TaixuDocumentIndexProcessorService,
    @InjectRepository(TaixuSystemDocumentEntity)
    private readonly documentRepo: Repository<TaixuSystemDocumentEntity>,
  ) {}

  onModuleInit() {
    void this.bootstrap();
  }

  /**
   * 模块销毁时停止 worker 并释放 Redis 连接。
   */
  onModuleDestroy() {
    this.stop = true;
    if (this.workerClient) {
      void this.workerClient.quit().catch(() => undefined);
      this.workerClient = null;
    }
    this.workerPromise = null;
  }

  /**
   * 初始化索引队列服务：延迟启动、同步暂停状态、恢复待处理文档、按需启动 worker。
   */
  private async bootstrap() {
    await new Promise((r) => setTimeout(r, 500));
    await this.syncPausedState();
    try {
      await this.recoverPendingDocuments();
    } catch (e: any) {
      this.logger.error(`recover pending documents failed: ${e?.message}`);
    }
    // 启动时仅在有待处理工作时才启动 worker
    if (await this.hasPendingWork()) {
      void this.spawnWorker();
    } else {
      this.logger.log('document index worker: nothing to do at startup, will start on next enqueue');
    }
  }

  /** 服务启动：未入库文档自动入队 */
  private async recoverPendingDocuments() {
    const rows = await this.documentRepo
      .createQueryBuilder('d')
      .where('(d.status = :pending OR d.status IS NULL)', { pending: 0 })
      .take(500)
      .getMany();
    let count = 0;
    for (const row of rows) {
      if (!row.id || !row.libraryNumber) continue;
      const enqueued = await this.enqueue(
        {
          documentId: row.id,
          tenantId: Number(row.tenantId ?? 0),
          libraryNumber: row.libraryNumber,
          ext: String(row.documentType || 'unknown'),
          documentName: String(row.documentName || ''),
        },
        { force: false },
      );
      if (enqueued) count += 1;
    }
    if (count) this.logger.log(`recovered ${count} pending document index jobs`);
  }

  /**
   * 将文档索引任务加入 Redis 队列。
   * @param job - 索引任务
   * @param opts - 可选参数，force 为 true 时强制重新入队
   * @returns 是否成功入队
   */
  async enqueue(job: DocumentIndexJob, opts?: { force?: boolean }) {
    if (!job.documentId) return false;
    try {
      const client = this.redisService.getClient();
      if (!opts?.force) {
        const added = await client.sadd(DOC_INDEX_ENQUEUED_SET, job.documentId);
        if (added === 0) return false;
      } else {
        await client.srem(DOC_INDEX_ENQUEUED_SET, job.documentId);
        await client.sadd(DOC_INDEX_ENQUEUED_SET, job.documentId);
      }
      await this.indexTracker.start(job.documentId);
      await client.rpush(DOC_INDEX_QUEUE_KEY, JSON.stringify(job));
      // 任务入队后，若 worker 已停止则重新启动
      if (!this.workerPromise) void this.spawnWorker();
      return true;
    } catch (e: any) {
      this.logger.error(`enqueue failed (${job.documentId}): ${e?.message}`);
      setImmediate(() => {
        void this.processor.run(job).catch((err: any) => {
          void this.indexTracker.fail(job.documentId, err?.message || '索引失败');
        });
      });
      return true;
    }
  }

  /**
   * 建立 worker 连接并启动循环（worker 停止后可重入）。
   *
   * 用 `spawningWorker` 做原子守卫：建连包含 await，若期间被第二次调用通过守卫，
   * 后一次会把 `this.workerClient` 覆盖成新连接，导致前一条连接永远得不到 quit
   * （常驻连接 + 其读缓冲 = 缓慢内存增长）。启动恢复阶段连续入队最容易命中该窗口。
   */
  private async spawnWorker() {
    if (this.stop || this.workerPromise || this.spawningWorker) return;

    this.spawningWorker = true;
    let client: Redis | null = null;

    try {
      const base = this.redisService.getClient();
      client = base.duplicate({ lazyConnect: false });
      const st = String((client as any)?.status || '');
      if (st !== 'ready' && st !== 'connect') await client.connect();

      // 建连期间可能已收到停止指令：直接释放该连接，不纳入 worker 管理
      if (this.stop) {
        void client.quit().catch(() => undefined);
        return;
      }

      this.workerClient = client;
      this.workerPromise = this.runWorker();
    } catch (e: any) {
      this.logger.error(`worker redis connect failed: ${e?.message}`);
      // 建连失败同样要关闭刚派生的连接，避免连接与其读缓冲常驻
      if (client) void client.quit().catch(() => undefined);
      this.workerClient = null;
      // 保持原有韧性：回退到共享连接继续跑 worker（由循环内的错误重试兜底）
      if (!this.stop) this.workerPromise = this.runWorker();
    } finally {
      this.spawningWorker = false;
    }
  }

  /**
   * 从队列中移除指定文档 ID。
   * @param documentId - 文档 ID
   */
  async removeFromQueue(documentId: string) {
    try {
      await this.redisService.getClient().srem(DOC_INDEX_ENQUEUED_SET, documentId);
    } catch {
      void 0;
    }
  }

  /**
   * 暂停索引队列处理。
   * @returns 当前队列控制状态
   */
  async pause() {
    this.paused = true;
    try {
      await this.redisService.set(DOC_INDEX_PAUSED_KEY, 1);
    } catch (e: any) {
      this.logger.warn(`persist pause flag failed: ${e?.message}`);
    }
    return this.getControlStatus();
  }

  /**
   * 恢复索引队列处理。
   * @returns 当前队列控制状态
   */
  async resume() {
    this.paused = false;
    try {
      await this.redisService.del(DOC_INDEX_PAUSED_KEY);
    } catch (e: any) {
      this.logger.warn(`clear pause flag failed: ${e?.message}`);
    }
    return this.getControlStatus();
  }

  /**
   * 获取队列控制状态，包含暂停状态、登录状态、队列长度等信息。
   * @returns 队列控制状态对象
   */
  async getControlStatus() {
    const requireLogin = this.requireLoginForWorker();
    const hasLogin = requireLogin ? await this.hasActiveLoginSession() : true;
    let queue_length = 0;
    let enqueued_count = 0;
    try {
      const client = this.redisService.getClient();
      queue_length = await client.llen(DOC_INDEX_QUEUE_KEY);
      enqueued_count = await client.scard(DOC_INDEX_ENQUEUED_SET);
    } catch {
      void 0;
    }
    return {
      paused: this.paused,
      has_login: hasLogin,
      require_login: requireLogin,
      running: !this.paused && hasLogin,
      queue_length,
      enqueued_count,
    };
  }

  /** ponytail: 默认不要求登录才消费队列；后台索引不应依赖前台会话 */
  private requireLoginForWorker() {
    return this.configService.get<boolean>('taixu.documents.indexRequireLogin') === true;
  }

  /**
   * 获取 worker 健康状态，包含 Redis 连接状态、消费时间和错误信息。
   * @returns 健康状态对象
   */
  getHealthStatus() {
    const client = this.workerClient as any;
    const redisStatus = String(client?.status || '');
    const connected = redisStatus === 'ready' || redisStatus === 'connect';
    return {
      worker_connected: connected,
      worker_status: redisStatus || 'unknown',
      last_consumed_at: this.lastConsumedAt || null,
      last_error_at: this.lastErrorAt || null,
      last_error_message: this.lastErrorMessage || null,
    };
  }

  /** 队列有待处理数据 OR DB 还有 status=0 文档时返回 true */
  private async hasPendingWork(): Promise<boolean> {
    try {
      const queueLen = await this.redisService.getClient().llen(DOC_INDEX_QUEUE_KEY);
      if (queueLen > 0) return true;
    } catch {
      void 0;
    }
    const count = await this.documentRepo
      .createQueryBuilder('d')
      .where('(d.status = :s OR d.status IS NULL)', { s: 0 })
      .limit(1)
      .getCount()
      .catch(() => 0);
    return count > 0;
  }

  /**
   * ponytail: BRPOP 单 worker 顺序执行。
   * 当队列为空且 DB 无 status=0 文档时自动退出，不再空转。
   * 上传/重新索引调用 enqueue() 时会重新启动 worker。
   */
  private async runWorker() {
    const client = this.workerClient || this.redisService.getClient();
    this.logger.log('document index worker started');
    while (!this.stop) {
      try {
        if (this.paused) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (this.requireLoginForWorker() && !(await this.hasActiveLoginSession())) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        // 空闲检测：brpop 超时前先判断有没有活可干
        if (!(await this.hasPendingWork())) {
          this.logger.log('document index worker: no pending work, stopping');
          break;
        }
        const popped = await client.brpop(DOC_INDEX_QUEUE_KEY, 3);
        if (!popped) {
          // brpop 超时（3s 内没任务）再判一次，空就退出
          if (!(await this.hasPendingWork())) {
            this.logger.log('document index worker: queue idle, stopping');
            break;
          }
          continue;
        }
        const raw = popped[1];
        let job: DocumentIndexJob;
        try {
          job = JSON.parse(raw) as DocumentIndexJob;
        } catch {
          this.logger.warn(`invalid index job payload: ${raw?.slice(0, 120)}`);
          continue;
        }
        try {
          await this.processor.run(job);
          this.lastConsumedAt = Date.now();
        } catch (e: any) {
          this.logger.error(`index job ${job.documentId} failed: ${e?.message}`);
          this.lastErrorAt = Date.now();
          this.lastErrorMessage = String(e?.message || '索引失败');
          await this.documentRepo.update({ id: job.documentId, tenantId: job.tenantId } as any, { status: 0 });
          await this.indexTracker.fail(job.documentId, e?.message || '索引失败');
        } finally {
          await client.srem(DOC_INDEX_ENQUEUED_SET, job.documentId);
        }
      } catch (e: any) {
        if (this.stop) break;
        const isConnErr = /ECONNREFUSED|ENOTFOUND|connect/i.test(e?.message || '');
        this.logger.warn(`index worker loop error: ${e?.message}`);
        this.lastErrorAt = Date.now();
        this.lastErrorMessage = String(e?.message || 'index worker loop error');
        await new Promise((r) => setTimeout(r, isConnErr ? 10_000 : 1_000));
      }
    }
    this.logger.log('document index worker stopped');
    // 退出时释放独立连接
    if (this.workerClient) {
      void this.workerClient.quit().catch(() => undefined);
      this.workerClient = null;
    }
    this.workerPromise = null;
  }

  /**
   * 从 Redis 同步暂停标志到内存。
   */
  private async syncPausedState() {
    try {
      const raw = await this.redisService.get(DOC_INDEX_PAUSED_KEY);
      this.paused = String(raw ?? '') === '1' || raw === 1 || raw === true;
    } catch (e: any) {
      this.logger.warn(`load pause flag failed: ${e?.message}`);
      this.paused = false;
    }
  }

  /**
   * 检查是否有活跃的登录会话（通过 Redis 扫描登录令牌键）。
   * @returns 是否存在活跃会话
   */
  private async hasActiveLoginSession(): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const result = await client.scan('0', 'MATCH', `${CacheEnum.LOGIN_TOKEN_KEY}*`, 'COUNT', '1');
      const keys = Array.isArray(result) ? result[1] : [];
      return Array.isArray(keys) && keys.length > 0;
    } catch (e: any) {
      this.logger.warn(`check active login failed: ${e?.message}`);
      // Redis unavailable: don't block worker forever
      return true;
    }
  }
}
