import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { LlmSemaphoreService } from './llm-semaphore.service';

/** 在途流登记条目 */
export interface StreamAbortEntry {
  /** 用于中止该流的控制器 */
  abort: AbortController;
  /** 所属会话 UUID，支持按会话批量中止 */
  sessionUuid: string;
}

/**
 * AI 在途流登记表（单进程内存实现）。
 *
 * 记录当前 worker 上正在进行的 LLM 流，供「停止生成」按消息/会话中止；
 * 多 worker 场景由 AiStreamStopService 通过 Redis 广播触达各 worker 的本地登记表。
 *
 * 关键约束：
 * - 登记表有容量上限（并发上限 × 4，且不小于 64），超限时按登记顺序驱逐最旧条目并告警，
 *   避免任何调用方遗漏注销时造成无界增长；
 * - `unregister` 幂等，重复调用安全；
 * - 模块销毁时清空登记表。
 */
@Injectable()
export class AiStreamRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(AiStreamRegistry.name);

  /** Map 保持插入顺序，便于超限时驱逐最旧条目 */
  private readonly entries = new Map<string, StreamAbortEntry>();

  /** 容量上限：并发上限的 4 倍（留出取消到 finally 之间的释放窗口） */
  private readonly maxEntries: number;

  constructor(private readonly semaphore: LlmSemaphoreService) {
    this.maxEntries = Math.max(64, this.semaphore.maxConcurrent * 4);
  }

  /**
   * 登记一个在途流。
   * 同一 messageUuid 重复登记会覆盖旧条目（不会重复计数）；超过上限时驱逐最早登记的条目。
   * @param messageUuid 助手消息 UUID
   * @param entry 中止控制器与所属会话
   */
  register(messageUuid: string, entry: StreamAbortEntry): void {
    // 覆盖前先删除，保证同一 key 不占两个位置，也保证驱逐顺序按最新登记计算
    this.entries.delete(messageUuid);
    this.entries.set(messageUuid, entry);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;

      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.logger.warn(
        `在途流登记表超过上限 ${this.maxEntries}，已驱逐最早条目 messageUuid=${oldestKey}` +
          `${evicted ? ` (session=${evicted.sessionUuid})` : ''}`,
      );
    }
  }

  /**
   * 注销一个在途流（幂等）。
   * @param messageUuid 助手消息 UUID
   * @returns 被注销的条目，未登记时返回 undefined
   */
  unregister(messageUuid: string): StreamAbortEntry | undefined {
    const entry = this.entries.get(messageUuid);
    if (entry) {
      this.entries.delete(messageUuid);
    }

    return entry;
  }

  /**
   * 中止在途流：优先按消息 UUID 精确中止，其次按会话 UUID 中止该会话下的首个流。
   * @param messageUuid 消息 UUID（可选）
   * @param sessionUuid 会话 UUID（可选）
   * @returns 是否成功中止了至少一个流
   */
  abort(messageUuid?: string, sessionUuid?: string): boolean {
    let aborted = false;

    if (messageUuid) {
      const entry = this.entries.get(messageUuid);
      if (entry) {
        entry.abort.abort();
        this.entries.delete(messageUuid);
        aborted = true;
      }
    }

    if (sessionUuid) {
      // 同一会话可能存在多路并发流：按会话中止时全部中止，而不是只停第一路
      for (const [uuid, entry] of this.entries) {
        if (entry.sessionUuid === sessionUuid) {
          entry.abort.abort();
          this.entries.delete(uuid);
          aborted = true;
        }
      }
    }

    return aborted;
  }

  /** 当前登记的条目数 */
  get size(): number {
    return this.entries.size;
  }

  /** 清空登记表（模块销毁或测试使用） */
  clear(): void {
    this.entries.clear();
  }

  onModuleDestroy(): void {
    if (this.entries.size > 0) {
      this.logger.log(`销毁在途流登记表，剩余 ${this.entries.size} 个条目`);
    }
    this.clear();
  }
}
