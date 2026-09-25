import { ServiceUnavailableException } from '@nestjs/common';

import { LlmSemaphoreService } from './llm-semaphore.service';

/** 替换私有 logger，避免启动日志污染测试输出 */
const attachRecorder = (service: LlmSemaphoreService) => {
  const logged: string[] = [];

  (service as unknown as { logger: unknown }).logger = {
    log: (message: string) => logged.push(message),
    debug: (message: string) => logged.push(message),
    warn: () => undefined,
    error: () => undefined,
    verbose: () => undefined,
  };

  return logged;
};

describe('LlmSemaphoreService', () => {
  const originalEnv = process.env.AI_MAX_CONCURRENT_STREAMS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_MAX_CONCURRENT_STREAMS;
    } else {
      process.env.AI_MAX_CONCURRENT_STREAMS = originalEnv;
    }
  });

  describe('并发上限推导', () => {
    it.each([
      ['未配置', undefined, 10],
      ['配置为 3', '3', 3],
      ['配置为 1', '1', 1],
      ['配置为 0（无效值回落默认 10）', '0', 10],
      ['配置为非数字（回落默认 10）', 'abc', 10],
      ['配置为负数（兜底为 1）', '-5', 1],
    ])('%s 时上限为 %i', (_name, value, expected) => {
      if (value === undefined) {
        delete process.env.AI_MAX_CONCURRENT_STREAMS;
      } else {
        process.env.AI_MAX_CONCURRENT_STREAMS = value;
      }

      const service = new LlmSemaphoreService();

      expect(service.maxConcurrent).toBe(expected);
      expect(service.activeCount).toBe(0);
    });
  });

  describe('槽位占用与释放', () => {
    it('acquire 递增活跃数，release 递减', () => {
      process.env.AI_MAX_CONCURRENT_STREAMS = '2';
      const service = new LlmSemaphoreService();
      attachRecorder(service);

      service.acquire();

      expect(service.activeCount).toBe(1);

      service.release();

      expect(service.activeCount).toBe(0);
    });

    it('达到上限后再次 acquire 抛出 503', () => {
      process.env.AI_MAX_CONCURRENT_STREAMS = '2';
      const service = new LlmSemaphoreService();
      attachRecorder(service);

      service.acquire();
      service.acquire();

      expect(service.activeCount).toBe(2);

      try {
        service.acquire();
        throw new Error('应当抛出 ServiceUnavailableException');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as ServiceUnavailableException).message).toContain('上限 2');
      }

      // 拒绝后活跃数不变
      expect(service.activeCount).toBe(2);
    });

    it('release 在活跃数为 0 时不会出现负数', () => {
      process.env.AI_MAX_CONCURRENT_STREAMS = '2';
      const service = new LlmSemaphoreService();
      attachRecorder(service);

      service.release();
      service.release();

      expect(service.activeCount).toBe(0);
    });

    it('释放后可再次占用', () => {
      process.env.AI_MAX_CONCURRENT_STREAMS = '1';
      const service = new LlmSemaphoreService();
      attachRecorder(service);

      service.acquire();

      expect(() => service.acquire()).toThrow(ServiceUnavailableException);

      service.release();

      expect(() => service.acquire()).not.toThrow();
      expect(service.activeCount).toBe(1);
    });
  });
});
