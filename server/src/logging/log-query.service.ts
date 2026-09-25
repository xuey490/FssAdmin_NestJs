import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';

import { QueryLogsDto } from './dto/query-logs.dto';
import type { LogRecord } from './interfaces/log-record.interface';
import type { LogQueryCursor, QueryLogsResponse } from './interfaces/log-query-response.interface';

interface CandidateFile {
  fullPath: string;
  relativePath: string;
  time: number;
  hour: number;
  part: number;
}

interface QueryBounds {
  startTime: number;
  endTime: number;
  limit: number;
  order: 'asc' | 'desc';
  cursor?: LogQueryCursor;
}

const MAX_QUERY_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_SCANNED_FILES = 100;
const MAX_SCANNED_LINES = 200000;

@Injectable()
export class LogQueryService {
  private readonly logDir: string;

  constructor(private readonly configService: ConfigService) {
    this.logDir = this.configService.get<string>('log.dir', 'logs');
  }

  /**
   * 查询日志记录。
   * 根据查询条件扫描候选日志文件，过滤匹配的记录并分页返回。
   * 支持按时间范围、级别、类别、服务等条件筛选，以及游标分页。
   * @param dto 日志查询参数
   * @returns 查询结果，包含日志条目列表与分页信息
   */
  async query(dto: QueryLogsDto): Promise<QueryLogsResponse> {
    const bounds = this.createQueryBounds(dto);
    const files = await this.getCandidateFiles(bounds.startTime, bounds.endTime, bounds.order);
    const items: LogRecord[] = [];
    let scannedFiles = 0;
    let scannedLines = 0;
    let parseErrors = 0;
    let truncated = false;
    let hasMore = false;
    let nextCursor: string | undefined;

    for (const file of files) {
      if (scannedFiles >= MAX_SCANNED_FILES || scannedLines >= MAX_SCANNED_LINES) {
        truncated = true;
        break;
      }

      scannedFiles += 1;
      const result = await this.scanFile(file, dto, bounds, items, scannedLines);
      scannedLines = result.scannedLines;
      parseErrors += result.parseErrors;

      if (result.hasMore) {
        hasMore = true;
        nextCursor = result.nextCursor;
        break;
      }

      if (scannedLines >= MAX_SCANNED_LINES) {
        truncated = true;
        break;
      }
    }

    return {
      items,
      page: {
        limit: bounds.limit,
        nextCursor,
        hasMore,
      },
      summary: {
        scannedFiles,
        scannedLines,
        parseErrors,
        truncated,
        timeRange: {
          startAt: new Date(bounds.startTime).toISOString(),
          endAt: new Date(bounds.endTime).toISOString(),
        },
      },
    };
  }

  /**
   * 根据查询 DTO 创建查询边界对象。
   * 校验时间范围（不超过 24 小时）、游标一致性等约束。
   * @param dto 日志查询参数
   * @returns 查询边界对象
   * @throws BadRequestException 时间无效、范围超限或游标不匹配时抛出
   */
  private createQueryBounds(dto: QueryLogsDto): QueryBounds {
    const startTime = new Date(dto.startAt).getTime();
    const endTime = new Date(dto.endAt).getTime();

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new BadRequestException('startAt 或 endAt 不是有效时间');
    }

    if (startTime >= endTime) {
      throw new BadRequestException('startAt 必须小于 endAt');
    }

    if (endTime - startTime > MAX_QUERY_RANGE_MS) {
      throw new BadRequestException('最大查询时间范围不能超过 24 小时');
    }

    const order = dto.order ?? 'desc';
    const cursor = dto.cursor ? this.decodeCursor(dto.cursor) : undefined;

    if (cursor && cursor.order !== order) {
      throw new BadRequestException('cursor 与 order 不匹配');
    }

