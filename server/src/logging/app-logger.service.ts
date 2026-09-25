import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { LogLevel, LogRecord, WriteLogOptions } from './interfaces/log-record.interface';
import { ConsoleLogSink } from './sinks/console-log.sink';
import { FileLogSink } from './sinks/file-log.sink';
import type { LogSink } from './sinks/log-sink.interface';
import { WinstonLogSink } from './sinks/winston-log.sink';

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

@Injectable()
export class AppLoggerService {
  private readonly service: string;
  private readonly env: string;
  private readonly minLevel: LogLevel;
  private readonly sinks: LogSink[];

  /**
   * 初始化应用日志记录器。
   * 从配置中读取服务名称、环境、最低日志级别，并根据配置启用对应的日志输出通道。
   * @param configService 配置服务
   * @param consoleLogSink 控制台日志输出通道
   * @param fileLogSink 文件日志输出通道
   * @param winstonLogSink Winston 日志输出通道
   */
  constructor(
    private readonly configService: ConfigService,
    consoleLogSink: ConsoleLogSink,
    fileLogSink: FileLogSink,
    winstonLogSink: WinstonLogSink,
  ) {
    this.service = this.configService.get<string>('app.name', 'nextjs-server');
    this.env = this.configService.get<string>('app.env', 'development');
    // 有效最低级别：DEBUG=false 时由 log.effectiveLevel 收敛为 warn，只落 fatal/error/warn
    this.minLevel = this.configService.get<LogLevel>(
      'log.effectiveLevel',
      this.configService.get<LogLevel>('log.level', 'info'),
    );
    this.sinks = [
      ...(this.configService.get<boolean>('log.consoleEnabled', true) ? [consoleLogSink] : []),
      ...(this.configService.get<boolean>('log.fileEnabled', true) ? [fileLogSink] : []),
      winstonLogSink,
    ];
  }

  fatal(options: WriteLogOptions): void {
    this.write('fatal', options);
  }

  error(options: WriteLogOptions): void {
    this.write('error', options);
  }

  warn(options: WriteLogOptions): void {
    this.write('warn', options);
  }

  info(options: WriteLogOptions): void {
    this.write('info', options);
  }

  debug(options: WriteLogOptions): void {
    this.write('debug', options);
  }

  /**
   * 写入日志记录。
   * 根据日志级别判断是否写入，构造日志记录对象并通过所有已启用的输出通道写入。
   * @param level 日志级别
   * @param options 日志写入选项
   */
  private write(level: LogLevel, options: WriteLogOptions): void {
    if (!this.shouldWrite(level)) {
      return;
    }

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      category: options.category,
      message: options.message,
      service: this.service,
      env: this.env,
      requestId: options.requestId,
      traceId: options.traceId,
      source: options.source,
      meta: options.meta,
    };

    for (const sink of this.sinks) {
      Promise.resolve(sink.write(record)).catch(() => undefined);
    }
  }

  private shouldWrite(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHT[level] <= LOG_LEVEL_WEIGHT[this.minLevel];
  }
}
