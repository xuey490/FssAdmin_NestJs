import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import * as v8 from 'v8';
import * as fs from 'fs';
import * as path from 'path';

export interface MemoryInfo {
  /** 进程常驻内存 (bytes) */
  rss: number;
  /** V8 堆总量 (bytes) */
  heapTotal: number;
  /** V8 堆已用 (bytes) */
  heapUsed: number;
  /** V8 堆空闲 (bytes) */
  heapAvailable: number;
  /** 外部内存 (bytes) */
  external: number;
  /** 数组缓冲区 (bytes) */
  arrayBuffers: number;
  /** 已用堆占堆总量的百分比 */
  heapUsagePercent: number;
  /** RSS 百分比(相对阈值) */
  rssPercent: number;
  /** 堆中存活对象大小 (bytes) */
  heapLive: number;
}

export interface MemoryThreshold {
  /** RSS 软阈值 (bytes)，超过时记录警告 */
  rssWarn: number;
  /** RSS 硬阈值 (bytes)，超过时触发重启 */
  rssFatal: number;
  /** 堆使用率软阈值 0-100 */
  heapUsageWarn: number;
  /** 堆使用率硬阈值 0-100 */
  heapUsageFatal: number;
}

interface HeapDumpFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

@Injectable()
export class MemoryMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryMonitorService.name);
  private readonly dumpDir: string;
  private restarting = false;
  private lastHeapUsed = 0;
  private growthCount = 0;
  private readonly growthThreshold = 5; // 连续几次增长算异常
  private fatalExit = false;
  private rssFatalEnabled = true;
  /** Bun 下是否启用内存检查（默认关闭，需 MEMORY_BUN_MONITOR_ENABLED=true 显式开启） */
  private bunMonitorEnabled = false;
  /** 堆使用率是否参与判定（Bun 下 heapUsed/heapTotal 口径无效，默认关闭） */
  private heapUsageEnabled = true;

  /** 是否允许自动生成堆快照（手动触发不受此开关限制） */
  private dumpEnabled = false;
  /** heapdump 目录保留的最大快照数量（0 = 不限制） */
  private dumpMaxFiles = 3;
  /** 堆快照过期天数（0 = 不按时间清理） */
  private dumpRetentionDays = 1;
  /** 同一原因两次自动快照的最小间隔（毫秒，0 = 不节流） */
  private dumpMinIntervalMs = 60000;
  /** 并发守卫：避免多个触发点同时写入快照 */
  private dumping = false;
  /** 各触发原因上次生成快照的时间戳 */
  private readonly lastDumpAt = new Map<string, number>();

  /** 默认阈值（OnModuleInit 从配置覆盖） */
  private thresholds: MemoryThreshold = {
    rssWarn: 300 * 1024 * 1024,
    rssFatal: 450 * 1024 * 1024,
    heapUsageWarn: 85,
    heapUsageFatal: 95,
  };

  // Bun 运行时检测
  private isBun: boolean;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
  ) {
    this.isBun = !!process.versions?.bun || process.execPath.includes('bun');
    // 确保 dump 目录存在
    this.dumpDir = path.resolve(process.cwd(), 'logs', 'heapdump');
    if (!fs.existsSync(this.dumpDir)) {
      fs.mkdirSync(this.dumpDir, { recursive: true });
    }
  }

  /**
   * 模块初始化：从配置加载内存监控阈值
   */
  onModuleInit() {
    const mb = (n: number) => n * 1024 * 1024;

    // Bun 使用 JavaScriptCore，v8 模块的 heap_size_limit 报告不准确（常只有 ~50MB），
    // 导致 heapUsagePercent 虚高。Bun 下大幅提高堆阈值，聚焦 RSS 监控。
    this.thresholds = {
      rssWarn: mb(this.configService.get<number>('memory.rssWarnMb', this.isBun ? 600 : 300)),
      rssFatal: mb(this.configService.get<number>('memory.rssFatalMb', this.isBun ? 900 : 450)),
      heapUsageWarn: this.configService.get<number>('memory.heapUsageWarn', this.isBun ? 99 : 85),
      heapUsageFatal: this.configService.get<number>('memory.heapUsageFatal', this.isBun ? 100 : 95),
    };
    this.fatalExit = this.configService.get<boolean>('memory.fatalExit', false);
    this.rssFatalEnabled = this.configService.get<boolean>('memory.rssFatalEnabled', !this.isBun);
    this.bunMonitorEnabled = this.configService.get<boolean>('memory.bunMonitorEnabled', false);
    this.heapUsageEnabled = this.configService.get<boolean>('memory.heapUsageEnabled', !this.isBun);
    this.dumpEnabled = this.configService.get<boolean>('memory.dumpEnabled', false);
    this.dumpMaxFiles = this.configService.get<number>('memory.dumpMaxFiles', 3);
    this.dumpRetentionDays = this.configService.get<number>('memory.dumpRetentionDays', 1);
    this.dumpMinIntervalMs = this.configService.get<number>('memory.dumpMinIntervalMs', 60000);

    this.logger.log(
      `运行时: ${this.isBun ? 'Bun 🧪' : 'Node.js'}，` +
        `内存监控阈值: RSS 警告 ${this.thresholds.rssWarn / 1024 / 1024}MB / 致命 ${this.thresholds.rssFatal / 1024 / 1024}MB` +
        `，堆判定=${
          this.heapUsageEnabled
            ? `${this.thresholds.heapUsageWarn}% / ${this.thresholds.heapUsageFatal}%`
            : '禁用（该运行时 heapUsed/heapTotal 口径无效）'
        }` +
        `，超限退出=${this.fatalExit}，RSS致命=${this.rssFatalEnabled}`,
    );

    // 显式提示 Bun 下内存检查是否生效，避免"阈值看着配了但不生效"的误解
    if (this.isBun) {
      this.logger.log(
        this.bunMonitorEnabled
          ? '内存检查: Bun 下已启用（MEMORY_BUN_MONITOR_ENABLED=true），阈值判定与自动堆快照生效'
          : '内存检查: Bun 下已跳过（默认），如需生效请设置 MEMORY_BUN_MONITOR_ENABLED=true',
      );
    }
    this.logger.log(
      `堆快照策略: 自动生成=${this.dumpEnabled}（MEMORY_DUMP_ENABLED，未配置时跟随 DEBUG），` +
        `保留 ${this.dumpMaxFiles} 个 / ${this.dumpRetentionDays} 天，` +
        `节流 ${this.dumpMinIntervalMs}ms，目录 ${this.dumpDir}`,
    );

    // 启动自检：立即回收历史快照占用的磁盘空间
    this.cleanupHeapDumps();
  }

  /** 获取当前内存快照 */
  getMemoryInfo(): MemoryInfo {
    const mem = process.memoryUsage();
    let heapStats: any = {};
    try {
      heapStats = v8.getHeapStatistics();
    } catch {
      /* 运行时不支持时忽略，堆统计字段降级为 undefined */
    }
    return {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      heapAvailable: heapStats.heap_size_limit - mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers || 0,
      heapUsagePercent: mem.heapTotal > 0 ? +(mem.heapUsed / mem.heapTotal * 100).toFixed(1) : 0,
      rssPercent: this.thresholds.rssFatal > 0 ? +(mem.rss / this.thresholds.rssFatal * 100).toFixed(1) : 0,
      heapLive: heapStats.used_heap_size,
    };
  }

  /** 格式化友好的内存报告 */
  getMemoryReport(): string {
    const info = this.getMemoryInfo();
    const format = (bytes: number) => {
      if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
      if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    };
    return [
      `RSS: ${format(info.rss)} (${info.rssPercent}%)`,
      `堆: ${format(info.heapUsed)} / ${format(info.heapTotal)} (${info.heapUsagePercent}%)`,
      `外部: ${format(info.external)}`,
    ].join(' | ');
  }

  /** 更新阈值 */
  setThresholds(thresholds: Partial<MemoryThreshold>) {
    Object.assign(this.thresholds, thresholds);
  }

  /**
   * 当前运行时是否执行内存检查。
   * Node 恒为 true；Bun 仅在 MEMORY_BUN_MONITOR_ENABLED=true 时为 true。
   * 供请求级拦截器等调用方复用，避免各自重复判断运行时。
   */
  isMonitorEnabled(): boolean {
    return !this.isBun || this.bunMonitorEnabled;
  }

  /**
   * 检查内存状态
   * @returns true=正常, false=需要重启
   */
  async checkMemory(): Promise<boolean> {
    if (this.restarting) return false;

    // Bun 默认跳过：JSC 内存口径与 V8 不同，需 MEMORY_BUN_MONITOR_ENABLED=true 显式开启
    if (!this.isMonitorEnabled()) return true;

    const info = this.getMemoryInfo();
    this.logger.verbose(`内存状态: ${this.getMemoryReport()}`);

    // 检测异常增长（每次调用堆使用量持续增长）
    if (info.heapUsed > this.lastHeapUsed && this.lastHeapUsed > 0) {
      this.growthCount++;
      if (this.growthCount >= this.growthThreshold) {
        this.logger.warn(`堆内存连续增长 ${this.growthCount} 次，当前 ${(info.heapUsed / 1024 / 1024).toFixed(1)}MB`);
      }
    } else {
      this.growthCount = 0;
    }
    this.lastHeapUsed = info.heapUsed;

    // 致命阈值：触发堆快照；开发环境默认只告警不退出
    const rssFatal = this.rssFatalEnabled && info.rss >= this.thresholds.rssFatal;
    const heapFatal =
      this.heapUsageEnabled && info.heapUsagePercent >= this.thresholds.heapUsageFatal;
    if (rssFatal || heapFatal) {
      this.logger.error(`内存超过致命阈值！${this.getMemoryReport()}`);
      await this.dumpHeap('fatal');
      if (this.fatalExit) {
        await this.gracefulShutdown('内存超限致命错误');
        return false;
      }
      this.logger.warn('MEMORY_FATAL_EXIT=false，跳过进程退出（开发/Bun 常见）');
      return true;
    }

    // 警告阈值：记录堆快照
    if (
      info.rss >= this.thresholds.rssWarn ||
      (this.heapUsageEnabled && info.heapUsagePercent >= this.thresholds.heapUsageWarn)
    ) {
      this.logger.warn(`内存超过警告阈值！${this.getMemoryReport()}`);
      await this.dumpHeap('warn');
    }

    return true;
  }

  /**
   * 生成堆快照。
   * 自动触发（warn/fatal）受 MEMORY_DUMP_ENABLED 开关、节流与并发守卫约束；
   * 手动触发（manual）不受开关与节流限制，但仍受数量上限与过期清理保护。
   * @param reason 触发原因
   * @returns 快照文件路径，未生成时返回 null
   */
  async dumpHeap(reason: 'manual' | 'warn' | 'fatal' = 'manual'): Promise<string | null> {
    const isManual = reason === 'manual';

    // 1. 开关：自动快照在关闭时直接跳过，仅保留调用方的超阈值告警日志
    if (!isManual && !this.dumpEnabled) {
      this.logger.verbose(`自动堆快照已关闭（MEMORY_DUMP_ENABLED=false），跳过 ${reason} 快照`);
      return null;
    }

    // 2. 并发守卫：避免拦截器/定时任务同时写入
    if (this.dumping) {
      this.logger.warn('堆快照正在生成中，跳过本次请求');
      return null;
    }

    // 3. 节流：同一原因在最小间隔内只允许生成一个快照
    if (!isManual && this.dumpMinIntervalMs > 0) {
      const lastDumpAt = this.lastDumpAt.get(reason) ?? 0;
      const elapsed = Date.now() - lastDumpAt;

      if (lastDumpAt > 0 && elapsed < this.dumpMinIntervalMs) {
        this.logger.warn(
          `堆快照节流中（${reason}，距上次 ${(elapsed / 1000).toFixed(0)}s < ${this.dumpMinIntervalMs / 1000}s），跳过`,
        );
        return null;
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    const filename = `heap-${reason}-${rssMb}mb-${timestamp}.heapsnapshot`;
    const filepath = path.join(this.dumpDir, filename);

    this.dumping = true;
    try {
      // 4. 写入前先清理，避免快照累积占满磁盘
      this.cleanupHeapDumps();

      // 使用 Node.js 内置 v8.writeHeapSnapshot（Bun 下不支持，静默跳过）
      if (typeof v8.writeHeapSnapshot === 'function') {
        const written = v8.writeHeapSnapshot(filepath);
        this.lastDumpAt.set(reason, Date.now());
        this.logger.log(`堆快照已保存: ${written} (${reason})`);
        return written;
      }

      this.logger.verbose('堆快照功能在当前运行时不可用');
      return null;
    } catch (err) {
      this.logger.error(`堆快照保存失败: ${(err as any)?.message}`);
      return null;
    } finally {
      this.dumping = false;
    }
  }

  /**
   * 清理堆快照目录。
   * 保留最近 dumpMaxFiles 个快照，并删除超过 dumpRetentionDays 天的快照；
   * 单项删除失败仅告警，不阻断后续流程。数量与天数均为 0 时跳过。
   */
  private cleanupHeapDumps(): void {
    if (this.dumpMaxFiles <= 0 && this.dumpRetentionDays <= 0) {
      return;
    }

    let files: HeapDumpFile[];

    try {
      files = fs
        .readdirSync(this.dumpDir)
        .filter((name) => name.endsWith('.heapsnapshot'))
        .reduce<HeapDumpFile[]>((acc, name) => {
          try {
            const filePath = path.join(this.dumpDir, name);
            const fileStat = fs.statSync(filePath);
            acc.push({ name, path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
          } catch {
            // 文件在扫描期间被删除等情况，忽略该项
          }

          return acc;
        }, [])
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`扫描堆快照目录失败: ${(error as Error)?.message}`);
      }

      return;
    }

    if (files.length === 0) {
      return;
    }

    const totalSizeMb = files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
    const cutoffTime =
      this.dumpRetentionDays > 0
        ? Date.now() - this.dumpRetentionDays * 24 * 60 * 60 * 1000
        : Number.NEGATIVE_INFINITY;

    let removedCount = 0;
    let removedSizeMb = 0;

    files.forEach((file, index) => {
      const expired = file.mtimeMs < cutoffTime;
      const overflow = this.dumpMaxFiles > 0 && index >= this.dumpMaxFiles;

      if (!expired && !overflow) {
        return;
      }

      try {
        fs.unlinkSync(file.path);
        removedCount += 1;
        removedSizeMb += file.size / 1024 / 1024;
      } catch (error) {
        this.logger.warn(`删除堆快照失败: ${file.name} (${(error as Error)?.message})`);
      }
    });

    if (removedCount > 0) {
      this.logger.log(
        `已清理 ${removedCount} 个堆快照（释放 ${removedSizeMb.toFixed(1)}MB），` +
          `当前保留 ${files.length - removedCount} 个 / 共 ${(totalSizeMb - removedSizeMb).toFixed(1)}MB`,
      );
      return;
    }

    this.logger.log(`堆快照目录: 共 ${files.length} 个 / ${totalSizeMb.toFixed(1)}MB`);
  }

  /** 列出已有的堆快照文件 */
  listHeapDumps(): string[] {
    try {
      return fs.readdirSync(this.dumpDir)
        .filter(f => f.endsWith('.heapsnapshot'))
        .map(f => ({
          name: f,
          size: fs.statSync(path.join(this.dumpDir, f)).size,
          mtime: fs.statSync(path.join(this.dumpDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .map(f => `${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch {
      return [];
    }
  }

  /** 获取堆快照目录路径 */
  getDumpDir(): string {
    return this.dumpDir;
  }

  /**
   * 优雅退出 — 让 PM2 重新拉起
   */
  async gracefulShutdown(reason: string): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;

    this.logger.warn(`准备优雅退出，原因: ${reason}`);

    try {
      // 尝试关闭 NestJS 应用（释放数据库连接、Redis 连接等）
      const app = this.moduleRef.get('NestApplication' as any, { strict: false });
      if (app && typeof app.close === 'function') {
        await app.close();
        this.logger.log('NestJS 应用已关闭，释放连接');
      }
    } catch (err) {
      this.logger.warn(`关闭 NestJS 应用时异常: ${(err as any)?.message}`);
    }

    // 给 PM2 发送 shutdown 消息，等待 kill_timeout
    if (process.send) {
      process.send('shutdown');
    }

    // 延迟后退出
    setTimeout(() => {
      this.logger.log(`进程退出，原因: ${reason}`);
      process.exit(1);
    }, 3000);
  }

  onModuleDestroy() {
    this.logger.log('MemoryMonitorService 已销毁');
  }
}
