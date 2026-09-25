import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LogRecord } from '../interfaces/log-record.interface';
import type { LogSink } from './log-sink.interface';

@Injectable()
export class FileLogSink implements LogSink {
  private readonly logDir: string;
  private readonly maxFileSizeBytes: number;
  private readonly retentionDays: number;
  private lastCleanupDate?: string;

  constructor(private readonly configService: ConfigService) {
    this.logDir = this.configService.get<string>('log.dir', 'logs');
    this.maxFileSizeBytes = this.configService.get<number>('log.maxFileSizeMb', 20) * 1024 * 1024;
    this.retentionDays = this.configService.get<number>('log.retentionDays', 30);
  }

  /**
   * 将日志记录写入文件。
   * 将记录序列化为 JSON 行，写入按小时分片的日志文件，并触发过期日志清理。
   * @param record 日志记录
   */
  async write(record: LogRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const filePath = await this.getWritableFilePath(record.timestamp, Buffer.byteLength(line, 'utf8'));

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, 'utf8');
    this.scheduleCleanup(record.timestamp);
  }

  /**
   * 获取可写入的文件路径。
   * 若当前文件超过大小限制，则自动创建新分片文件（后缀 -02、-03 ...）。
   * @param timestamp 日志时间戳
   * @param incomingBytes 待写入字节数
   * @returns 可写入的文件路径
   */
  private async getWritableFilePath(timestamp: string, incomingBytes: number): Promise<string> {
    const baseFilePath = this.getHourlyFilePath(timestamp);

    if (this.maxFileSizeBytes <= 0 || (await this.canAppend(baseFilePath, incomingBytes))) {
      return baseFilePath;
    }

    for (let part = 2; part <= 999; part += 1) {
      const filePath = this.getHourlyFilePath(timestamp, part);

      if (await this.canAppend(filePath, incomingBytes)) {
        return filePath;
      }
    }

    return this.getHourlyFilePath(timestamp, 999);
  }

  /**
   * 根据时间戳生成按小时分片的文件路径。
   * 路径格式：{logDir}/{year}/{month}/{day}/{HH}[-{part}].jsonl。
   * @param timestamp ISO 时间戳
   * @param part 可选的分片编号
   * @returns 完整文件路径
   */
  private getHourlyFilePath(timestamp: string, part?: number): string {
    const date = new Date(timestamp);
    const localYear = String(date.getFullYear());
    const localMonth = String(date.getMonth() + 1).padStart(2, '0');
    const localDay = String(date.getDate()).padStart(2, '0');
    const hour = date.getHours();
    const fileName = `${String(hour).padStart(2, '0')}${part ? `-${String(part).padStart(2, '0')}` : ''}.jsonl`;

    return join(this.logDir, localYear, localMonth, localDay, fileName);
  }

  /**
   * 检查文件是否可以追加写入。
   * 若文件不存在或追加后不超过最大文件大小限制则返回 true。
   * @param filePath 文件路径
   * @param incomingBytes 待写入字节数
   * @returns 是否可以追加
   */
  private async canAppend(filePath: string, incomingBytes: number): Promise<boolean> {
    try {
      const fileStat = await stat(filePath);
      return fileStat.size + incomingBytes <= this.maxFileSizeBytes;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return true;
      }

      throw error;
    }
  }

  /**
   * 调度过期日志清理任务。
   * 同一天内仅执行一次清理，避免重复扫描。
   * @param timestamp ISO 时间戳
   */
  private scheduleCleanup(timestamp: string): void {
    const currentDate = timestamp.slice(0, 10);

    if (this.lastCleanupDate === currentDate) {
      return;
    }

    this.lastCleanupDate = currentDate;
    void this.cleanupExpiredLogs(timestamp).catch(() => undefined);
  }

  /**
   * 清理超过保留天数的过期日志目录。
   * 遍历年/月/日目录层级，删除截止时间之前的所有过期日志目录。
   * @param timestamp ISO 时间戳
   */
  private async cleanupExpiredLogs(timestamp: string): Promise<void> {
    if (this.retentionDays <= 0) {
      return;
    }

    const cutoffTime = new Date(timestamp).getTime() - this.retentionDays * 24 * 60 * 60 * 1000;

    let yearEntries;
    try {
      yearEntries = await readdir(this.logDir, { withFileTypes: true });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return;
      }

      throw error;
    }

    for (const yearEntry of yearEntries) {
      if (!yearEntry.isDirectory()) {
        continue;
      }

      const yearPath = join(this.logDir, yearEntry.name);
      const monthEntries = await readdir(yearPath, { withFileTypes: true });

      for (const monthEntry of monthEntries) {
        if (!monthEntry.isDirectory()) {
          continue;
        }

        const monthPath = join(yearPath, monthEntry.name);
        const dayEntries = await readdir(monthPath, { withFileTypes: true });

        for (const dayEntry of dayEntries) {
          if (!dayEntry.isDirectory()) {
            continue;
          }

          const dayEndTime = Date.UTC(
            Number(yearEntry.name),
            Number(monthEntry.name) - 1,
            Number(dayEntry.name),
            23,
            59,
            59,
            999,
          );

          if (Number.isNaN(dayEndTime) || dayEndTime >= cutoffTime) {
            continue;
          }

          await rm(join(monthPath, dayEntry.name), { recursive: true, force: true });
        }
      }
    }
  }

  /**
   * 判断是否为“文件不存在”错误。
   * 不使用 `error instanceof Error`：跨 realm（如 jest 的 vm 运行环境）下该判断会失效，
   * 导致 ENOENT 被误判为致命错误。这里只依赖错误码，保证任何环境下行为一致。
   * @param error 待判断的错误
   * @returns 是否为 ENOENT
   */
  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    );
  }
}
