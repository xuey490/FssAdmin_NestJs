import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as v8Types from 'node:v8';

import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { MemoryMonitorService } from './memory-monitor.service';

const mb = (n: number) => n * 1024 * 1024;

/**
 * node 内置模块（`node:fs` / `node:v8`）经 TS 编译后是 `__importStar` 副本，
 * 其属性不可被 spyOn 重定义，因此统一用 jest.requireActual 拿到真实模块再打桩。
 */
const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const realV8 = jest.requireActual<typeof import('node:v8')>('node:v8');

/** 构造配置服务：未显式给定的键回落到默认值，便于覆盖 `??` 兜底分支 */
const createConfig = (values: Record<string, unknown> = {}) =>
  ({
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  }) as unknown as ConfigService;

const createModuleRef = (app: unknown) => ({ get: () => app }) as unknown as ModuleRef;

interface Logged {
  log: string[];
  warn: string[];
  error: string[];
  verbose: string[];
}

/** 用记录型 logger 替换私有 logger：既能断言告警原因，又避免污染测试输出 */
const attachRecorder = (service: MemoryMonitorService): Logged => {
  const logged: Logged = { log: [], warn: [], error: [], verbose: [] };

  (service as unknown as { logger: unknown }).logger = {
    log: (message: string) => logged.log.push(message),
    warn: (message: string) => logged.warn.push(message),
    error: (message: string) => logged.error.push(message),
    verbose: (message: string) => logged.verbose.push(message),
  };

  return logged;
};

const build = (configValues: Record<string, unknown> = {}, app?: unknown) => {
  const service = new MemoryMonitorService(createModuleRef(app), createConfig(configValues));

  return { service, logged: attachRecorder(service) };
};

/** 固定 process.memoryUsage 返回值，精确命中各阈值分支 */
const mockMemory = (usage: Partial<NodeJS.MemoryUsage>) =>
  jest.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
    ...usage,
  } as NodeJS.MemoryUsage);

const heapInfo = () =>
  ({
    total_heap_size: mb(200),
    used_heap_size: mb(50),
    heap_size_limit: mb(4000),
  }) as unknown as v8Types.HeapInfo;

/**
 * 打桩 writeHeapSnapshot：真实实现会写出数十 MB 快照（单次 40s+），
 * 测试里仅返回路径，需要落盘时通过 writeFile=true 打开。
 */
const mockSnapshotWriter = (writeFile = false) =>
  jest.spyOn(realV8, 'writeHeapSnapshot').mockImplementation(((file?: string) => {
    const target = String(file);

    if (writeFile) {
      fs.writeFileSync(target, 'fake-snapshot');
    }

    return target;
  }) as typeof realV8.writeHeapSnapshot);