    return {
      startTime,
      endTime,
      limit: dto.limit ?? 100,
      order,
      cursor,
    };
  }

  /**
   * 获取指定时间范围内的候选日志文件列表。
   * 遍历候选小时目录，收集所有匹配的日志文件并按时间排序。
   * @param startTime 起始时间戳
   * @param endTime 结束时间戳
   * @param order 排序方向（升序/降序）
   * @returns 候选文件列表
   */
  private async getCandidateFiles(
    startTime: number,
    endTime: number,
    order: 'asc' | 'desc',
  ): Promise<CandidateFile[]> {
    const hours = this.getCandidateHours(startTime, endTime);
    const files: CandidateFile[] = [];

    for (const hourDate of hours) {
      files.push(...(await this.getHourFiles(hourDate)));
    }

    return files.sort((a, b) => {
      const timeDiff = a.time - b.time;
      const partDiff = a.part - b.part;
      const diff = timeDiff || partDiff || a.relativePath.localeCompare(b.relativePath);
      return order === 'asc' ? diff : -diff;
    });
  }

  /**
   * 计算起始时间到结束时间之间所有整点小时的时间列表。
   * @param startTime 起始时间戳
   * @param endTime 结束时间戳
   * @returns 整点小时日期数组
   */
  private getCandidateHours(startTime: number, endTime: number): Date[] {
    const hours: Date[] = [];
    const current = new Date(startTime);
    current.setMinutes(0, 0, 0);

    while (current.getTime() <= endTime) {
      hours.push(new Date(current));
      current.setHours(current.getHours() + 1);
    }

    return hours;
  }

  /**
   * 获取指定小时目录下的所有日志文件。
   * 文件路径格式为 {logDir}/{year}/{month}/{day}/{hour}[-{part}].jsonl。
   * @param hourDate 小时日期
   * @returns 候选文件列表
   */
  private async getHourFiles(hourDate: Date): Promise<CandidateFile[]> {
    const year = String(hourDate.getFullYear());
    const month = String(hourDate.getMonth() + 1).padStart(2, '0');
    const day = String(hourDate.getDate()).padStart(2, '0');
    const hour = String(hourDate.getHours()).padStart(2, '0');
    const dir = join(this.logDir, year, month, day);
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return [];
      }

      throw error;
    }

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => this.parseCandidateFile(dir, entry.name, hourDate.getTime()))
      .filter((file): file is CandidateFile => Boolean(file));
  }

  /**
   * 解析单个日志文件名，提取小时和分片信息。
   * 文件名格式为 HH.jsonl 或 HH-PP.jsonl（PP 为分片编号）。
   * @param dir 目录路径
   * @param fileName 文件名
   * @param hourTime 期望的小时时间戳
   * @returns 解析成功返回 CandidateFile，否则返回 null
   */
  private parseCandidateFile(dir: string, fileName: string, hourTime: number): CandidateFile | null {
    const match = /^(\d{2})(?:-(\d{2,3}))?\.(json|jsonl)$/.exec(fileName);

    if (!match) {
      return null;
    }

    const hour = Number(match[1]);
    const part = match[2] ? Number(match[2]) : 1;
    const expectedHour = new Date(hourTime).getHours();

    if (hour !== expectedHour) {
      return null;
    }

    const fullPath = join(dir, fileName);

    return {
      fullPath,
      relativePath: relative(this.logDir, fullPath).replace(/\\/g, '/'),
      time: hourTime,
      hour,
      part,
    };
  }

  /**
   * 扫描单个日志文件，匹配查询条件并收集结果。
   * 按顺序读取文件行、解析 JSON 记录、应用过滤条件，达到限制后返回游标。
   * @param file 候选文件
   * @param dto 查询参数
   * @param bounds 查询边界
   * @param items 结果收集数组
   * @param initialScannedLines 已扫描行数（用于全局限制）
   * @returns 扫描结果，包含扫描行数、解析错误数、是否还有更多数据及游标
   */
  private async scanFile(
    file: CandidateFile,
    dto: QueryLogsDto,
    bounds: QueryBounds,
    items: LogRecord[],
    initialScannedLines: number,
  ): Promise<{
    scannedLines: number;
    parseErrors: number;
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const stream = createReadStream(file.fullPath, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: Array<{ line: string; lineNumber: number }> = [];
    let lineNumber = 0;
    let scannedLines = initialScannedLines;
    let parseErrors = 0;

    // 首轮读取即施加行数上限，避免把整个日志文件的所有行读进内存：
    // - 正序：只保留前 N 行，读满即停止读取
    // - 倒序：只保留最后 N 行（环形窗口覆盖），保证仍是"最新优先"且内存有界
    const remainingBudget = Math.max(0, MAX_SCANNED_LINES - initialScannedLines);

    if (bounds.order === 'desc') {
      const ring: Array<{ line: string; lineNumber: number }> = [];

      for await (const line of reader) {
        lineNumber += 1;
        if (remainingBudget === 0) {
          break;
        }

        const item = { line, lineNumber };
        if (ring.length < remainingBudget) {
          ring.push(item);
        } else {
          ring[(lineNumber - 1) % remainingBudget] = item;
        }
      }

      ring.sort((a, b) => a.lineNumber - b.lineNumber);
      lines.push(...ring);
    } else {
      for await (const line of reader) {
        if (lines.length >= remainingBudget) {
          break;
        }

        lineNumber += 1;
        lines.push({ line, lineNumber });
      }
    }

    if (bounds.order === 'desc') {
      lines.reverse();
    }

    for (const lineInfo of lines) {
      if (scannedLines >= MAX_SCANNED_LINES) {
        return { scannedLines, parseErrors, hasMore: false };
      }

      scannedLines += 1;

      if (!lineInfo.line.trim()) {
        continue;
      }

      if (this.shouldSkipByCursor(file.relativePath, lineInfo.lineNumber, bounds.cursor, bounds.order)) {
        continue;
      }

      let record: LogRecord;
      try {
        record = JSON.parse(lineInfo.line) as LogRecord;
      } catch {
        parseErrors += 1;
        continue;
      }

      if (!this.matches(record, dto, bounds)) {
        continue;
      }

      items.push(record);

      if (items.length >= bounds.limit) {
        return {
          scannedLines,
          parseErrors,
          hasMore: true,
          nextCursor: this.encodeCursor({
            file: file.relativePath,
            line: lineInfo.lineNumber,
            order: bounds.order,
          }),
        };
      }
    }

    return { scannedLines, parseErrors, hasMore: false };
  }

  /**
   * 判断当前行是否应被游标跳过（已读取过的数据）。
   * @param file 文件路径
   * @param line 行号
   * @param cursor 游标对象
   * @param order 排序方向
   * @returns 是否跳过该行
   */
  private shouldSkipByCursor(
    file: string,
    line: number,
    cursor: LogQueryCursor | undefined,
    order: 'asc' | 'desc',
  ): boolean {
    if (!cursor) {
      return false;
    }

    const currentKey = `${file}:${String(line).padStart(12, '0')}`;
    const cursorKey = `${cursor.file}:${String(cursor.line).padStart(12, '0')}`;

    return order === 'asc' ? currentKey <= cursorKey : currentKey >= cursorKey;
  }

  /**
   * 判断日志记录是否匹配查询条件。
   * 支持按时间范围、级别、类别、服务、环境、请求 ID、追踪 ID、来源、
   * 消息内容、HTTP 方法、路径、状态码进行过滤。
   * @param record 日志记录
   * @param dto 查询参数
   * @param bounds 查询边界
   * @returns 是否匹配
   */
  private matches(record: LogRecord, dto: QueryLogsDto, bounds: QueryBounds): boolean {
    const recordTime = new Date(record.timestamp).getTime();

    if (!Number.isFinite(recordTime) || recordTime < bounds.startTime || recordTime > bounds.endTime) {
      return false;
    }

    if (dto.level && record.level !== dto.level) return false;
    if (dto.category && record.category !== dto.category) return false;
    if (dto.service && record.service !== dto.service) return false;
    if (dto.env && record.env !== dto.env) return false;
    if (dto.requestId && record.requestId !== dto.requestId) return false;
    if (dto.traceId && record.traceId !== dto.traceId) return false;
    if (dto.source && record.source !== dto.source) return false;
    if (dto.message && !record.message.includes(dto.message)) return false;
    if (dto.method && record.meta?.method !== dto.method) return false;
    if (dto.path && !String(record.meta?.path ?? '').includes(dto.path)) return false;
    if (dto.statusCode && Number(record.meta?.statusCode) !== dto.statusCode) return false;

    return true;
  }

  private encodeCursor(cursor: LogQueryCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  /**
   * 解码游标字符串（Base64URL 解码）。
   * 验证游标格式的正确性。
   * @param cursor 编码后的游标字符串
   * @returns 解码后的游标对象
   * @throws BadRequestException 游标无效时抛出
   */
  private decodeCursor(cursor: string): LogQueryCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as LogQueryCursor;

      if (!parsed.file || !parsed.line || !['asc', 'desc'].includes(parsed.order)) {
        throw new Error('Invalid cursor');
      }

      return parsed;
    } catch {
      throw new BadRequestException('cursor 无效');
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
