/**
 * 解析三态布尔环境变量。
 * 未设置（undefined 或空串）返回 undefined，用于区分"显式配置"与"未配置"。
 * @param value 原始环境变量值
 */
const parseEnvFlag = (value: string | undefined): boolean | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }

  return String(value).toLowerCase() !== 'false';
};

/**
 * 解析二元布尔环境变量：未设置时返回 fallback。
 * @param value 原始环境变量值
 * @param fallback 未设置时的回退值
 */
const readBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  return parseEnvFlag(value) ?? fallback;
};

const routerWhitelist = [
  { path: '/api/core/captcha', method: 'GET' },
  { path: '/api/core/login', method: 'POST' },
  { path: '/api/core/logout', method: 'POST' },
  { path: '/api/core/refresh', method: 'POST' },
  { path: '/api/core/register', method: 'POST' },
  { path: '/api/core/registerUser', method: 'GET' },
  { path: '/api/core/tenants-by-username', method: 'GET' },
  { path: '/api/core/config/public/:key', method: 'GET' },
  { path: '/api/system/user/export', method: 'POST' },
  { path: '/api/system/role/export', method: 'POST' },
  { path: '/api/system/post/export', method: 'POST' },
  { path: '/api/system/dept/export', method: 'POST' },
  { path: '/api/system/config/export', method: 'POST' },
  { path: '/api/system/dict/type/export', method: 'POST' },
  { path: '/api/system/dict/data/export', method: 'POST' },
  { path: '/api/monitor/loginlog/export', method: 'POST' },
  { path: '/api/monitor/operlog/export', method: 'POST' },
  { path: '/api/monitor/online/export', method: 'POST' },
  { path: '/api/health', method: 'GET' },
  { path: '/api/log/query', method: 'GET' },
];

