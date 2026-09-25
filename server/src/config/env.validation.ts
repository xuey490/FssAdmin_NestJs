import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  APP_NAME: Joi.string().default('nextjs-server'),
  APP_PORT: Joi.number().port().default(3000),
  APP_API_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
    .allow('')
    .default(''),
  // 调试模式：控制日志级别（LOG_LEVEL / LOG_PROD_LEVEL）与自动堆快照默认值；不再表示只读
  DEBUG: Joi.boolean().truthy('true').falsy('false').default(true),
  // 只读/演示模式：true = 禁止写操作（白名单除外）；刻意不设默认值，未配置时兼容回落为 DEBUG=false
  READONLY_MODE: Joi.boolean().truthy('true').falsy('false').optional(),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(3306),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').default(''),
  DB_NAME: Joi.string().required(),
  DB_SYNC: Joi.boolean().truthy('true').falsy('false').default(false),
  DB_LOGGING: Joi.boolean().truthy('true').falsy('false').default(false),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('2h'),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().integer().min(0).default(0),

  CORS_MODE: Joi.string().valid('off', 'all', 'open', 'list').default('off'),
  CORS_ORIGINS: Joi.when('CORS_MODE', {
    is: 'list',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  CORS_CREDENTIALS: Joi.boolean().truthy('true').falsy('false').default(false),

  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  SWAGGER_USERNAME: Joi.string().allow('').optional(),
  SWAGGER_PASSWORD: Joi.string().allow('').optional(),
  SWAGGER_TITLE: Joi.string().default('FssAdmin'),
  SWAGGER_DESCRIPTION: Joi.string().default('FssAdmin API 文档'),
  SWAGGER_VERSION: Joi.string().default('1.0.0'),

  FILE_STORAGE: Joi.string().valid('local', 'cos').default('local'),
  FILE_UPLOAD_DIR: Joi.string().default('../upload'),
  FILE_DOMAIN: Joi.string().default('http://localhost:3000'),
  FILE_SERVE_ROOT: Joi.string().default('/profile'),
  FILE_MAX_SIZE: Joi.number().integer().min(1).default(10),
  FILE_ALLOWED_EXTENSIONS: Joi.string().default('jpg,jpeg,png,gif,webp,bmp'),

  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug').default('info'),
  /** DEBUG=false 时生效的最低日志级别（默认 warn，只落 fatal/error/warn） */
  LOG_PROD_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug').default('warn'),
  LOG_DIR: Joi.string().default('logs'),
  LOG_CONSOLE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  LOG_FILE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  LOG_HEALTH_LOG_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  LOG_DEPENDENCY_CHECK_INTERVAL_MS: Joi.number().integer().min(1000).default(30000),
  LOG_MAX_FILE_SIZE_MB: Joi.number().min(1).default(20),
  LOG_RETENTION_DAYS: Joi.number().integer().min(1).default(30),

  /** 是否允许自动生成堆快照；不设默认值，未配置时由 DEBUG 推导（DEBUG=false 默认关闭） */
  MEMORY_DUMP_ENABLED: Joi.boolean().truthy('true').falsy('false').optional(),
  MEMORY_DUMP_MAX_FILES: Joi.number().integer().min(0).default(3),
  MEMORY_DUMP_RETENTION_DAYS: Joi.number().integer().min(0).default(1),
  MEMORY_DUMP_MIN_INTERVAL_MS: Joi.number().integer().min(0).default(60000),

  /** Bun 下是否启用内存监控检查（阈值判定 + 自动堆快照 + RSS 致命判定）；默认关闭 */
  MEMORY_BUN_MONITOR_ENABLED: Joi.boolean().truthy('true').falsy('false').optional(),

  /** 堆使用率是否参与阈值判定；默认 Node true / Bun false（Bun 口径无效） */
  MEMORY_HEAP_USAGE_ENABLED: Joi.boolean().truthy('true').falsy('false').optional(),

  /** AI 模块 API Key 加密密钥；未设置时回退 JWT_SECRET 派生 */
  AI_ENCRYPTION_KEY: Joi.string().min(32).optional(),

  /** 每 Worker 最大并发 LLM 流数，超出时返回 503 */
  AI_MAX_CONCURRENT_STREAMS: Joi.number().integer().min(1).max(999).default(10),

  TAIXU_QDRANT_URL: Joi.string().uri().optional(),
  TAIXU_QDRANT_COLLECTION_PREFIX: Joi.string().optional(),
  TAIXU_QDRANT_VECTOR_SIZE: Joi.number().integer().min(1).max(100000).optional(),
  TAIXU_QDRANT_EMBED_BATCH: Joi.number().integer().min(1).max(512).optional(),

  TAIXU_GRAPH_ENABLED: Joi.boolean().truthy('true').falsy('false').optional(),
  TAIXU_GRAPH_CONCURRENCY: Joi.number().integer().min(1).max(32).optional(),
  TAIXU_GRAPH_CHUNK_SIZE: Joi.number().integer().min(200).max(20000).optional(),

  TAIXU_NEO4J_BOLT_URL: Joi.string().optional(),
  TAIXU_NEO4J_HTTP_URL: Joi.string().uri().optional(),
  TAIXU_NEO4J_USERNAME: Joi.string().optional(),
  TAIXU_NEO4J_PASSWORD: Joi.string().allow('').optional(),
  TAIXU_NEO4J_LABEL_PREFIX: Joi.string().optional(),

  TAIXU_DOC_SAVE_DIR: Joi.string().optional(),
  TAIXU_DOC_INDEX_REQUIRE_LOGIN: Joi.boolean().truthy('true').falsy('false').optional(),

  TAIXU_MCP_AMAP_KEY: Joi.string().allow('').optional(),

  TAIXU_LLM_PROVIDER: Joi.string().valid('openai', 'ollama').optional(),
  TAIXU_OPENAI_API_KEY: Joi.string().allow('').optional(),
  TAIXU_OPENAI_BASE_URL: Joi.string().allow('').optional(),
  TAIXU_OPENAI_MODEL: Joi.string().allow('').optional(),
  TAIXU_OPENAI_EMBEDDING_MODEL: Joi.string().allow('').optional(),
  TAIXU_OPENAI_IMAGE_MODEL: Joi.string().allow('').optional(),
  TAIXU_OLLAMA_BASE_URL: Joi.string().allow('').optional(),
  TAIXU_OLLAMA_MODEL: Joi.string().allow('').optional(),
  TAIXU_OLLAMA_EMBEDDING_MODEL: Joi.string().allow('').optional(),
});
