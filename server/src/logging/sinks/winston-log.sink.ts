import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import winston from 'winston';
import 'winston-daily-rotate-file';

import type { LogLevel, LogRecord } from '../interfaces/log-record.interface';
import type { LogSink } from './log-sink.interface';

const LEVEL_MAP: Record<LogLevel, string> = {
  fatal: 'error',
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
};

@Injectable()
export class WinstonLogSink implements LogSink {
  private readonly logger: winston.Logger;

  /**
   * 初始化 Winston 日志输出通道。
   * 根据配置创建 Winston Logger 实例，配置控制台和每日滚动文件两种传输通道。
   * @param configService 配置服务
   */
  constructor(private readonly configService: ConfigService) {
    const logDir = this.configService.get<string>('log.dir', 'logs');
    // 与 AppLoggerService 保持同一套级别：DEBUG=false 时为 log.effectiveLevel（默认 warn）
    const logLevel = this.configService.get<string>(
      'log.effectiveLevel',
      this.configService.get<string>('log.level', 'info'),
    );
    const maxFileSize = this.configService.get<number>('log.maxFileSizeMb', 20);
    const retentionDays = this.configService.get<number>('log.retentionDays', 30);
    const consoleEnabled = this.configService.get<boolean>('log.consoleEnabled', true);
    const fileEnabled = this.configService.get<boolean>('log.fileEnabled', true);

    const transports: winston.transport[] = [];

    if (consoleEnabled) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, category, ...rest }) => {
              const meta = rest.meta ? ` ${JSON.stringify(rest.meta)}` : '';
              return `${timestamp} [${level}] [${category ?? '-'}] ${message}${meta}`;
            }),
          ),
        }),
      );
    }

    if (fileEnabled) {
      transports.push(
        new winston.transports.DailyRotateFile({
          dirname: logDir,
          filename: '%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: `${maxFileSize}m`,
          maxFiles: String(retentionDays),
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.json(),
          ),
        }),
      );
    }

    this.logger = winston.createLogger({
      level: logLevel,
      transports,
    });
  }

  /**
   * 将日志记录通过 Winston 写入。
   * 将内部日志级别映射为 Winston 级别，并附带结构化元数据。
   * @param record 日志记录
   * @returns 空 Promise
   */
  write(record: LogRecord): Promise<void> {
    const winstonLevel = LEVEL_MAP[record.level] ?? 'info';

    this.logger.log(winstonLevel, record.message, {
      category: record.category,
      service: record.service,
      env: record.env,
      requestId: record.requestId,
      traceId: record.traceId,
      source: record.source,
      meta: record.meta,
    });

    return Promise.resolve();
  }
}
