import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LogRecord } from '../interfaces/log-record.interface';
import { FileLogSink } from './file-log.sink';

/** node 内置模块经 TS 编译后是 __importStar 副本，需对真实模块打桩 */
const realFsp = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');

const createConfig = (values: Record<string, unknown> = {}) =>
  ({
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  }) as unknown as ConfigService;

const createRecord = (timestamp: string, message = '测试日志'): LogRecord =>
  ({ timestamp, level: 'info', message, category: 'system', service: 'nextjs-server' }) as unknown as LogRecord;

/** 等待 scheduleCleanup 触发的后台清理任务完成（后台任务含多级目录遍历，需让出若干轮事件循环） */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const pad = (n: number) => String(n).padStart(2, '0');

describe('FileLogSink', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-log-sink-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const privateOf = (sink: FileLogSink) => sink as unknown as Record<string, number | string>;

  const hourlyFile = (timestamp: string, part?: number) => {
    const date = new Date(timestamp);

    return path.join(
      logDir,
      String(date.getFullYear()),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      `${pad(date.getHours())}${part ? `-${String(part).padStart(2, '0')}` : ''}.jsonl`,
    );
  };

  describe('初始化', () => {
    it('未配置时使用默认目录、20MB 分片上限与 30 天保留期', () => {
      const sink = new FileLogSink(createConfig({}));

      expect(privateOf(sink).logDir).toBe('logs');
      expect(privateOf(sink).maxFileSizeBytes).toBe(20 * 1024 * 1024);
      expect(privateOf(sink).retentionDays).toBe(30);
    });

    it('按配置覆盖默认值', () => {
      const sink = new FileLogSink(
        createConfig({ 'log.dir': logDir, 'log.maxFileSizeMb': 5, 'log.retentionDays': 7 }),
      );

      expect(privateOf(sink).logDir).toBe(logDir);
      expect(privateOf(sink).maxFileSizeBytes).toBe(5 * 1024 * 1024);
      expect(privateOf(sink).retentionDays).toBe(7);
    });
  });

  describe('写入与分片', () => {
    it('按 年/月/日/小时 结构写入 JSONL', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir }));
      const timestamp = '2026-09-25T14:30:00.000Z';

      await sink.write(createRecord(timestamp));
      await flush();

      const file = hourlyFile(timestamp);

      expect(fs.existsSync(file)).toBe(true);

      const line = fs.readFileSync(file, 'utf8').trimEnd();

      expect(JSON.parse(line)).toMatchObject({ message: '测试日志', level: 'info' });
    });

    it('超过大小上限时新建分片文件', async () => {
      // 上限约 105 字节：单条日志（约 150 字节）写满后必须换分片
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.maxFileSizeMb': 0.0001 }));
      const timestamp = '2026-09-25T14:30:00.000Z';

      await sink.write(createRecord(timestamp, 'first'));
      await sink.write(createRecord(timestamp, 'second'));
      await sink.write(createRecord(timestamp, 'third'));
      await flush();

      expect(fs.existsSync(hourlyFile(timestamp))).toBe(true);
      expect(fs.existsSync(hourlyFile(timestamp, 2))).toBe(true);
      expect(fs.existsSync(hourlyFile(timestamp, 3))).toBe(true);
    });

    it('所有分片都写满时回落到第 999 个分片', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.maxFileSizeMb': 0.0005 }));
      // 让 stat 始终返回超大体积，强制分片循环走完
      jest.spyOn(realFsp, 'stat').mockResolvedValue({ size: 10 * 1024 * 1024 } as never);

      await sink.write(createRecord('2026-09-25T14:30:00.000Z'));
      await flush();

      expect(fs.existsSync(hourlyFile('2026-09-25T14:30:00.000Z', 999))).toBe(true);
    });

    it('大小上限为 0 时不做分片', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.maxFileSizeMb': 0 }));
      const timestamp = '2026-09-25T14:30:00.000Z';

      await sink.write(createRecord(timestamp, 'a'));
      await sink.write(createRecord(timestamp, 'b'));
      await flush();

      expect(fs.existsSync(hourlyFile(timestamp, 2))).toBe(false);
      expect(fs.readFileSync(hourlyFile(timestamp), 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('stat 抛出非 ENOENT 错误时向外抛出', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir }));
      jest.spyOn(realFsp, 'stat').mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );

      await expect(sink.write(createRecord('2026-09-25T14:30:00.000Z'))).rejects.toThrow('EACCES');
    });
  });

  describe('过期日志清理', () => {
    const createDayFile = (year: string, month: string, day: string) => {
      const file = path.join(logDir, year, month, day, '00.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');

      return path.join(logDir, year, month, day);
    };

    it('保留天数为 0 时跳过清理', async () => {
      const rm = jest.spyOn(realFsp, 'rm');
      const expired = createDayFile('2020', '01', '05');
      const sink = new FileLogSink(
        createConfig({ 'log.dir': logDir, 'log.retentionDays': 0 }),
      );

      await sink.write(createRecord('2026-09-25T14:30:00.000Z'));
      await flush();

      expect(rm).not.toHaveBeenCalled();
      expect(fs.existsSync(expired)).toBe(true);
    });

    it('删除超过保留期的日期目录，保留未过期的', async () => {
      const expired = createDayFile('2020', '01', '05');
      const date = new Date();
      const recent = createDayFile(
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
      );
      const sink = new FileLogSink(
        createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }),
      );

      await sink.write(createRecord(new Date().toISOString()));
      await flush();

      expect(fs.existsSync(expired)).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
    });

    it('日志目录不存在（ENOENT）时静默跳过', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }));
      // 模拟日志根目录被移除：readdir 抛 ENOENT 应被静默忽略
      jest
        .spyOn(realFsp, 'readdir')
        .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(sink.write(createRecord('2026-09-25T14:30:00.000Z'))).resolves.toBeUndefined();
      await flush();
    });

    it('遍历时跳过非目录条目', async () => {
      const rm = jest.spyOn(realFsp, 'rm');
      fs.writeFileSync(path.join(logDir, '2020.txt'), '');
      fs.mkdirSync(path.join(logDir, '2020'), { recursive: true });
      fs.writeFileSync(path.join(logDir, '2020', '01.txt'), '');
      fs.mkdirSync(path.join(logDir, '2020', '01'), { recursive: true });
      fs.writeFileSync(path.join(logDir, '2020', '01', '05.txt'), '');
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }));

      await sink.write(createRecord('2026-09-25T14:30:00.000Z'));
      await flush();

      expect(rm).not.toHaveBeenCalled();
    });

    it('目录名不是合法数字时跳过（避免误删）', async () => {
      const rm = jest.spyOn(realFsp, 'rm');
      const weird = createDayFile('abc', 'def', 'ghi');
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }));

      await sink.write(createRecord('2026-09-25T14:30:00.000Z'));
      await flush();

      expect(rm).not.toHaveBeenCalled();
      expect(fs.existsSync(weird)).toBe(true);
    });

    it('同一天内只清理一次，跨天会再次清理', async () => {
      const rm = jest.spyOn(realFsp, 'rm').mockResolvedValue(undefined);
      createDayFile('2020', '01', '05');
      createDayFile('2020', '01', '06');
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }));

      await sink.write(createRecord('2026-09-25T01:00:00.000Z'));
      await flush();

      const afterFirst = rm.mock.calls.length;

      await sink.write(createRecord('2026-09-25T02:00:00.000Z'));
      await flush();

      expect(rm.mock.calls.length).toBe(afterFirst);

      await sink.write(createRecord('2026-09-26T02:00:00.000Z'));
      await flush();

      expect(rm.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('扫描目录抛出非 ENOENT 错误时被后台任务吞掉，不影响写入', async () => {
      const sink = new FileLogSink(createConfig({ 'log.dir': logDir, 'log.retentionDays': 30 }));
      jest
        .spyOn(realFsp, 'readdir')
        .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      await expect(sink.write(createRecord('2026-09-25T14:30:00.000Z'))).resolves.toBeUndefined();
      await flush();
    });
  });
});
