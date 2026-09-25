/**
 * 临时验证脚本：校验 MEMORY_BUN_MONITOR_ENABLED 开关在 Bun 下的真实行为。
 * 仅用于本次改造验证，运行后删除。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const base = path.join(os.tmpdir(), `bun-monitor-verify-${Date.now()}`);
const originalCwd = process.cwd();
fs.mkdirSync(base, { recursive: true });
process.chdir(base);
const dumpDir = path.join(base, 'logs', 'heapdump');

const { MemoryMonitorService } = await import('./src/module/monitor/memory/memory-monitor.service.ts');
const configurationModule = await import('./src/config/configuration.ts');
const configuration = configurationModule.default as () => any;

const ENV_KEYS = [
  'MEMORY_BUN_MONITOR_ENABLED',
  'MEMORY_RSS_WARN_MB',
  'MEMORY_RSS_FATAL_MB',
  'MEMORY_HEAP_WARN_PERCENT',
  'MEMORY_HEAP_FATAL_PERCENT',
  'MEMORY_HEAP_USAGE_ENABLED',
  'MEMORY_RSS_FATAL_ENABLED',
  'MEMORY_DUMP_ENABLED',
  'MEMORY_DUMP_MAX_FILES',
  'MEMORY_DUMP_RETENTION_DAYS',
  'MEMORY_DUMP_MIN_INTERVAL_MS',
  'MEMORY_FATAL_EXIT',
  'DEBUG',
];

const buildService = (env: Record<string, string | undefined>) => {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(env).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });

  const config = configuration();
  const get = (dotPath: string, fallback?: unknown) =>
    dotPath.split('.').reduce<any>((acc, key) => (acc === undefined ? acc : acc[key]), config) ?? fallback;

  const svc: any = new MemoryMonitorService({ get: () => undefined } as any, { get } as any);
  const logs: string[] = [];
  svc.logger = {
    log: (m: string) => logs.push(`log:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
    verbose: (m: string) => logs.push(`verbose:${m}`),
  };
  svc.onModuleInit();
  const initLogs = [...logs];
  logs.length = 0;
  return { svc, logs, initLogs, config };
};

const snapshots = () =>
  fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).filter((f) => f.endsWith('.heapsnapshot')) : [];

check('前置条件：当前运行时确为 Bun', !!process.versions.bun, `bun=${process.versions.bun}`);

// ---------- 1. 默认关闭：Bun 下不判定、不产快照 ----------
{
  const { svc, initLogs } = buildService({ DEBUG: 'true' });
  const enabled = svc.isMonitorEnabled();
  const before = snapshots().length;
  const result = await svc.checkMemory();
  check('B1 默认 no MEMORY_BUN_MONITOR_ENABLED 时 isMonitorEnabled()=false', enabled === false);
  check('B2 默认关闭时 checkMemory 直接返回 true', result === true);
  check('B3 默认关闭时不产生快照', snapshots().length === before);
  check('B4 启动日志提示 Bun 下已跳过', initLogs.some((l) => l.includes('内存检查: Bun 下已跳过')));
}

// ---------- 2. 显式开启：默认阈值放宽 + RSS 致命启用 + 堆判定禁用 ----------
{
  const { svc, config, initLogs } = buildService({ MEMORY_BUN_MONITOR_ENABLED: 'true', DEBUG: 'true' });
  check('B5 开启后 isMonitorEnabled()=true', svc.isMonitorEnabled() === true);
  check(
    'B6 开启后默认 RSS 阈值为 1200/1600',
    config.memory.rssWarnMb === 1200 && config.memory.rssFatalMb === 1600,
    `RSS ${config.memory.rssWarnMb}/${config.memory.rssFatalMb}`,
  );
  check('B7 开启后 RSS 致命判定默认启用', config.memory.rssFatalEnabled === true);
  check('B8 Bun 下堆判定默认禁用（口径无效）', config.memory.heapUsageEnabled === false);
  check('B9 启动日志标注堆判定禁用', initLogs.some((l) => l.includes('堆判定=禁用')));

  const before = snapshots().length;
  const result = await svc.checkMemory();
  check(
    'B10 开启后真实执行判定（实测 heapUsed/heapTotal 虚高也不误报）',
    result === true && snapshots().length === before,
    `快照 ${before} -> ${snapshots().length}`,
  );
}

// ---------- 3. 低阈值 + 打开 dump：Bun 下真的写出快照 ----------
{
  const { svc, logs } = buildService({
    MEMORY_BUN_MONITOR_ENABLED: 'true',
    MEMORY_RSS_WARN_MB: '1',
    MEMORY_DUMP_ENABLED: 'true',
    DEBUG: 'true',
  });
  const result = await svc.checkMemory();
  check('B11 超警告阈值时记录告警', logs.some((l) => l.includes('内存超过警告阈值')));
  check('B12 Bun 下写出真实快照（writeHeapSnapshot 已可用）', snapshots().length === 1, snapshots().join(','));
  check('B13 快照文件名带 warn 标记（未误判为 fatal）', snapshots().some((f) => f.includes('heap-warn-')), snapshots().join(','));
  check('B14 checkMemory 仍返回 true（未触发退出）', result === true);
}

// ---------- 4. 低阈值 + 关闭 dump：只告警不产文件 ----------
{
  const { svc, logs } = buildService({
    MEMORY_BUN_MONITOR_ENABLED: 'true',
    MEMORY_RSS_WARN_MB: '1',
    MEMORY_DUMP_ENABLED: 'false',
    DEBUG: 'true',
  });
  const before = snapshots().length;
  await svc.checkMemory();
  check('B15 MEMORY_DUMP_ENABLED=false 时不产新快照', snapshots().length === before);
  check('B16 仍记录超阈值告警', logs.some((l) => l.includes('内存超过警告阈值')));
}

// ---------- 5. 单独关闭 RSS 致命判定 ----------
{
  const { config } = buildService({
    MEMORY_BUN_MONITOR_ENABLED: 'true',
    MEMORY_RSS_FATAL_ENABLED: 'false',
    DEBUG: 'true',
  });
  check('B17 MEMORY_RSS_FATAL_ENABLED=false 可单独关闭 Bun 的 RSS 致命判定', config.memory.rssFatalEnabled === false);
}

// ---------- 6. 强制开启堆判定（不推荐，验证开关可控） ----------
{
  const { config } = buildService({
    MEMORY_BUN_MONITOR_ENABLED: 'true',
    MEMORY_HEAP_USAGE_ENABLED: 'true',
    DEBUG: 'true',
  });
  check('B18 MEMORY_HEAP_USAGE_ENABLED=true 可强制开启（不推荐）', config.memory.heapUsageEnabled === true);
}

// ---------- 7. 未开启 Bun 监控时显式阈值不生效（仍短路） ----------
{
  const { svc } = buildService({ MEMORY_RSS_WARN_MB: '1', MEMORY_DUMP_ENABLED: 'true', DEBUG: 'true' });
  const before = snapshots().length;
  await svc.checkMemory();
  check('B19 未开启 Bun 监控时即使阈值极低也不产快照', snapshots().length === before);
}

process.chdir(originalCwd);
try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {
  console.log(`临时目录未清理（可手动删除）: ${base}`);
}

console.log(results.join('\n'));
console.log(`\nFAIL 数量: ${results.filter((r) => r.startsWith('FAIL')).length}`);
