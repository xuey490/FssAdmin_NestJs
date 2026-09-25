import { ConfigService } from '@nestjs/config';

import { AppLoggerService } from './app-logger.service';
import type { LogRecord } from './interfaces/log-record.interface';
import { ConsoleLogSink } from './sinks/console-log.sink';
import { FileLogSink } from './sinks/file-log.sink';
import { WinstonLogSink } from './sinks/winston-log.sink';

const createConfig = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback) }) as unknown as ConfigService;

interface MockSink {
  write: jest.Mock;
}

const createSink = (impl?: (record: LogRecord) => Promise<void> | void): MockSink => ({
  write: jest.fn(impl ?? (() => Promise.resolve())),
});

const createLogger = (config: Record<string, unknown> = {}) => {
  const consoleSink = createSink();
  const fileSink = createSink();
  const winstonSink = createSink();
  const logger = new AppLoggerService(
    createConfig(config),
    consoleSink as unknown as ConsoleLogSink,
    fileSink as unknown as FileLogSink,
    winstonSink as unknown as WinstonLogSink,
  );

  return { logger, consoleSink, fileSink, winstonSink };
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('AppLoggerService', () => {
  describe('日志分发', () => {
    it('默认写入控制台、文件与 winston 三个通道，并带上服务与环境信息', async () => {
      const { logger, consoleSink, fileSink, winstonSink } = createLogger({
        'app.name': 'nextjs-server',
        'app.env': 'production',
      });

      logger.info({ category: 'system.test', message: 'hello', source: 'spec' });
      await flushMicrotasks();

      for (const sink of [consoleSink, fileSink, winstonSink]) {
        expect(sink.write).toHaveBeenCalledTimes(1);
      }

      const record = fileSink.write.mock.calls[0][0] as LogRecord;

      expect(record.level).toBe('info');
      expect(record.message).toBe('hello');
      expect(record.category).toBe('system.test');
      expect(record.service).toBe('nextjs-server');
      expect(record.env).toBe('production');
      expect(Number.isNaN(new Date(record.timestamp).getTime())).toBe(false);
    });

    it('按配置关闭控制台与文件通道时只写 winston', async () => {
      const { logger, consoleSink, fileSink, winstonSink } = createLogger({
        'log.consoleEnabled': false,
        'log.fileEnabled': false,
      });

      logger.warn({ category: 'system.test', message: 'warn only' });
      await flushMicrotasks();

      expect(consoleSink.write).not.toHaveBeenCalled();
      expect(fileSink.write).not.toHaveBeenCalled();
      expect(winstonSink.write).toHaveBeenCalledTimes(1);
    });

    it('低于最低级别时不写入任何通道', async () => {
      const { logger, consoleSink, fileSink, winstonSink } = createLogger({
        'log.effectiveLevel': 'warn',
      });

      logger.info({ category: 'system.test', message: '被过滤' });
      logger.debug({ category: 'system.test', message: '被过滤' });
      await flushMicrotasks();

      expect(consoleSink.write).not.toHaveBeenCalled();
      expect(fileSink.write).not.toHaveBeenCalled();
      expect(winstonSink.write).not.toHaveBeenCalled();

      logger.error({ category: 'system.test', message: '应当写入' });
      await flushMicrotasks();

      expect(fileSink.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush（退出前落盘）', () => {
    it('等待尚未完成的写入', async () => {
      let release: () => void = () => undefined;
      const fileSink = createSink(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const logger = new AppLoggerService(
        createConfig({ 'log.consoleEnabled': false }),
        createSink() as unknown as ConsoleLogSink,
        fileSink as unknown as FileLogSink,
        createSink() as unknown as WinstonLogSink,
      );

      logger.fatal({ category: 'system.lifecycle', message: '服务启动失败' });

      let flushed = false;
      const pending = logger.flush().then(() => {
        flushed = true;
      });

      await flushMicrotasks();

      expect(flushed).toBe(false);
      expect(fileSink.write).toHaveBeenCalledTimes(1);

      release();
      await pending;

      expect(flushed).toBe(true);
    });

    it('sink 写入失败时不影响其他通道，且 flush 不抛错', async () => {
      const failingSink = createSink(() => Promise.reject(new Error('disk full')));
      const winstonSink = createSink();
      const logger = new AppLoggerService(
        createConfig({ 'log.consoleEnabled': false }),
        createSink() as unknown as ConsoleLogSink,
        failingSink as unknown as FileLogSink,
        winstonSink as unknown as WinstonLogSink,
      );

      logger.error({ category: 'system.test', message: 'boom' });

      await expect(logger.flush()).resolves.toBeUndefined();
      expect(winstonSink.write).toHaveBeenCalledTimes(1);
    });

    it('未产生任何写入时 flush 立即完成', async () => {
      const { logger } = createLogger();

      await expect(logger.flush()).resolves.toBeUndefined();
    });
  });
});
