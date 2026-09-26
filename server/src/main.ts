import 'reflect-metadata';
// 必须排在 ./app.module 之前：先快照原始 NODE_ENV，避免被 .env 文件注入值污染
import { originalNodeEnv } from './common/utils/startup-env';
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
import { createHash, timingSafeEqual } from 'node:crypto';

import { AppModule } from './app.module';
import { AppLoggerService } from './logging/app-logger.service';
import { HttpExceptionsFilter } from './common/filters/http-exceptions.filter';

/** 重启保护：时间窗口内最大异常重启次数 */
const MAX_RESTARTS_IN_WINDOW = 10;
const RESTART_WINDOW_MS = 60_000;
/** 优雅关闭：等待工作进程退出的超时时间 */
const SHUTDOWN_TIMEOUT_MS = 3_000;
/** 请求体大小上限（JSON / urlencoded） */
const BODY_LIMIT = '20mb';
/** 静态资源缓存时长（1 年；仅对带 hash 的文件名安全） */
const STATIC_CACHE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** 访问频率限制：窗口 15 分钟、窗口内最多 1000 次 */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 1_000;
/** 启动失败后等待日志落盘的最长时间（超过即退出，避免启动失败时进程挂住） */
const FATAL_LOG_FLUSH_TIMEOUT_MS = 500;
/** 生产环境 JWT 密钥的最小长度（自检告警用） */
const MIN_JWT_SECRET_LENGTH = 32;
/** 明显的占位式密钥特征（自检告警用，不打印密钥本身） */
const PLACEHOLDER_SECRET_PATTERN = /change[_-]?me|placeholder|your[_-]?secret|example|123456/i;

/** 是否启用集群模式（Windows 不支持集群） */
const shouldUseCluster = process.platform !== 'win32' && !process.env.NO_CLUSTER;

/** 是否为 Bun 运行时（Bun 会自动加载 .env.local / .env.<NODE_ENV>.local，node 下不会） */
const isBunRuntime = Boolean((process.versions as { bun?: string }).bun);

interface EnvFileInfo {
  /** 文件名，如 .env.production */
  file: string;
  /** 绝对路径 */
  fullPath: string;
}

/**
 * 应用实际加载的配置文件候选，必须与 AppModule 中 ConfigModule 的
 * envFilePath: [`.env.${nodeEnv}`, '.env'] 保持一致（相对 cwd，靠前者优先）。
 * @param nodeEnv 当前运行环境名
 */
function envFileCandidates(nodeEnv: string): string[] {
  return [`.env.${nodeEnv}`, '.env'];
}

/**
 * Bun 运行时会额外自动加载的配置文件，优先级高于 envFileCandidates（node 下不读取）。
 * 生产环境若残留这些文件，会出现"bun 与 node 跑出来的配置不一致"的问题。
 * @param nodeEnv 当前运行环境名
 */
function bunOnlyEnvFileCandidates(nodeEnv: string): string[] {
  return ['.env.local', `.env.${nodeEnv}.local`];
}

/**
 * 按相对 cwd 解析候选配置文件，仅返回真实存在的项（与 dotenv 的解析方式一致）。
 * @param candidates 候选文件名数组
 */
function resolveEnvFiles(candidates: string[]): EnvFileInfo[] {
  return candidates
    .map((file) => ({ file, fullPath: path.join(process.cwd(), file) }))
    .filter((item) => existsSync(item.fullPath));
}

/**
 * 计算 SHA-256 摘要。
 * 用于 Basic Auth 等长比较：摘要固定 32 字节，既能满足 timingSafeEqual 的等长要求，
 * 又避免"逐字符比较"带来的时序侧信道。
 * @param value 原始字符串
 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 解析反向代理信任配置（express 的 trust proxy 支持数字/布尔/命名值三类形态）。
 * @param value 配置值（来自 TRUST_PROXY，默认 '1'）
 * @returns 数字层数、布尔值或命名值（'loopback' 等原样返回）
 */
