import 'reflect-metadata';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { mw as requestIpMw } from 'request-ip';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import * as express from 'express';
import cluster from 'node:cluster';
import os from 'node:os';
import path from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

import { AppModule } from './app.module';
import { AppLoggerService } from './logging/app-logger.service';
import { HttpExceptionsFilter } from './common/filters/http-exceptions.filter';

/** 重启保护：时间窗口内最大异常重启次数 */
const MAX_RESTARTS_IN_WINDOW = 10;
const RESTART_WINDOW_MS = 60_000;
/** 优雅关闭：等待工作进程退出的超时时间 */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** 是否启用集群模式（Windows 不支持集群） */
const shouldUseCluster = process.platform !== 'win32' && !process.env.NO_CLUSTER;

type CorsMode = 'off' | 'all' | 'open' | 'list';

function configureCors(app: INestApplication, configService: ConfigService): void {
  const mode = configService.get<CorsMode>('cors.mode', 'off');
  const origins = configService.get<string[]>('cors.origins', []);
  const credentials = configService.get<boolean>('cors.credentials', false);
  const commonOptions = {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials,
  };

  if (mode === 'off') {
    return;
  }

  if (mode === 'all' || mode === 'open') {
    app.enableCors({ ...commonOptions, origin: true });
    return;
  }

  app.enableCors({ ...commonOptions, origin: origins });
}