export default () => {
  /**
   * 调试模式：仅控制日志级别（LOG_LEVEL / LOG_PROD_LEVEL）与自动堆快照默认值，
   * 不再表示只读模式（只读由 READONLY_MODE 控制，见下）。
   */
  const debugEnabled = process.env.DEBUG !== 'false';

  const readonlyExplicit = parseEnvFlag(process.env.READONLY_MODE);

  /**
   * 只读/演示模式（禁止写操作）：
   * - 显式配置 READONLY_MODE 时以它为准，与 DEBUG 完全解耦；
   * - 未配置时兼容旧语义：DEBUG=false → 只读，避免升级后意外放开生产写权限。
   */
  const readonlyEnabled = readonlyExplicit ?? !debugEnabled;

  /** 只读模式的判定来源，用于启动日志提示迁移 */
  const readonlySource = readonlyExplicit === undefined ? 'DEBUG(兼容回落)' : 'READONLY_MODE';

  const isBunRuntime = !!(process.versions as { bun?: string }).bun;

  /**
   * Bun 下是否启用内存监控检查（阈值判定 + 自动堆快照 + RSS 致命判定）。
   * Bun 使用 JavaScriptCore，内存口径与 Node 不同（早期版本 v8 API 不准确且阻塞），
   * 因此默认关闭；显式开启后启用下面这套更保守的 Bun 默认阈值。
   */
  const bunMonitorEnabled = readBooleanEnv(process.env.MEMORY_BUN_MONITOR_ENABLED, false);

  return {
    app: {
      name: process.env.APP_NAME ?? 'nextjs-server',
      env: process.env.NODE_ENV ?? 'development',
      port: Number(process.env.APP_PORT ?? 3000),
      apiPrefix: process.env.APP_API_PREFIX ?? '',
      /** 调试模式：控制日志级别与自动堆快照默认值，不再表示只读 */
      debug: debugEnabled,
      /** 只读/演示模式：禁止写操作（READONLY_MODE 优先，未配置时兼容回落为 DEBUG=false） */
      readonly: readonlyEnabled,
      /** 只读模式的判定来源，用于启动日志提示迁移 */
      readonlySource,
    },
    database: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USERNAME ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      name: process.env.DB_NAME ?? 'nestjs',
      synchronize: process.env.DB_SYNC === 'true',
      logging: process.env.DB_LOGGING === 'true',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? '',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
    },
    redis: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
    },
    cors: {
      mode: process.env.CORS_MODE ?? 'off',
      origins: (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      credentials: process.env.CORS_CREDENTIALS === 'true',
    },
    security: {
      /**
       * 是否启用 Content-Security-Policy（默认关闭）。
       * Swagger UI 与 /api-test/ 页面依赖内联脚本/样式，误开会导致页面白屏，
       * 因此默认保持既有行为，需要时显式开启并按前端实际情况调整策略。
       */
      cspEnabled: process.env.SECURITY_CSP_ENABLED === 'true',
    },
    /**
     * 反向代理信任配置（对应 express 的 trust proxy）。
     * 决定 -X-Forwarded-For 取第几跳作为客户端真实 IP，配置不当会导致限流/日志拿到代理 IP。
     */
    proxy: {
      /**
       * 默认 '1'（信任 1 层代理），与历史行为一致；可按部署形态调整：
       * - 层数：'2'、'3'
       * - 命名值：'loopback' / 'linklocal' / 'uniquelocal'
       * - 布尔：'true'（信任全部，仅在网关已完全接管时使用）/ 'false'（不信任）
       */
      trust: process.env.TRUST_PROXY ?? '1',
    },
    swagger: {
      enabled: process.env.SWAGGER_ENABLED === 'true',
      username: process.env.SWAGGER_USERNAME ?? '',
      password: process.env.SWAGGER_PASSWORD ?? '',
      title: process.env.SWAGGER_TITLE ?? 'FssAdmin',
      description: process.env.SWAGGER_DESCRIPTION ?? 'FssAdmin API 文档',
      version: process.env.SWAGGER_VERSION ?? '1.0.0',
      /** 是否导出 OpenAPI JSON（默认导出，保持 /public/openApi.json 既有行为） */
      openApiExportEnabled: process.env.SWAGGER_OPENAPI_EXPORT_ENABLED !== 'false',
      /**
       * OpenAPI JSON 导出目录（相对启动目录）。
       * 默认 'public'（该目录通过 /public/ 对外静态暴露，且被 /api-test/ 工具加载）；
       * 若不希望对外暴露 API 结构，可改为非静态目录（如 'temp'），此时需同步调整 api_test_web 的加载路径。
       */
      openApiExportDir: process.env.SWAGGER_OPENAPI_EXPORT_DIR ?? 'public',
    },
    file: {
      storage: process.env.FILE_STORAGE ?? 'local',
      uploadDir: process.env.FILE_UPLOAD_DIR ?? '../upload',
      domain: process.env.FILE_DOMAIN ?? 'http://localhost:3000',
      serveRoot: process.env.FILE_SERVE_ROOT ?? '/profile',
      maxSize: Number(process.env.FILE_MAX_SIZE ?? 10),
      allowedExtensions: (process.env.FILE_ALLOWED_EXTENSIONS ?? 'jpg,jpeg,png,gif,webp,bmp')
        .split(',')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean),
    },
    log: {
      level: process.env.LOG_LEVEL ?? 'info',
      /**
       * 实际生效的最低日志级别（仅由调试模式决定，与只读模式无关）：
       * - DEBUG=true：按 LOG_LEVEL 全量输出
       * - DEBUG=false：收敛为 LOG_PROD_LEVEL（默认 warn），只落 fatal/error/warn
       * LOG_FILE_ENABLED=false 仍是彻底关闭文件日志的硬开关。
       */
      effectiveLevel: debugEnabled
        ? (process.env.LOG_LEVEL ?? 'info')
        : (process.env.LOG_PROD_LEVEL ?? 'warn'),
      dir: process.env.LOG_DIR ?? 'logs',
      consoleEnabled: process.env.LOG_CONSOLE_ENABLED !== 'false',
      fileEnabled: process.env.LOG_FILE_ENABLED !== 'false',
      healthLogEnabled: process.env.LOG_HEALTH_LOG_ENABLED === 'true',
      dependencyCheckIntervalMs: Number(process.env.LOG_DEPENDENCY_CHECK_INTERVAL_MS ?? 30000),
      maxFileSizeMb: Number(process.env.LOG_MAX_FILE_SIZE_MB ?? 20),
      retentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),
    },
    memory: {
      /** Bun 下是否启用内存监控（默认关闭，避免 JSC 口径差异导致误判/误 dump） */
      bunMonitorEnabled,
      // ponytail: Bun 基线 RSS 高于 Node，默认阈值按运行时区分；生产 PM2 可配 MEMORY_FATAL_EXIT=true
      // 显式开启 Bun 监控后使用更保守的默认值（RSS 1200/1600），显式环境变量始终优先
      rssWarnMb: Number(
        process.env.MEMORY_RSS_WARN_MB ?? (isBunRuntime ? (bunMonitorEnabled ? 1200 : 768) : 300),
      ),
      rssFatalMb: Number(
        process.env.MEMORY_RSS_FATAL_MB ?? (isBunRuntime ? (bunMonitorEnabled ? 1600 : 1536) : 450),
      ),
      heapUsageWarn: Number(process.env.MEMORY_HEAP_WARN_PERCENT ?? 85),
      heapUsageFatal: Number(process.env.MEMORY_HEAP_FATAL_PERCENT ?? 95),
      /**
       * 堆使用率是否参与阈值判定。
       * Bun(JavaScriptCore) 下 `heapUsed / heapTotal` 口径无效——实测同一进程内该比值可在
       * 3% ~ 109% 间跳变（heapUsed 甚至大于 heapTotal），一旦用于判定会立刻恒定命中致命阈值，
       * 导致每次检查都生成堆快照。故 Bun 下强制关闭，仅按 RSS 判定。
       */
      heapUsageEnabled: readBooleanEnv(process.env.MEMORY_HEAP_USAGE_ENABLED, !isBunRuntime),
      fatalExit:
        process.env.MEMORY_FATAL_EXIT === 'true' ||
        (process.env.NODE_ENV === 'production' && process.env.MEMORY_FATAL_EXIT !== 'false'),
      /** Bun 默认不参与 RSS 致命判定（口径不同），显式开启 Bun 监控或 MEMORY_RSS_FATAL_ENABLED=true 时启用 */
      rssFatalEnabled:
        process.env.MEMORY_RSS_FATAL_ENABLED !== 'false' && (!isBunRuntime || bunMonitorEnabled),
      /** 是否允许自动生成堆快照（默认跟随调试模式 DEBUG；手动接口不受此开关限制） */
      dumpEnabled: readBooleanEnv(process.env.MEMORY_DUMP_ENABLED, debugEnabled),
      /** heapdump 目录保留的最大快照数量（0 = 不限制数量） */
      dumpMaxFiles: Number(process.env.MEMORY_DUMP_MAX_FILES ?? 3),
      /** 堆快照过期天数（0 = 不按时间清理） */
      dumpRetentionDays: Number(process.env.MEMORY_DUMP_RETENTION_DAYS ?? 1),
      /** 同一原因两次自动堆快照的最小间隔（毫秒，0 = 不节流） */
      dumpMinIntervalMs: Number(process.env.MEMORY_DUMP_MIN_INTERVAL_MS ?? 60000),
    },
    perm: {
      router: {
        whitelist: routerWhitelist,
      },
    },
    taixu: {
      qdrant: {
        url: process.env.TAIXU_QDRANT_URL ?? '',
        collectionPrefix: process.env.TAIXU_QDRANT_COLLECTION_PREFIX ?? 'taixu_rag_',
        vectorSize: Number(process.env.TAIXU_QDRANT_VECTOR_SIZE ?? 1024),
        timeout: Number(process.env.TAIXU_QDRANT_TIMEOUT ?? 30),
        // 向量入库每批文本数：复用同一 store/embeddings，顺序写入（不加并发）
        embedBatch: Number(process.env.TAIXU_QDRANT_EMBED_BATCH ?? 64),
      },
      neo4j: {
        boltUrl: process.env.TAIXU_NEO4J_BOLT_URL ?? '',
        httpUrl: process.env.TAIXU_NEO4J_HTTP_URL ?? '',
        username: process.env.TAIXU_NEO4J_USERNAME ?? '',
        password: process.env.TAIXU_NEO4J_PASSWORD ?? '',
        labelPrefix: process.env.TAIXU_NEO4J_LABEL_PREFIX ?? '',
      },
      graph: {
        // LLM 实体关系图总开关（默认关闭以提速入库；需要时设为 true 再开启）
        enabled: String(process.env.TAIXU_GRAPH_ENABLED ?? 'false').toLowerCase() === 'true',
        // 开启时图谱抽取的并发数（对齐 taixu ThreadPoolExecutor）
        concurrency: Number(process.env.TAIXU_GRAPH_CONCURRENCY ?? 5),
        // 图谱抽取使用更粗的分块以减少 LLM 调用次数（向量分块仍用 rag.chunkSize）
        chunkSize: Number(process.env.TAIXU_GRAPH_CHUNK_SIZE ?? 2400),
      },
      documents: {
        saveDir: process.env.TAIXU_DOC_SAVE_DIR ?? '',
        // 默认 false：后台索引不依赖前台登录会话；设为 true 则恢复旧行为
        indexRequireLogin:
          String(process.env.TAIXU_DOC_INDEX_REQUIRE_LOGIN ?? 'false').toLowerCase() === 'true',
      },
      mcp: {
        amapKey: process.env.TAIXU_MCP_AMAP_KEY ?? '',
      },
      tavily: {
        apiKey: process.env.TAIXU_TAVILY_API_KEY ?? '',
      },
      llm: {
        provider: process.env.TAIXU_LLM_PROVIDER ?? 'ollama',
        openai: {
          apiKey: process.env.TAIXU_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
          baseUrl: process.env.TAIXU_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '',
          model: process.env.TAIXU_OPENAI_MODEL ?? 'gpt-4o-mini',
          embeddingModel: process.env.TAIXU_OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        },
        ollama: {
          baseUrl: process.env.TAIXU_OLLAMA_BASE_URL ?? 'http://localhost:11434',
          model: process.env.TAIXU_OLLAMA_MODEL ?? 'llama3',
          embeddingModel: process.env.TAIXU_OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
        },
      },
      image: {
        openaiModel: process.env.TAIXU_OPENAI_IMAGE_MODEL ?? 'gpt-image-1',
      },
    },
  };
};
