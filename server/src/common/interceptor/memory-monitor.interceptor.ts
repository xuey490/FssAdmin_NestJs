import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MemoryMonitorService } from '../../module/monitor/memory/memory-monitor.service';

/**
 * 请求级内存监控拦截器
 * 每次请求后记录内存变化，检测异常增长趋势
 */
@Injectable()
export class MemoryMonitorInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MemoryMonitorInterceptor.name);
  /** 上次记录的内存基线 */
  private baseline = process.memoryUsage().rss;
  /** 连续增长计数 */
  private growthCount = 0;
  /** 每次增长超过此值才算 "增长" (5MB) */
  private readonly growthThresholdBytes = 5 * 1024 * 1024;
  /** 连续几次增长触发告警 */
  private readonly maxGrowthCount = 20;

  constructor(private readonly memoryMonitor: MemoryMonitorService) {}

  /**
   * 请求级内存监控入口。
   * 在请求完成后调用 checkAfterRequest 记录内存变化，检测异常增长趋势。
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const url = req?.url || 'unknown';

    return next.handle().pipe(
      tap({
        next: () => {
          this.checkAfterRequest(url);
        },
        error: () => {
          this.checkAfterRequest(url);
        },
      }),
    );
  }

  /**
   * 请求后内存检查逻辑。
   * 比较当前 RSS 与基线的差值，连续增长超过阈值次数时触发告警日志，持续增长时调用完整内存检查。
   * 内存回落后重置计数并更新基线。是否参与检测由 MemoryMonitorService.isMonitorEnabled() 统一决定
   * （Bun 默认跳过，需 MEMORY_BUN_MONITOR_ENABLED=true 开启）。
   */
  private checkAfterRequest(url: string) {
    if (!this.memoryMonitor.isMonitorEnabled()) return;

    try {
      const currentRss = process.memoryUsage().rss;
      const diff = currentRss - this.baseline;

      // 跳过健康检查/监控端点的自调用
      if (url.includes('/api/core/monitor/')) return;

      if (diff > this.growthThresholdBytes) {
        this.growthCount++;
        if (this.growthCount === this.maxGrowthCount) {
          this.logger.warn(
            `内存连续增长 ${this.growthCount} 次，累计增长 ${(diff / 1024 / 1024).toFixed(1)}MB，请求路径: ${url}`,
          );
        }
        if (this.growthCount >= this.maxGrowthCount + 5) {
          // 持续增长，触发完整内存检查
          void this.memoryMonitor.checkMemory();
        }
      } else if (diff < -this.growthThresholdBytes) {
        // 内存下降，重置计数
        if (this.growthCount > 0) {
          this.logger.log(`内存增长趋势已缓解，共增长 ${this.growthCount} 次后回落`);
        }
        this.growthCount = 0;
      }

      // 定期更新基线（增长趋势缓解后重置）
      if (this.growthCount === 0) {
        this.baseline = currentRss;
      }
    } catch {
      // 静默处理
    }
  }
}
