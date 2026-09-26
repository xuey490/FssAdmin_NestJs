import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

import { RedisService } from '../../../redis/redis.service';
import { TaixuDocumentIndexQueueService } from './document-index-queue.service';
import type { TaixuDocumentIndexProcessorService } from './document-index-processor.service';
import type { TaixuDocumentIndexTracker } from './document-index-tracker.service';
import type { DocumentIndexJob } from './document-index.types';
import type { TaixuSystemDocumentEntity } from './entities/taixu-system-document.entity';

// processor / tracker 在本用例中只作为 DI token 使用（注入的是 mock 实例），
// 真实实现会拉起 llm-runtime → setting → common/utils（uuid 为纯 ESM）等重依赖链，
// 与 jest 的 CJS 转换不兼容，故打桩掉
jest.mock('./document-index-processor.service', () => ({
  TaixuDocumentIndexProcessorService: class TaixuDocumentIndexProcessorService {},
}));
jest.mock('./document-index-tracker.service', () => ({
  TaixuDocumentIndexTracker: class TaixuDocumentIndexTracker {},
}));

interface MockClient {
  status: string;
  duplicate: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  sadd: jest.Mock;
  srem: jest.Mock;
  rpush: jest.Mock;
  brpop: jest.Mock;
}

const createClient = (status = 'ready'): MockClient => ({
  status,
  duplicate: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue('OK'),
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
  rpush: jest.fn().mockResolvedValue(1),
  brpop: jest.fn().mockResolvedValue(null),
});

/** 让 worker 的建连/退出清理跑完，避免留下未清理的定时器（jest 会因此报 worker 未优雅退出） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const createJob = (documentId: string): DocumentIndexJob =>
  ({
    documentId,
    tenantId: 1,
    libraryNumber: 'LIB-1',
    ext: 'pdf',
    documentName: `${documentId}.pdf`,
  }) as DocumentIndexJob;

/**
 * 构造测试用服务实例。
 * 关键点：派生连接初始状态为 `connecting` 且 connect 会真正让出事件循环，
 * 用来复现"建连期间第二次 enqueue 通过守卫"的并发窗口。
 */
const createHarness = () => {
  const base = createClient();
  const derivedClients: MockClient[] = [];

  base.duplicate.mockImplementation(() => {
    const client = createClient('connecting');
    client.connect = jest.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    derivedClients.push(client);

    return client;
  });

  const redisService = { getClient: () => base } as unknown as RedisService;
  const indexTracker = {
    start: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  } as unknown as TaixuDocumentIndexTracker;
  const processor = { run: jest.fn().mockResolvedValue(undefined) } as unknown as TaixuDocumentIndexProcessorService;
  const documentRepo = { update: jest.fn() } as unknown as Repository<TaixuSystemDocumentEntity>;
  const configService = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;

  const service = new TaixuDocumentIndexQueueService(
    configService,
    redisService,
    indexTracker,
    processor,
    documentRepo,
  );

  // 让 worker 循环立即判定"无待处理工作"退出，避免测试中出现常驻循环/定时器
  jest
    .spyOn(service as unknown as { hasPendingWork(): Promise<boolean> }, 'hasPendingWork')
    .mockResolvedValue(false);
  // 日志降噪
  (service as unknown as { logger: unknown }).logger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };

  return { service, base, derivedClients };
};

describe('TaixuDocumentIndexQueueService（worker 连接派生）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('并发入队时只派生一条 worker 连接（回归：避免连接与读缓冲永久残留）', async () => {
    const { service, base, derivedClients } = createHarness();

    await Promise.all([
      service.enqueue(createJob('doc-1')),
      service.enqueue(createJob('doc-2')),
      service.enqueue(createJob('doc-3')),
    ]);

    expect(base.duplicate).toHaveBeenCalledTimes(1);
    expect(derivedClients).toHaveLength(1);

    await settle();
  });

  it('worker 停止后再次入队仍能重新派生（守卫不会把 worker 永久锁死）', async () => {
    const { service, base } = createHarness();

    await service.enqueue(createJob('doc-1'));
    // 派生连接的 connect 用 setTimeout(0) 模拟让出事件循环，需等真实定时器才能观察"守卫已释放"
    await settle();

    await service.enqueue(createJob('doc-2'));
    await settle();

    expect(base.duplicate).toHaveBeenCalledTimes(2);
  });

  it('派生连接建立失败时关闭该连接，并回退到共享连接继续运行 worker', async () => {
    const { service, base } = createHarness();
    const runWorker = jest.spyOn(
      service as unknown as { runWorker(): Promise<void> },
      'runWorker',
    );

    const failingClient = createClient('connecting');
    failingClient.connect = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    base.duplicate.mockReturnValue(failingClient);

    await service.enqueue(createJob('doc-1'));
    await settle();

    expect(failingClient.quit).toHaveBeenCalled();
    expect(runWorker).toHaveBeenCalled();
  });

  it('已停止时不再派生新连接', async () => {
    const { service, base } = createHarness();
    (service as unknown as { stop: boolean }).stop = true;

    await service.enqueue(createJob('doc-1'));

    expect(base.duplicate).not.toHaveBeenCalled();
  });
});