describe('MemoryMonitorService', () => {
  const originalCwd = process.cwd();
  let workspace: string;
  let dumpDir: string;

  beforeAll(() => {
    // 切到临时目录：dumpDir 基于 process.cwd()，避免测试污染仓库的 logs/heapdump
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-monitor-'));
    process.chdir(workspace);
    dumpDir = path.resolve(workspace, 'logs', 'heapdump');
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.spyOn(realV8, 'getHeapStatistics').mockImplementation(heapInfo);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();

    // 快照目录可能被用例删除，重建后再清空，保证用例之间互不干扰
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.readdirSync(dumpDir).forEach((name) => fs.rmSync(path.join(dumpDir, name), { force: true }));
  });

  const snapshotFiles = () =>
    fs.readdirSync(dumpDir).filter((name) => name.endsWith('.heapsnapshot'));

  const createSnapshot = (name: string, ageMs = 0) => {
    const file = path.join(dumpDir, name);
    fs.writeFileSync(file, 'fake-snapshot');

    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs);
      fs.utimesSync(file, past, past);
    }

    return file;
  };

  describe('构造与初始化', () => {
    it('创建快照目录，并在已存在时复用', () => {
      const { service } = build();

      expect(fs.existsSync(dumpDir)).toBe(true);
      expect(service.getDumpDir()).toBe(dumpDir);

      // 目录已存在的分支：再次构造不应报错
      expect(() => build()).not.toThrow();
    });

    it('从配置加载阈值与策略', () => {
      const { service, logged } = build({
        'memory.rssWarnMb': 100,
        'memory.rssFatalMb': 200,
        'memory.heapUsageWarn': 70,
        'memory.heapUsageFatal': 80,
        'memory.fatalExit': true,
        'memory.rssFatalEnabled': false,
        'memory.bunMonitorEnabled': false,
        'memory.heapUsageEnabled': false,
        'memory.dumpEnabled': true,
        'memory.dumpMaxFiles': 5,
        'memory.dumpRetentionDays': 2,
        'memory.dumpMinIntervalMs': 1000,
      });

      service.onModuleInit();

      expect((service as unknown as { thresholds: Record<string, number> }).thresholds).toEqual({
        rssWarn: mb(100),
        rssFatal: mb(200),
        heapUsageWarn: 70,
        heapUsageFatal: 80,
      });
      expect(logged.log.join()).toContain('堆判定=禁用');
    });

    it('配置缺失时使用运行时默认值（Node）', () => {
      const { service } = build();

      service.onModuleInit();

      expect((service as unknown as { thresholds: Record<string, number> }).thresholds).toEqual({
        rssWarn: mb(300),
        rssFatal: mb(450),
        heapUsageWarn: 85,
        heapUsageFatal: 95,
      });
      expect((service as unknown as { rssFatalEnabled: boolean }).rssFatalEnabled).toBe(true);
      expect((service as unknown as { heapUsageEnabled: boolean }).heapUsageEnabled).toBe(true);
      expect((service as unknown as { fatalExit: boolean }).fatalExit).toBe(false);
      expect((service as unknown as { dumpEnabled: boolean }).dumpEnabled).toBe(false);
    });

    it('Bun 运行时默认跳过检查并打印提示', () => {
      const { service, logged } = build();
      (service as unknown as { isBun: boolean }).isBun = true;

      service.onModuleInit();

      expect((service as unknown as { thresholds: Record<string, number> }).thresholds.rssWarn).toBe(
        mb(600),
      );
      expect((service as unknown as { rssFatalEnabled: boolean }).rssFatalEnabled).toBe(false);
      expect((service as unknown as { heapUsageEnabled: boolean }).heapUsageEnabled).toBe(false);
      expect(logged.log.join()).toContain('Bun 下已跳过');
      expect(service.isMonitorEnabled()).toBe(false);
    });

    it('Bun 显式开启监控后检查生效', () => {
      const { service, logged } = build({ 'memory.bunMonitorEnabled': true });
      (service as unknown as { isBun: boolean }).isBun = true;

      service.onModuleInit();

      expect(logged.log.join()).toContain('Bun 下已启用');
      expect(service.isMonitorEnabled()).toBe(true);
    });

    it('构造函数可从 process.versions 识别 Bun 运行时', () => {
      const versions = process.versions as { bun?: string };
      versions.bun = '1.3.14';

      try {
        const { service } = build();

        expect((service as unknown as { isBun: boolean }).isBun).toBe(true);
        expect(service.isMonitorEnabled()).toBe(false);
      } finally {
        delete versions.bun;
      }
    });

    it('启动自检会立即回收超限的历史快照', () => {
      createSnapshot('heap-old-1.heapsnapshot');
      createSnapshot('heap-old-2.heapsnapshot');
      createSnapshot('heap-old-3.heapsnapshot');
      const { service } = build({ 'memory.dumpMaxFiles': 1 });

      service.onModuleInit();

      expect(snapshotFiles()).toHaveLength(1);
    });
  });

  describe('内存快照与报告', () => {
    it('返回完整字段', () => {
      const { service } = build();
      service.onModuleInit();
      mockMemory({
        rss: mb(100),
        heapTotal: mb(200),
        heapUsed: mb(50),
        external: 1024,
        arrayBuffers: 2048,
      });

      const info = service.getMemoryInfo();

      expect(info.rss).toBe(mb(100));
      expect(info.heapUsed).toBe(mb(50));
      expect(info.heapUsagePercent).toBe(25);
      expect(info.rssPercent).toBeCloseTo((100 / 450) * 100, 1);
      expect(info.arrayBuffers).toBe(2048);
      expect(info.heapAvailable).toBe(mb(4000) - mb(50));
      expect(info.heapLive).toBe(mb(50));
    });

    it('堆总量或 RSS 阈值为 0 时百分比降级为 0（避免除零）', () => {
      const { service } = build();
      service.onModuleInit();
      service.setThresholds({ rssFatal: 0 });
      mockMemory({ rss: mb(100), heapTotal: 0, heapUsed: 0 });

      const info = service.getMemoryInfo();

      expect(info.heapUsagePercent).toBe(0);
      expect(info.rssPercent).toBe(0);
    });

    it('v8.getHeapStatistics 抛错时降级而不中断', () => {
      const { service } = build();
      jest.spyOn(realV8, 'getHeapStatistics').mockImplementation(() => {
        throw new Error('not supported');
      });
      mockMemory({ rss: mb(10), heapTotal: mb(20), heapUsed: mb(5) });

      expect(() => service.getMemoryInfo()).not.toThrow();
      expect(Number.isNaN(service.getMemoryInfo().heapAvailable)).toBe(true);
      expect(service.getMemoryInfo().heapLive).toBeUndefined();
    });

    it('arrayBuffers 缺失时补 0', () => {
      const { service } = build();
      mockMemory({ rss: 1024, heapTotal: 2048, heapUsed: 512, external: 0, arrayBuffers: undefined });

      expect(service.getMemoryInfo().arrayBuffers).toBe(0);
    });

    it('报告按 GB / MB / KB 三种量级格式化', () => {
      const { service } = build();
      mockMemory({
        rss: 2 * 1024 * 1024 * 1024,
        heapTotal: mb(200),
        heapUsed: mb(100),
        external: 512,
      });

      const report = service.getMemoryReport();

      expect(report).toContain('GB');
      expect(report).toContain('MB');
      expect(report).toContain('KB');
    });
  });

  describe('阈值设置', () => {
    it('setThresholds 只覆盖传入字段', () => {
      const { service } = build();
      service.onModuleInit();
      const before = (service as unknown as { thresholds: Record<string, number> }).thresholds
        .heapUsageWarn;

      service.setThresholds({ rssWarn: mb(50) });

      const thresholds = (service as unknown as { thresholds: Record<string, number> }).thresholds;

      expect(thresholds.rssWarn).toBe(mb(50));
      expect(thresholds.heapUsageWarn).toBe(before);
    });
  });

  describe('checkMemory', () => {
    it('正在重启时直接返回 false', async () => {
      const { service, logged } = build();
      service.onModuleInit();
      (service as unknown as { restarting: boolean }).restarting = true;

      await expect(service.checkMemory()).resolves.toBe(false);
      expect(logged.verbose).toHaveLength(0);
    });

    it('运行时未启用检查时直接返回 true（Bun 默认）', async () => {
      const { service } = build();
      (service as unknown as { isBun: boolean }).isBun = true;
      service.onModuleInit();
      mockMemory({ rss: mb(9999) });

      await expect(service.checkMemory()).resolves.toBe(true);
    });

    it('内存正常时返回 true 并重置增长计数', async () => {
      const { service } = build();
      service.onModuleInit();
      (service as unknown as { growthCount: number }).growthCount = 3;
      (service as unknown as { lastHeapUsed: number }).lastHeapUsed = mb(1000);
      mockMemory({ rss: mb(10), heapTotal: mb(200), heapUsed: mb(5) });

      await expect(service.checkMemory()).resolves.toBe(true);
      expect((service as unknown as { growthCount: number }).growthCount).toBe(0);
    });

    it('堆连续增长达到阈值时打印告警', async () => {
      const { service, logged } = build();
      service.onModuleInit();
      (service as unknown as { growthCount: number }).growthCount = 4;
      (service as unknown as { lastHeapUsed: number }).lastHeapUsed = 1;
      mockMemory({ rss: mb(10), heapTotal: mb(200), heapUsed: mb(5) });

      await service.checkMemory();

      expect(logged.warn.join()).toContain('堆内存连续增长');
      expect((service as unknown as { growthCount: number }).growthCount).toBe(5);
    });

    it('超过警告阈值（RSS）时触发 warn 快照', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      const dumpHeap = jest.spyOn(service, 'dumpHeap').mockResolvedValue(null);
      // 350MB：介于默认警告 300MB 与致命 450MB 之间
      mockMemory({ rss: mb(350), heapTotal: mb(200), heapUsed: mb(5) });

      await expect(service.checkMemory()).resolves.toBe(true);

      expect(dumpHeap).toHaveBeenCalledWith('warn');
      expect(logged.warn.join()).toContain('超过警告阈值');
    });

    it('超过警告阈值（堆使用率）时触发 warn 快照', async () => {
      const { service } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      const dumpHeap = jest.spyOn(service, 'dumpHeap').mockResolvedValue(null);
      mockMemory({ rss: mb(1), heapTotal: mb(100), heapUsed: mb(90) });

      await service.checkMemory();

      expect(dumpHeap).toHaveBeenCalledWith('warn');
    });

    it('RSS 致命判定被关闭时不走致命分支', async () => {
      const { service } = build({ 'memory.rssFatalEnabled': false, 'memory.dumpEnabled': true });
      service.onModuleInit();
      const dumpHeap = jest.spyOn(service, 'dumpHeap').mockResolvedValue(null);
      mockMemory({ rss: mb(500), heapTotal: mb(200), heapUsed: mb(5) });

      await expect(service.checkMemory()).resolves.toBe(true);

      expect(dumpHeap).toHaveBeenCalledWith('warn');
    });

    it('超过致命阈值且 fatalExit=false 时只告警不退出', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      const dumpHeap = jest.spyOn(service, 'dumpHeap').mockResolvedValue(null);
      mockMemory({ rss: mb(800), heapTotal: mb(200), heapUsed: mb(5) });

      await expect(service.checkMemory()).resolves.toBe(true);

      expect(dumpHeap).toHaveBeenCalledWith('fatal');
      expect(logged.warn.join()).toContain('MEMORY_FATAL_EXIT=false');
    });

    it('超过致命阈值且 fatalExit=true 时优雅退出并返回 false', async () => {
      const { service } = build({ 'memory.fatalExit': true, 'memory.dumpEnabled': true });
      service.onModuleInit();
      jest.spyOn(service, 'dumpHeap').mockResolvedValue(null);
      const shutdown = jest.spyOn(service, 'gracefulShutdown').mockResolvedValue();
      mockMemory({ rss: mb(800), heapTotal: mb(200), heapUsed: mb(5) });

      await expect(service.checkMemory()).resolves.toBe(false);

      expect(shutdown).toHaveBeenCalledWith('内存超限致命错误');
    });
  });

  describe('dumpHeap', () => {
    it('自动快照在开关关闭时跳过', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': false });
      service.onModuleInit();

      await expect(service.dumpHeap('warn')).resolves.toBeNull();
      expect(logged.verbose.join()).toContain('自动堆快照已关闭');
    });

    it('手动快照不受开关与节流限制', async () => {
      const { service } = build({ 'memory.dumpEnabled': false, 'memory.dumpMinIntervalMs': 60000 });
      service.onModuleInit();
      mockSnapshotWriter(true);

      const file = await service.dumpHeap('manual');

      expect(file).toContain('heap-manual-');
      expect(snapshotFiles()).toHaveLength(1);
    });

    it('自动快照开启时写入并记录时间', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      mockSnapshotWriter(true);

      const file = await service.dumpHeap('warn');

      expect(file).toContain('heap-warn-');
      expect(logged.log.join()).toContain('堆快照已保存');
      expect((service as unknown as { lastDumpAt: Map<string, number> }).lastDumpAt.get('warn')).toBeGreaterThan(0);
    });

    it('并发写入时被守卫跳过', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      (service as unknown as { dumping: boolean }).dumping = true;

      await expect(service.dumpHeap('warn')).resolves.toBeNull();
      expect(logged.warn.join()).toContain('正在生成中');
    });

    it('同一原因在节流窗口内被跳过', async () => {
      const { service, logged } = build({
        'memory.dumpEnabled': true,
        'memory.dumpMinIntervalMs': 60000,
      });
      service.onModuleInit();
      const write = mockSnapshotWriter();

      await service.dumpHeap('warn');
      const second = await service.dumpHeap('warn');

      expect(second).toBeNull();
      expect(write).toHaveBeenCalledTimes(1);
      expect(logged.warn.join()).toContain('节流中');
    });

    it('不同原因各按自己的节流窗口判定', async () => {
      const { service } = build({
        'memory.dumpEnabled': true,
        'memory.dumpMinIntervalMs': 60000,
      });
      service.onModuleInit();
      mockSnapshotWriter();

      await service.dumpHeap('warn');
      const fatal = await service.dumpHeap('fatal');

      expect(fatal).toContain('heap-fatal-');
    });

    it('节流间隔为 0 时不限制', async () => {
      const { service } = build({ 'memory.dumpEnabled': true, 'memory.dumpMinIntervalMs': 0 });
      service.onModuleInit();
      const write = mockSnapshotWriter();

      await service.dumpHeap('warn');
      await service.dumpHeap('warn');

      expect(write).toHaveBeenCalledTimes(2);
    });

    it('运行时不支持 writeHeapSnapshot 时静默返回', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      const original = realV8.writeHeapSnapshot;
      (realV8 as unknown as { writeHeapSnapshot?: unknown }).writeHeapSnapshot = undefined;

      try {
        await expect(service.dumpHeap('warn')).resolves.toBeNull();
        expect(logged.verbose.join()).toContain('当前运行时不可用');
      } finally {
        (realV8 as unknown as { writeHeapSnapshot?: unknown }).writeHeapSnapshot = original;
      }
    });

    it('写入失败时记录错误并复位并发标记', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      jest.spyOn(realV8, 'writeHeapSnapshot').mockImplementation(() => {
        throw new Error('disk full');
      });

      await expect(service.dumpHeap('warn')).resolves.toBeNull();

      expect(logged.error.join()).toContain('堆快照保存失败');
      expect((service as unknown as { dumping: boolean }).dumping).toBe(false);
    });
  });

  describe('cleanupHeapDumps（数量上限 / 过期清理）', () => {
    it('超过数量上限时只保留最新的 N 个（过期天数为 0 时仅按数量剪裁）', () => {
      const { service } = build({ 'memory.dumpMaxFiles': 2, 'memory.dumpRetentionDays': 0 });
      service.onModuleInit();
      createSnapshot('heap-a.heapsnapshot', 3000);
      createSnapshot('heap-b.heapsnapshot', 2000);
      createSnapshot('heap-c.heapsnapshot', 1000);

      (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service);

      const remaining = snapshotFiles();

      expect(remaining).toHaveLength(2);
      expect(remaining).toContain('heap-c.heapsnapshot');
      expect(remaining).toContain('heap-b.heapsnapshot');
    });

    it('过期快照会被删除', async () => {
      const { service } = build({ 'memory.dumpEnabled': true, 'memory.dumpRetentionDays': 1 });
      service.onModuleInit();
      createSnapshot('heap-expired.heapsnapshot', 3 * 24 * 60 * 60 * 1000);
      mockSnapshotWriter();

      await service.dumpHeap('manual');

      expect(snapshotFiles().some((name) => name.includes('expired'))).toBe(false);
    });

    it('数量与天数均为 0 时不清理', async () => {
      const { service } = build({
        'memory.dumpEnabled': true,
        'memory.dumpMaxFiles': 0,
        'memory.dumpRetentionDays': 0,
      });
      service.onModuleInit();
      createSnapshot('heap-keep.heapsnapshot', 30 * 24 * 60 * 60 * 1000);
      mockSnapshotWriter();

      await service.dumpHeap('manual');

      expect(snapshotFiles().some((name) => name.includes('keep'))).toBe(true);
    });

    it('快照目录不存在时静默跳过', async () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      fs.rmSync(dumpDir, { recursive: true, force: true });
      mockSnapshotWriter();

      await expect(service.dumpHeap('manual')).resolves.toBeTruthy();
      expect(logged.warn.join()).not.toContain('扫描堆快照目录失败');
    });

    it('扫描目录失败（非 ENOENT）时仅告警不抛出', () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true });
      service.onModuleInit();
      jest.spyOn(realFs, 'readdirSync').mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });

      expect(() =>
        (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service),
      ).not.toThrow();
      expect(logged.warn.join()).toContain('扫描堆快照目录失败');
    });

    it('单项 stat 失败时跳过该项，不影响其它快照', () => {
      const { service } = build({ 'memory.dumpEnabled': true, 'memory.dumpMaxFiles': 1 });
      service.onModuleInit();
      const badFile = createSnapshot('heap-bad.heapsnapshot');
      createSnapshot('heap-ok.heapsnapshot');

      const originalStat = realFs.statSync;
      jest.spyOn(realFs, 'statSync').mockImplementation(((target: unknown, options?: unknown) => {
        if (String(target) === badFile) {
          throw new Error('stat failed');
        }

        return (originalStat as (...args: unknown[]) => unknown)(target, options);
      }) as typeof realFs.statSync);

      (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service);

      expect(fs.existsSync(badFile)).toBe(true);
    });

    it('删除单项失败时仅告警，不中断清理', () => {
      const { service, logged } = build({ 'memory.dumpEnabled': true, 'memory.dumpMaxFiles': 1 });
      service.onModuleInit();
      createSnapshot('heap-a.heapsnapshot');
      createSnapshot('heap-b.heapsnapshot');

      jest.spyOn(realFs, 'unlinkSync').mockImplementation(() => {
        throw new Error('unlink failed');
      });

      (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service);

      expect(logged.warn.join()).toContain('删除堆快照失败');
      expect(snapshotFiles()).toHaveLength(2);
    });

    it('目录为空时不产生清理日志', () => {
      const { service, logged } = build();
      service.onModuleInit();

      (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service);

      expect(logged.log.join()).not.toContain('已清理');
    });

    it('清理后保留的文件仍会打印目录概况', () => {
      const { service, logged } = build({ 'memory.dumpMaxFiles': 5 });
      service.onModuleInit();
      createSnapshot('heap-keep.heapsnapshot');

      (service as unknown as { cleanupHeapDumps(): void }).cleanupHeapDumps.call(service);

      expect(logged.log.join()).toContain('堆快照目录:');
    });
  });

  describe('listHeapDumps / getDumpDir', () => {
    it('按 mtime 倒序列出快照及体积', () => {
      const { service } = build();
      service.onModuleInit();
      createSnapshot('heap-older.heapsnapshot', 60_000);
      createSnapshot('heap-newer.heapsnapshot');

      const list = service.listHeapDumps();

      expect(list).toHaveLength(2);
      expect(list[0]).toContain('heap-newer');
      expect(list[0]).toContain('MB');
    });

    it('读取失败时返回空数组', () => {
      const { service } = build();
      service.onModuleInit();
      jest.spyOn(realFs, 'readdirSync').mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(service.listHeapDumps()).toEqual([]);
    });
  });

  describe('gracefulShutdown', () => {
    it('关闭应用、通知 PM2 并延迟退出', async () => {
      const close = jest.fn().mockResolvedValue(undefined);
      const { service, logged } = build({}, { close });
      service.onModuleInit();
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const send = jest.fn();
      const originalSend = process.send;
      process.send = send as unknown as typeof process.send;
      jest.useFakeTimers();

      try {
        await service.gracefulShutdown('测试退出');

        expect(close).toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('shutdown');
        expect((service as unknown as { restarting: boolean }).restarting).toBe(true);

        jest.advanceTimersByTime(3000);

        expect(exit).toHaveBeenCalledWith(1);
        expect(logged.log.join()).toContain('进程退出');
      } finally {
        process.send = originalSend;
      }
    });

    it('关闭应用抛错时继续走退出流程', async () => {
      const close = jest.fn().mockRejectedValue(new Error('close failed'));
      const { service, logged } = build({}, { close });
      service.onModuleInit();
      jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const originalSend = process.send;
      process.send = jest.fn() as unknown as typeof process.send;
      jest.useFakeTimers();

      try {
        await service.gracefulShutdown('关闭失败');

        expect(close).toHaveBeenCalled();
        expect(logged.warn.join()).toContain('关闭 NestJS 应用时异常');
      } finally {
        process.send = originalSend;
      }
    });

    it('取不到应用实例时跳过关闭', async () => {
      const { service, logged } = build({}, undefined);
      service.onModuleInit();
      jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const originalSend = process.send;
      process.send = jest.fn() as unknown as typeof process.send;
      jest.useFakeTimers();

      try {
        await service.gracefulShutdown('无应用实例');

        expect(logged.log.join()).not.toContain('NestJS 应用已关闭');
      } finally {
        process.send = originalSend;
      }
    });

    it('重复调用时不会二次清理', async () => {
      const close = jest.fn().mockResolvedValue(undefined);
      const { service } = build({}, { close });
      service.onModuleInit();
      jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const originalSend = process.send;
      process.send = jest.fn() as unknown as typeof process.send;
      jest.useFakeTimers();

      try {
        await service.gracefulShutdown('第一次');
        await service.gracefulShutdown('第二次');

        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        process.send = originalSend;
      }
    });

    it('process.send 不存在时不发送 shutdown 消息', async () => {
      const close = jest.fn().mockResolvedValue(undefined);
      const { service } = build({}, { close });
      service.onModuleInit();
      jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const originalSend = process.send;
      (process as unknown as { send?: unknown }).send = undefined;
      jest.useFakeTimers();

      try {
        await expect(service.gracefulShutdown('无 IPC')).resolves.toBeUndefined();

        expect(close).toHaveBeenCalled();
      } finally {
        (process as unknown as { send?: unknown }).send = originalSend;
      }
    });
  });

  describe('onModuleDestroy', () => {
    it('销毁时记录日志', () => {
      const { service, logged } = build();
      service.onModuleInit();

      service.onModuleDestroy();

      expect(logged.log.join()).toContain('已销毁');
    });
  });
});