async function bootstrap(): Promise<void> {
  const fallbackLogger = new Logger('Bootstrap');
  let appLogger: AppLoggerService | undefined;

  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      rawBody: true,
    });
    app.useWebSocketAdapter(new WsAdapter(app));

    const configService = app.get(ConfigService);
    appLogger = app.get(AppLoggerService);

    const appName = configService.get<string>('app.name', 'nextjs-server');
    const env = configService.get<string>('app.env', 'development');
    const port = configService.get<number>('app.port', 3000);
    const globalPrefix = configService.get<string>('app.apiPrefix', '');
    const displayPrefix = 'api';
    const readonlyMode = configService.get<boolean>('app.readonly', false);
    const readonlySource = configService.get<string>('app.readonlySource', 'READONLY_MODE');
    const debugEnabled = configService.get<boolean>('app.debug', false);

    // 未显式配置 READONLY_MODE 时提示迁移（当前只读判定仍依赖 DEBUG 兼容回落）
    if (readonlySource !== 'READONLY_MODE') {
      const tip =
        '未配置 READONLY_MODE，只读模式按兼容规则回落为 DEBUG=false 推导；建议显式设置 READONLY_MODE=true/false 解除耦合';
      fallbackLogger.warn(tip);
      appLogger?.warn({ category: 'system.config', message: tip, source: 'bootstrap' });
    }

    // 信任反向代理，正确获取客户端真实 IP
    app.set('trust proxy', 1);

    // Windows 下 SIGTERM/SIGINT 不可用，跳过 shutdown hooks
    if (process.platform !== 'win32') {
      app.enableShutdownHooks();
    }

    // Body 大小限制
    app.use(express.json({ limit: '20mb' }));
    app.use(express.urlencoded({ extended: true, limit: '20mb' }));

    // Gzip 压缩（SSE 流式响应不压缩，避免长时间思考阶段被缓冲导致前端断流）
    app.use(
      compression({
        filter: (req, res) => {
          const ct = res.getHeader('Content-Type');
          if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
          return compression.filter(req, res);
        },
      }),
    );

    // 设置全局前缀
    app.setGlobalPrefix(globalPrefix);

    // CORS 配置
    configureCors(app, configService);

    // 静态文件目录
    const uploadDir = configService.get<string>('file.uploadDir', '../upload');
    const uploadPath = path.resolve(process.cwd(), uploadDir);
    const serveRoot = configService.get<string>('file.serveRoot', '/profile');

    app.useStaticAssets(uploadPath, {
      prefix: serveRoot,
      maxAge: 86400000 * 365, // 1 年缓存
    });
    app.useStaticAssets(path.resolve(process.cwd(), 'public'), {
      prefix: '/public/',
      maxAge: 0,
    });
    app.useStaticAssets(path.resolve(process.cwd(), 'api_test_web'), {
      prefix: '/api-test/',
      maxAge: 0,
    });

    // 前端 SPA 静态文件根目录（需先构建 web 项目）
    const webDistPath = path.resolve(process.cwd(), '../web/dist');
    app.useStaticAssets(webDistPath, {
      maxAge: 86400000 * 365, // 1 年缓存（仅对带有 hash 的静态文件生效）
    });
    // SPA 路由回退：非 API 路径且非带扩展名的静态文件 => 返回 index.html
    app.use((req, res, next) => {
      if (
        req.path.startsWith('/api/') ||
        req.path.startsWith('/profile/') ||
        req.path.startsWith('/public/') ||
        req.path.startsWith('/api-test/')
      ) {
        return next();
      }
      // 带文件扩展名的请求放行（静态文件已由上方 useStaticAssets 处理）
      if (/\.[a-zA-Z0-9]{2,8}$/.test(req.path)) {
        return next();
      }
      res.sendFile(path.join(webDistPath, 'index.html'), (err: Error) => {
        if (err) {
          res.status(404).send('Not Found');
        }
      });
    });

    // 访问频率限制：15 分钟内最多 1000 次
    app.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
      }),
    );

    // Web 安全防护
    app.use(
      helmet({
        crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
        crossOriginResourcePolicy: false,
        contentSecurityPolicy: false,
      }),
    );

    // 全局管道和过滤器
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionsFilter());

    // 获取真实 IP
    app.use(requestIpMw({ attributeName: 'ip' }));

    // Swagger 文档
    const swaggerEnabled = configService.get<boolean>('swagger.enabled', false);
    if (swaggerEnabled) {
      const swaggerTitle = configService.get<string>('swagger.title', 'FssAdmin');
      const swaggerDescription = configService.get<string>(
        'swagger.description',
        'FssAdmin API 文档',
      );
      const swaggerVersion = configService.get<string>('swagger.version', '1.0.0');
      const swaggerUsername = configService.get<string>('swagger.username', '');
      const swaggerPassword = configService.get<string>('swagger.password', '');

      const swaggerOptions = new DocumentBuilder()
        .setTitle(swaggerTitle)
        .setDescription(swaggerDescription)
        .setVersion(swaggerVersion)
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            in: 'header',
            name: 'Authorization',
            description: '请在请求头中携带 JWT 令牌，格式：Bearer <token>',
          },
          'Authorization',
        )
        .build();

      const document = SwaggerModule.createDocument(app, swaggerOptions);

      // 写入 OpenAPI JSON（仅首个工作进程执行，避免多进程竞态）
      const shouldWriteOpenApi = !shouldUseCluster || (cluster.worker?.id ?? 0) === 1;
      if (shouldWriteOpenApi) {
        const publicDir = path.join(process.cwd(), 'public');
        if (!existsSync(publicDir)) {
          mkdirSync(publicDir, { recursive: true });
        }
        writeFileSync(path.join(publicDir, 'openApi.json'), JSON.stringify(document, null, 2));
      }

      // Swagger Basic Auth 保护
      if (swaggerUsername && swaggerPassword) {
        const swaggerPath = `/${displayPrefix}/swagger-ui`;
        app.use((req, res, next) => {
          if (!req.path.startsWith(swaggerPath)) {
            return next();
          }
          const authHeader = req.headers['authorization'];
          if (authHeader && authHeader.startsWith('Basic ')) {
            const base64 = authHeader.slice(6);
            const decoded = Buffer.from(base64, 'base64').toString('utf-8');
            const [username, password] = decoded.split(':');
            if (username === swaggerUsername && password === swaggerPassword) {
              return next();
            }
          }
          res.setHeader('WWW-Authenticate', 'Basic realm="Swagger UI", charset="UTF-8"');
          res.status(401).send('需要认证才能访问 Swagger 文档');
        });
      }

      SwaggerModule.setup(`${displayPrefix}/swagger-ui`, app, document, {
        swaggerOptions: {
          persistAuthorization: true,
        },
        customSiteTitle: swaggerTitle,
      });
    }

    //await app.listen(port);
    await app.listen(port, '0.0.0.0');

    const wsPath = '/ws/ai';
    const wsUrl = `ws://localhost:${port}${wsPath}`;

    appLogger?.info({
      category: 'system.startup',
      message: '服务启动成功',
      source: 'bootstrap',
      meta: {
        appName,
        env,
        port,
        displayPrefix,
        readonly: readonlyMode,
        readonlySource,
        debug: debugEnabled,
        workerId: shouldUseCluster ? cluster.worker?.id : undefined,
        pid: process.pid,
        url: `http://localhost:${port}/${displayPrefix}`,
        websocket: { path: wsPath, url: wsUrl, note: '与 HTTP 共用端口，WsAdapter 自动挂载' },
      },
    });

    // 仅首个工作进程或单进程输出启动摘要
    const isClusterWorker = shouldUseCluster && !cluster.isPrimary;
    if (!isClusterWorker || (cluster.worker?.id ?? 0) === 1) {
      console.log(
        `${appName} 服务启动成功`,
        '\n',
        `  服务地址: http://localhost:${port}/${displayPrefix}/`,
        '\n',
        `  Swagger: http://localhost:${port}/${displayPrefix}/swagger-ui/`,
        '\n',
        `  WebSocket: ${wsUrl}  (与 HTTP 同端口，无需单独启动)`,
        '\n',
        `  运行模式: ${readonlyMode ? '只读(演示) —— 禁止写操作' : '正常(可读写)'}  [来源: ${readonlySource}]`,
        '\n',
        `  调试模式: ${debugEnabled ? '开(日志级别=LOG_LEVEL)' : '关(日志级别=LOG_PROD_LEVEL)'}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    appLogger?.fatal({
      category: 'system.lifecycle',
      message: '服务启动失败',
      source: 'bootstrap',
      meta: { error: message },
    });
    fallbackLogger.error(`服务启动失败：${message}`);
    setTimeout(() => process.exit(1), 100);
  }
}

// ── 集群 / 单进程启动 ──────────────────────────────────────────
if (shouldUseCluster) {
  if (cluster.isPrimary) {
    const cpuCount = Number(process.env.WEB_CONCURRENCY) || os.cpus().length;
    let isShuttingDown = false;
    const restartTimestamps: number[] = [];
    let shutdownTimer: NodeJS.Timeout | null = null;

    console.log(`主进程 PID:${process.pid}，工作进程数:${cpuCount}，开始创建子进程`);

    for (let i = 0; i < cpuCount; i++) {
      cluster.fork();
    }

    const clearShutdownTimer = () => {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
    };

    const shutdown = (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      clearShutdownTimer();

      const workers = Object.values(cluster.workers ?? {}).filter(Boolean);
      console.log(`主进程收到 ${signal}，正在关闭 ${workers.length} 个工作进程...`);

      if (workers.length === 0) {
        process.exit(0);
        return;
      }

      for (const worker of workers) {
        try {
          worker?.process.kill('SIGTERM');
        } catch {
          worker?.kill();
        }
      }

      shutdownTimer = setTimeout(() => {
        console.warn(`工作进程未在 ${SHUTDOWN_TIMEOUT_MS / 1000}s 内退出，强制关闭`);
        for (const worker of Object.values(cluster.workers ?? {})) {
          try {
            worker?.process.kill('SIGKILL');
          } catch {
            worker?.kill();
          }
        }
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      shutdownTimer.unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    cluster.on('exit', (worker, code, signal) => {
      if (isShuttingDown) {
        const remaining = Object.keys(cluster.workers ?? {}).length;
        if (remaining === 0) {
          clearShutdownTimer();
          console.log('所有工作进程已退出，主进程关闭');
          process.exit(0);
        }
        return;
      }

      // 正常退出不自动重启
      if (code === 0 && !signal) {
        console.log(`工作进程 ${worker.process.pid} 正常退出，不重启`);
        return;
      }

      const now = Date.now();
      restartTimestamps.push(now);
      while (restartTimestamps.length > 0 && restartTimestamps[0] < now - RESTART_WINDOW_MS) {
        restartTimestamps.shift();
      }

      if (restartTimestamps.length >= MAX_RESTARTS_IN_WINDOW) {
        console.error(
          `工作进程在 ${RESTART_WINDOW_MS / 1000}s 内异常退出 ${MAX_RESTARTS_IN_WINDOW} 次，停止自动重启`,
        );
        process.exit(1);
        return;
      }

      console.warn(
        `工作进程 ${worker.process.pid} 异常退出，code:${code}, signal:${signal}，正在重启... (${restartTimestamps.length}/${MAX_RESTARTS_IN_WINDOW})`,
      );
      cluster.fork();
    });
  } else {
    bootstrap().catch((err) => {
      console.error(`工作进程 ${process.pid} 启动失败:`, err);
      process.exit(1);
    });
  }
} else {
  console.log(`启动模式: 单进程 (platform=${process.platform}, PID=${process.pid})`);
  bootstrap().catch((err) => {
    console.error(`服务启动失败:`, err);
    process.exit(1);
  });
}
