import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, Observable, of, throwError } from 'rxjs';

import { MemoryMonitorService } from '../../module/monitor/memory/memory-monitor.service';
import { MemoryMonitorInterceptor } from './memory-monitor.interceptor';

const mb = (n: number) => n * 1024 * 1024;

interface Logged {
  log: string[];
  warn: string[];
}

const createMonitor = (enabled: boolean) =>
  ({
    isMonitorEnabled: () => enabled,
    checkMemory: jest.fn().mockResolvedValue(true),
  }) as unknown as MemoryMonitorService;

const createContext = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const createHandler = (source: Observable<unknown>): CallHandler =>
  ({ handle: () => source }) as unknown as CallHandler;

/** 替换私有 logger，避免污染测试输出并便于断言告警 */
const attachRecorder = (interceptor: MemoryMonitorInterceptor): Logged => {
  const logged: Logged = { log: [], warn: [] };

  (interceptor as unknown as { logger: unknown }).logger = {
    log: (message: string) => logged.log.push(message),
    warn: (message: string) => logged.warn.push(message),
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };

  return logged;
};

const setPrivate = (interceptor: MemoryMonitorInterceptor, patch: Record<string, unknown>) => {
  Object.assign(interceptor as unknown as Record<string, unknown>, patch);
};

/** 在指定 RSS 序列下执行一次请求后检查 */
const runCheck = (
  interceptor: MemoryMonitorInterceptor,
  url: string,
  rss: number,
) => {
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss } as NodeJS.MemoryUsage);
  (interceptor as unknown as { checkAfterRequest(url: string): void }).checkAfterRequest(url);
};

describe('MemoryMonitorInterceptor', () => {
  beforeEach(() => {
    // 构造时的基线取真实 RSS，这里统一用打桩值覆盖，保证用例确定性
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: mb(100) } as NodeJS.MemoryUsage);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('请求成功与失败都会触发一次请求后检查', async () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    attachRecorder(interceptor);
    const spy = jest.spyOn(
      interceptor as unknown as { checkAfterRequest(url: string): void },
      'checkAfterRequest',
    );

    await lastValueFrom(interceptor.intercept(createContext({ url: '/api/user' }), createHandler(of(1))));

    expect(spy).toHaveBeenCalledWith('/api/user');
    expect(spy).toHaveBeenCalledTimes(1);

    await expect(
      lastValueFrom(
        interceptor.intercept(
          createContext({ url: '/api/user' }),
          createHandler(throwError(() => new Error('boom'))),
        ),
      ),
    ).rejects.toThrow('boom');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('请求对象缺失时路径记为 unknown', async () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    attachRecorder(interceptor);
    const spy = jest.spyOn(
      interceptor as unknown as { checkAfterRequest(url: string): void },
      'checkAfterRequest',
    );

    await lastValueFrom(interceptor.intercept(createContext(undefined), createHandler(of(1))));

    expect(spy).toHaveBeenCalledWith('unknown');
  });

  it('监控未启用时直接跳过，不读取内存', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(false));
    attachRecorder(interceptor);
    jest.restoreAllMocks();
    const usage = jest.spyOn(process, 'memoryUsage');

    (interceptor as unknown as { checkAfterRequest(url: string): void }).checkAfterRequest('/api/x');

    expect(usage).not.toHaveBeenCalled();
  });

  it('健康检查/监控端点自调用被跳过', () => {
    const monitor = createMonitor(true);
    const interceptor = new MemoryMonitorInterceptor(monitor);
    attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(100) });

    runCheck(interceptor, '/api/core/monitor/memory', mb(500));

    expect(monitor.checkMemory).not.toHaveBeenCalled();
  });

  it('单次增长未超阈值时不计数', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(100) });

    runCheck(interceptor, '/api/user', mb(101));

    expect((interceptor as unknown as { growthCount: number }).growthCount).toBe(0);
  });

  it('连续增长达到阈值次数时打印告警', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    const logged = attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(100), growthCount: 19 });

    runCheck(interceptor, '/api/user', mb(200));

    expect((interceptor as unknown as { growthCount: number }).growthCount).toBe(20);
    expect(logged.warn.join()).toContain('内存连续增长 20 次');
  });

  it('持续增长超过阈值 + 5 时触发完整内存检查', () => {
    const monitor = createMonitor(true);
    const interceptor = new MemoryMonitorInterceptor(monitor);
    attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(100), growthCount: 25 });

    runCheck(interceptor, '/api/user', mb(200));

    expect(monitor.checkMemory).toHaveBeenCalledTimes(1);
  });

  it('内存回落到阈值以下时重置计数并记录缓解日志', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    const logged = attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(500), growthCount: 7 });

    runCheck(interceptor, '/api/user', mb(100));

    expect((interceptor as unknown as { growthCount: number }).growthCount).toBe(0);
    expect(logged.log.join()).toContain('内存增长趋势已缓解');
    // 计数归零后基线同步更新
    expect((interceptor as unknown as { baseline: number }).baseline).toBe(mb(100));
  });

  it('未增长过（计数为 0）时静默更新基线，不打印缓解日志', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    const logged = attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(500), growthCount: 0 });

    runCheck(interceptor, '/api/user', mb(300));

    expect(logged.log).toHaveLength(0);
    expect((interceptor as unknown as { baseline: number }).baseline).toBe(mb(300));
  });

  it('波动在阈值以内（既不增长也不回落）时保持计数不变', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    attachRecorder(interceptor);
    setPrivate(interceptor, { baseline: mb(100), growthCount: 3 });

    runCheck(interceptor, '/api/user', mb(102));

    expect((interceptor as unknown as { growthCount: number }).growthCount).toBe(3);
  });

  it('读取内存抛错时静默处理，不影响请求', () => {
    const interceptor = new MemoryMonitorInterceptor(createMonitor(true));
    attachRecorder(interceptor);
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('memoryUsage failed');
    });

    expect(() =>
      (interceptor as unknown as { checkAfterRequest(url: string): void }).checkAfterRequest('/api/x'),
    ).not.toThrow();
  });
});