function parseTrustProxy(value: string | number): number | boolean | string {
  if (typeof value === 'number') {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return 1;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  return trimmed;
}

type CorsMode = 'off' | 'all' | 'open' | 'list';

/**
 * 向工作进程发送信号。
 * 优先使用 cluster 文档化的 `worker.kill()`：它在主进程中会先断开 IPC（停止向该 worker 派发新连接）
 * 再发送信号，关闭更平滑；Bun 等运行时缺少该方法时回退为直接对子进程发信号。
 * 所有分支自行兜底，避免在关闭流程中抛出异常导致主进程带未捕获异常退出。
 * @param worker 目标工作进程
 * @param signal 信号
 */
function signalWorker(worker: cluster.Worker | undefined, signal: NodeJS.Signals): void {
  if (!worker || worker.isDead?.()) {
    return;
  }

  try {
    if (typeof worker.kill === 'function') {
      worker.kill(signal);
    } else {
      worker.process.kill(signal);
    }
  } catch {
    try {
      worker.process?.kill(signal);
    } catch {
      // 进程可能已退出，忽略
    }
  }
}

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

    /** 配置自检统一告警出口：控制台 + 结构化日志双写 */
    const warnConfig = (message: string) => {
      fallbackLogger.warn(message);
      appLogger?.warn({ category: 'system.config', message, source: 'bootstrap' });
    };

    // 未显式配置 READONLY_MODE 时提示迁移（当前只读判定仍依赖 DEBUG 兼容回落）
    if (readonlySource !== 'READONLY_MODE') {
      warnConfig(
        '未配置 READONLY_MODE，只读模式按兼容规则回落为 DEBUG=false 推导；建议显式设置 READONLY_MODE=true/false 解除耦合',
      );
    }

    // 实际生效的配置文件（与 ConfigModule 一致：相对 cwd 解析，靠前者优先级更高）
    const envFiles = resolveEnvFiles(envFileCandidates(env));
    // Bun 额外自动加载的覆盖文件（优先级高于上面两个，node 运行时不读取）
    const bunEnvFiles = isBunRuntime ? resolveEnvFiles(bunOnlyEnvFileCandidates(env)) : [];
    const envFilesText = envFiles.length
      ? envFiles.map((item) => item.file).join(' > ')
      : '未找到（使用代码默认值 + 进程环境变量）';

    // 环境配置自检：NODE_ENV 缺失 / 生产缺少 .env.production / Bun 额外文件覆盖，都是"配置混乱"的常见来源
    if (!originalNodeEnv) {
      warnConfig(
        `未设置 NODE_ENV，当前按 ${env} 处理，将加载 .env.${env} 与 .env；生产环境请显式设置 NODE_ENV=production`,
      );
    } else if (env === 'production' && !existsSync(path.join(process.cwd(), '.env.production'))) {
      warnConfig(
        `NODE_ENV=production 但未找到 ${path.join(process.cwd(), '.env.production')}，将只使用 .env 与进程环境变量；请确认配置文件放在启动目录下`,
      );
    }
    if (bunEnvFiles.length) {
      warnConfig(
        `Bun 运行时会额外加载 ${bunEnvFiles.map((item) => item.file).join(' > ')}，其优先级高于 ${envFilesText}；如非本意请删除（node 运行时不读取这些文件）`,
      );
    }

    // 生产密钥自检：只告警不阻断，避免影响既有部署；密钥本身不写入日志
    const jwtSecret = configService.get<string>('jwt.secret', '');
    if (
      env === 'production' &&
      (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH || PLACEHOLDER_SECRET_PATTERN.test(jwtSecret))
    ) {
      warnConfig(
        `生产环境 JWT_SECRET 疑似未设置为强随机值（当前长度 ${jwtSecret.length}，要求 ≥ ${MIN_JWT_SECRET_LENGTH} 位且不含占位符），存在令牌伪造风险`,
      );
    }

    // 信任反向代理，正确获取客户端真实 IP（TRUST_PROXY，默认信任 1 层，保持历史行为）
    app.set('trust proxy', parseTrustProxy(configService.get<string | number>('proxy.trust', 1)));

    // Windows 下 SIGTERM/SIGINT 不可用，跳过 shutdown hooks
    if (process.platform !== 'win32') {
      app.enableShutdownHooks();
    }

    // Body 大小限制
    app.use(express.json({ limit: BODY_LIMIT }));
    app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

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

    // CORS 配置（生产环境对 all/open 做自检告警：会接受任意来源）
    const corsMode = configService.get<CorsMode>('cors.mode', 'off');
    if (env === 'production' && (corsMode === 'all' || corsMode === 'open')) {
      warnConfig('生产环境 CORS_MODE 为 all/open，将接受任意来源请求，存在跨域数据泄露/CSRF 风险');
    }
    configureCors(app, configService);

    // 静态文件目录
    const uploadDir = configService.get<string>('file.uploadDir', '../upload');
    const uploadPath = path.resolve(process.cwd(), uploadDir);
    const serveRoot = configService.get<string>('file.serveRoot', '/profile');

    app.useStaticAssets(uploadPath, {
      prefix: serveRoot,
      maxAge: STATIC_CACHE_MAX_AGE_MS,
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
      // 仅对带 hash 的静态文件安全（index.html 由下方回退逻辑单独处理）
      maxAge: STATIC_CACHE_MAX_AGE_MS,
    });
    // SPA 路由回退：非 API 路径且非带扩展名的静态文件 => 返回 index.html
    const indexHtmlPath = path.join(webDistPath, 'index.html');
    // 启动时判定一次，避免每个 SPA 请求都做同步 stat；未构建前端时直接交给后续 404 处理
    const hasWebIndex = existsSync(indexHtmlPath);
    // 放行前缀：API/业务域 + 静态资源挂载前缀（静态前缀随配置变化，不能写死）
    const staticAssetPrefixes = [serveRoot, '/public/', '/api-test/']
      .filter((prefix) => Boolean(prefix) && prefix !== '/')
      .map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`));
    const spaBypassPrefixes = ['/api/', ...staticAssetPrefixes, '/image/', '/llm/', '/ws/'];

    app.use((req, res, next) => {
      if (spaBypassPrefixes.some((prefix) => req.path.startsWith(prefix))) {
        return next();
      }
      // 带文件扩展名的请求放行（静态文件已由上方 useStaticAssets 处理）
      if (/\.[a-zA-Z0-9]{2,8}$/.test(req.path)) {
        return next();
      }
      if (!hasWebIndex) {
        return next();
      }
      res.sendFile(indexHtmlPath, (err: Error) => {
        // 响应已开始/已结束时不能再改写状态码，避免二次发送头部报错
        if (err && !res.headersSent) {
          res.status(404).send('Not Found');
        }
      });
    });

    // 访问频率限制：窗口与上限见顶部常量
    app.use(
      rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX,
      }),
    );

    // Web 安全防护
    const cspEnabled = configService.get<boolean>('security.cspEnabled', false);
    app.use(
      helmet({
        crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
        crossOriginResourcePolicy: false,
        // CSP 默认关闭（保持既有行为）：Swagger UI 与 /api-test/ 页面依赖内联脚本/样式，
        // 误开会导致白屏；SECURITY_CSP_ENABLED=true 时启用下面这套"同源 + 允许内联"的最小策略
        contentSecurityPolicy: cspEnabled
          ? {
              directives: {
                defaultSrc: ["'self'"],
                // Swagger UI / api-test 使用内联脚本与样式，去掉 unsafe-inline 需先改造这些页面
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                // 头像/附件可能来自 FILE_DOMAIN，故放行 https: 与 data:/blob:
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                fontSrc: ["'self'", 'data:'],
                // AI 对话走 WebSocket（与 HTTP 同端口）
                connectSrc: ["'self'", 'ws:', 'wss:'],
                objectSrc: ["'none'"],
                frameAncestors: ["'self'"],
              },
            }
          : false,
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
      const openApiExportEnabled = configService.get<boolean>('swagger.openApiExportEnabled', true);
      const openApiExportDir = configService.get<string>('swagger.openApiExportDir', 'public');
      if (shouldWriteOpenApi && openApiExportEnabled) {
        // 导出目录可配置：默认 public（对外可访问，供 /api-test/ 工具加载）；
        // 不希望暴露 API 结构时改为非静态目录（如 temp）
        const exportDir = path.resolve(process.cwd(), openApiExportDir);
        if (!existsSync(exportDir)) {
          mkdirSync(exportDir, { recursive: true });
        }
        writeFileSync(path.join(exportDir, 'openApi.json'), JSON.stringify(document, null, 2));
      }

      // Swagger Basic Auth 保护
      if (swaggerUsername && swaggerPassword) {
        const swaggerPath = `/${displayPrefix}/swagger-ui`;
        // 预计算期望摘要：等长（32 字节）比较，避免逐字符比较泄露字符与长度信息
        const expectedUsernameDigest = sha256(swaggerUsername);
        const expectedPasswordDigest = sha256(swaggerPassword);
        app.use((req, res, next) => {
          if (!req.path.startsWith(swaggerPath)) {
            return next();
          }
          const authHeader = req.headers['authorization'];
          if (authHeader && authHeader.startsWith('Basic ')) {
            const base64 = authHeader.slice(6);
            const decoded = Buffer.from(base64, 'base64').toString('utf-8');
            // 密码允许包含 ':'，只在第一个冒号处切分
            const separatorIndex = decoded.indexOf(':');
            const username = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
            const password = separatorIndex === -1 ? '' : decoded.slice(separatorIndex + 1);
            const usernameMatched = timingSafeEqual(sha256(username), expectedUsernameDigest);
            const passwordMatched = timingSafeEqual(sha256(password), expectedPasswordDigest);

            if (usernameMatched && passwordMatched) {
              return next();
            }
          }
          res.setHeader('WWW-Authenticate', 'Basic realm="Swagger UI", charset="UTF-8"');
          res.status(401).send('需要认证才能访问 Swagger 文档');
          // 已终结响应，不能再 next()，否则下游会二次写响应触发 ERR_HTTP_HEADERS_SENT
          return;
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
        /** 运行模式来源：进程启动时的 NODE_ENV（显式）或默认值 */
        nodeEnvSource: originalNodeEnv ? `NODE_ENV=${originalNodeEnv}` : 'default(未设置 NODE_ENV)',
        /** 实际生效的配置文件（按优先级从高到低） */
        envFiles: envFiles.map((item) => item.file),
        /** Bun 额外自动加载并覆盖的配置文件 */
        bunOnlyEnvFiles: bunEnvFiles.map((item) => item.file),
        /** 启动工作目录，env 文件与 logs/upload 均相对它解析 */
        cwd: process.cwd(),
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
        '\n',
        `  当前配置文件: ${envFilesText}`,
        '\n',
        `  配置文件目录: ${process.cwd()}`,
        ...(bunEnvFiles.length
          ? [
              '\n',
              `  额外配置文件(Bun): ${bunEnvFiles.map((item) => item.file).join(' > ')}  (优先级更高，node 运行时不加载)`,
            ]
          : []),
        '\n',
        `  当前运行模式: ${env}  [${originalNodeEnv ? `NODE_ENV=${originalNodeEnv}` : '未设置 NODE_ENV，按默认值 development 处理'}]`,
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
    // 先有界等待日志落盘再退出：文件 sink 是异步写入，直接 process.exit 会丢掉上面的 fatal 记录；
    // 用超时兜底，避免 sink 异常导致启动失败时进程挂住
    await Promise.race([
      appLogger?.flush() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, FATAL_LOG_FLUSH_TIMEOUT_MS)),
    ]);
    process.exit(1);
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
        signalWorker(worker, 'SIGTERM');
      }

      shutdownTimer = setTimeout(() => {
        console.warn(`工作进程未在 ${SHUTDOWN_TIMEOUT_MS / 1000}s 内退出，强制关闭`);
        for (const worker of Object.values(cluster.workers ?? {})) {
          signalWorker(worker, 'SIGKILL');
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
