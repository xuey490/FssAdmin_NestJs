import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { QueryLogsDto } from './dto/query-logs.dto';
import type { LogRecord } from './interfaces/log-record.interface';
import { LogQueryService } from './log-query.service';

/** node 内置模块经 TS 编译后是 __importStar 副本，需对真实模块打桩 */
const realFsp = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');

const createConfig = (dir: string) =>
  ({
    get: (key: string, fallback?: unknown) => (key === 'log.dir' ? dir : fallback),
  }) as unknown as ConfigService;

const dto = (values: Record<string, unknown>) => values as unknown as QueryLogsDto;

const pad = (n: number) => String(n).padStart(2, '0');

const record = (overrides: Partial<Record<string, unknown>> = {}): LogRecord =>
  ({
    timestamp: '2026-09-25T02:00:00.000Z',
    level: 'info',
    category: 'system',
    service: 'nextjs-server',
    env: 'production',
    message: 'hello world',
    ...overrides,
  }) as unknown as LogRecord;

describe('LogQueryService', () => {
  let logDir: string;
  const baseTime = '2026-09-25T02:00:00.000Z';

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-query-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** 在对应小时目录下写入日志文件（文件名需与本地小时一致） */
  const writeLogFile = (timestamp: string, lines: string[], fileName?: string) => {
    const date = new Date(timestamp);
    const dir = path.join(
      logDir,
      String(date.getFullYear()),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    );
    fs.mkdirSync(dir, { recursive: true });

    const name = fileName ?? `${pad(date.getHours())}.jsonl`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(''));

    return file;
  };

  const writeRecords = (items: LogRecord[], fileName?: string) =>
    writeLogFile(baseTime, items.map((item) => JSON.stringify(item)), fileName);

  describe('查询边界校验', () => {
    it('startAt/endAt 非法时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));

      await expect(
        service.query(dto({ startAt: 'not-a-date', endAt: '2026-09-25T03:00:00.000Z' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('startAt 不小于 endAt 时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));

      await expect(
        service.query(dto({ startAt: '2026-09-25T03:00:00.000Z', endAt: '2026-09-25T02:00:00.000Z' })),
      ).rejects.toThrow('startAt 必须小于 endAt');
    });

    it('查询范围超过 24 小时时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));

      await expect(
        service.query(dto({ startAt: '2026-09-20T00:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' })),
      ).rejects.toThrow('最大查询时间范围不能超过 24 小时');
    });

    it('游标格式非法时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));

      await expect(
        service.query(
          dto({
            startAt: '2026-09-25T01:00:00.000Z',
            endAt: '2026-09-25T03:00:00.000Z',
            cursor: 'not-a-cursor',
          }),
        ),
      ).rejects.toThrow('cursor 无效');
    });

    it('游标缺少必填字段时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));
      const badCursor = Buffer.from(JSON.stringify({ file: 'a' }), 'utf8').toString('base64url');

      await expect(
        service.query(
          dto({
            startAt: '2026-09-25T01:00:00.000Z',
            endAt: '2026-09-25T03:00:00.000Z',
            cursor: badCursor,
          }),
        ),
      ).rejects.toThrow('cursor 无效');
    });

    it('游标 order 与查询 order 不一致时报错', async () => {
      const service = new LogQueryService(createConfig(logDir));
      const cursor = Buffer.from(
        JSON.stringify({ file: '2026/09/25/10.jsonl', line: 1, order: 'asc' }),
        'utf8',
      ).toString('base64url');

      await expect(
        service.query(
          dto({
            startAt: '2026-09-25T01:00:00.000Z',
            endAt: '2026-09-25T03:00:00.000Z',
            order: 'desc',
            cursor,
          }),
        ),
      ).rejects.toThrow('cursor 与 order 不匹配');
    });
  });

  describe('基础查询', () => {
    it('日志目录不存在时返回空结果', async () => {
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );

      expect(result.items).toEqual([]);
      expect(result.summary.scannedFiles).toBe(0);
      expect(result.summary.scannedLines).toBe(0);
      expect(result.summary.truncated).toBe(false);
      expect(result.page).toEqual({ limit: 100, nextCursor: undefined, hasMore: false });
    });

    it('默认倒序：最新的记录在前', async () => {
      writeRecords([
        record({ message: 'first', timestamp: '2026-09-25T02:00:00.000Z' }),
        record({ message: 'second', timestamp: '2026-09-25T02:10:00.000Z' }),
        record({ message: 'third', timestamp: '2026-09-25T02:20:00.000Z' }),
      ]);
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );

      expect(result.items.map((item) => item.message)).toEqual(['third', 'second', 'first']);
      expect(result.summary.scannedFiles).toBe(1);
      expect(result.summary.scannedLines).toBe(3);
    });

    it('正序时按写入顺序返回', async () => {
      writeRecords([
        record({ message: 'first' }),
        record({ message: 'second' }),
        record({ message: 'third' }),
      ]);
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z', order: 'asc' }),
      );

      expect(result.items.map((item) => item.message)).toEqual(['first', 'second', 'third']);
    });

    it('忽略空行并统计解析错误', async () => {
      writeLogFile(baseTime, ['', JSON.stringify(record({ message: 'ok' })), '{ broken json']);
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );

      expect(result.items).toHaveLength(1);
      expect(result.summary.parseErrors).toBe(1);
    });

    it('时间范围外的记录被过滤', async () => {
      writeRecords([
        record({ message: 'in-range', timestamp: '2026-09-25T02:00:00.000Z' }),
        record({ message: 'out-range', timestamp: '2026-09-25T05:00:00.000Z' }),
        record({ message: 'bad-time', timestamp: 'not-a-time' }),
      ]);
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );

      expect(result.items.map((item) => item.message)).toEqual(['in-range']);
    });
  });

  describe('过滤条件', () => {
    const expectFiltered = async (
      query: Record<string, unknown>,
      expected: string[],
      records = [
        record({ message: 'match' }),
        record({ message: 'other', level: 'error' }),
      ],
    ) => {
      writeRecords(records);
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z', ...query }),
      );

      expect(result.items.map((item) => item.message)).toEqual(expected);
    };

    it.each([
      ['level', { level: 'info' }],
      ['requestId', { requestId: 'req-1' }],
      ['traceId', { traceId: 'trace-1' }],
      ['source', { source: 'http' }],
      ['message', { message: 'match' }],
    ])('按 %s 过滤', async (_name, query) => {
      const records = [
        record({ message: 'match', requestId: 'req-1', traceId: 'trace-1', source: 'http' }),
        record({ message: 'other', level: 'error', requestId: 'req-2', traceId: 'trace-2', source: 'ws' }),
      ];

      await expectFiltered(query, ['match'], records);
    });

    it('按 category / service / env 过滤', async () => {
      const records = [
        record({ message: 'match' }),
        record({ message: 'other', category: 'biz', service: 'worker', env: 'test' }),
      ];

      await expectFiltered({ category: 'system' }, ['match'], records);
      await expectFiltered({ service: 'nextjs-server' }, ['match'], records);
      await expectFiltered({ env: 'production' }, ['match'], records);
    });

    it('按 meta.method / path / statusCode 过滤', async () => {
      const records = [
        record({ message: 'match', meta: { method: 'GET', path: '/api/user/list', statusCode: 200 } }),
        record({ message: 'other', meta: { method: 'POST', path: '/api/user/create', statusCode: 500 } }),
      ];

      await expectFiltered({ method: 'GET' }, ['match'], records);
      // 默认倒序：写入顺序靠后的记录先返回
      await expectFiltered({ path: '/api/user' }, ['other', 'match'], records);
      await expectFiltered({ statusCode: 200 }, ['match'], records);
    });
  });

  describe('游标分页', () => {
    it('达到 limit 时返回游标与 hasMore，下一页跳过已读记录', async () => {
      writeRecords([
        record({ message: 'first' }),
        record({ message: 'second' }),
        record({ message: 'third' }),
      ]);
      const service = new LogQueryService(createConfig(logDir));
      const range = { startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' };

      const first = await service.query(dto({ ...range, limit: 2 }));

      expect(first.items.map((item) => item.message)).toEqual(['third', 'second']);
      expect(first.page.hasMore).toBe(true);
      expect(first.page.nextCursor).toBeDefined();

      const second = await service.query(dto({ ...range, limit: 2, cursor: first.page.nextCursor }));

      expect(second.items.map((item) => item.message)).toEqual(['first']);
    });

    it('正序分页时游标同样生效', async () => {
      writeRecords([
        record({ message: 'first' }),
        record({ message: 'second' }),
        record({ message: 'third' }),
      ]);
      const service = new LogQueryService(createConfig(logDir));
      const range = { startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z', order: 'asc' };

      const first = await service.query(dto({ ...range, limit: 2 }));

      expect(first.items.map((item) => item.message)).toEqual(['first', 'second']);

      const second = await service.query(dto({ ...range, limit: 2, cursor: first.page.nextCursor }));

      expect(second.items.map((item) => item.message)).toEqual(['third']);
    });
  });

  describe('候选文件识别', () => {
    it('忽略非法文件名与不匹配的小时', async () => {
      writeRecords([record({ message: 'good' })]);
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'wrong-hour' }))], '05.jsonl');
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'bad-name' }))], 'foo.txt');
      const service = new LogQueryService(createConfig(logDir));

      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );

      expect(result.items.map((item) => item.message)).toEqual(['good']);
      expect(result.summary.scannedFiles).toBe(1);
    });

    it('支持 .json 扩展名与分片编号排序', async () => {
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'part1' }))]);
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'part2' }))], `${pad(new Date(baseTime).getHours())}-02.jsonl`);
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'json-ext' }))], `${pad(new Date(baseTime).getHours())}.json`);
      const service = new LogQueryService(createConfig(logDir));

      const desc = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' }),
      );
      const asc = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z', order: 'asc' }),
      );

      expect(desc.items.map((item) => item.message).sort()).toEqual(['json-ext', 'part1', 'part2']);
      expect(asc.items.map((item) => item.message).sort()).toEqual(['json-ext', 'part1', 'part2']);
      // 分片编号更大的文件排在最前（倒序）/ 最后（正序）
      expect(desc.items[0]?.message).toBe('part2');
      expect(asc.items[asc.items.length - 1]?.message).toBe('part2');
    });

    it('候选文件超过上限时标记截断', async () => {
      const hour = pad(new Date(baseTime).getHours());
      for (let part = 2; part <= 101; part += 1) {
        writeLogFile(
          baseTime,
          [JSON.stringify(record({ message: `p${part}` }))],
          `${hour}-${String(part).padStart(2, '0')}.jsonl`,
        );
      }
      writeLogFile(baseTime, [JSON.stringify(record({ message: 'base' }))]);
      const service = new LogQueryService(createConfig(logDir));

      // limit 放大，避免先触发分页游标中断而掩盖文件数上限
      const result = await service.query(
        dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z', limit: 1000 }),
      );

      expect(result.summary.scannedFiles).toBe(100);
      expect(result.summary.truncated).toBe(true);
    });

    it('目录读取抛出非 ENOENT 错误时向外抛出', async () => {
      writeRecords([record()]);
      const service = new LogQueryService(createConfig(logDir));
      jest
        .spyOn(realFsp, 'readdir')
        .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      await expect(
        service.query(dto({ startAt: '2026-09-25T01:00:00.000Z', endAt: '2026-09-25T03:00:00.000Z' })),
      ).rejects.toThrow('EACCES');
    });
  });
});
