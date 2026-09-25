import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * 进程内信号量，限制当前 worker 的并发 LLM 流数量。
 * 通过 AI_MAX_CONCURRENT_STREAMS 环境变量配置（默认 10），
 * 超出时直接拒绝并提示用户等待。
 */
@Injectable()
export class LlmSemaphoreService {
  private readonly logger = new Logger(LlmSemaphoreService.name);
  private active = 0;
  private readonly limit: number;

  constructor() {
    this.limit = Math.max(1, Number(process.env.AI_MAX_CONCURRENT_STREAMS) || 10);
    this.logger.log(`LLM 并发流限制: ${this.limit}`);
  }

  /** 并发上限（只读），供在途流登记表推导容量 */
  get maxConcurrent(): number {
    return this.limit;
  }

  /** 尝试获取一个流槽位；超过上限时抛出 ServiceUnavailableException */
  acquire(): void {
    if (this.active >= this.limit) {
      throw new ServiceUnavailableException(
        `AI 服务繁忙（当前 ${this.active} 路并发，上限 ${this.limit}），请稍后再试`,
      );
    }
    this.active++;
    this.logger.debug(`LLM 流槽位占用: ${this.active}/${this.limit}`);
  }

  /** 释放一个流槽位 */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.logger.debug(`LLM 流槽位释放: ${this.active}/${this.limit}`);
  }

  /** 当前活跃流数 */
  get activeCount(): number {
    return this.active;
  }
}
