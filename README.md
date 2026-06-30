# FssAdmin (nextjs-server)

> FssAdmin(NestJs)是一款基于**NestJS + TypeScript6 + TypeORM1.0等** 技术栈的全功能企业级后端管理系统，可以运行在node V8 和 Bun 双环境中，集成 RBAC 权限、多租户、AI 对话、知识库 RAG、定时任务、系统监控、API 文档等开箱即用的企业级能力。

[![Node](https://img.shields.io/badge/Node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![BUN](https://img.shields.io/badge/BUN-%3E%3D1.3.X-brightgreen)](https://bun.sh/)
[![NestJS](https://img.shields.io/badge/NestJS-11.x-ea2845)](https://nestjs.com)
[![TypORM](https://img.shields.io/badge/TypeORM-1.0.x-ea2845)](https://typeorm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6)](https://www.typescriptlang.org)
[![MySQL](https://img.shields.io/badge/MySQL-%3E%3D5.7.x-4479a1)](https://www.mysql.com)
[![Redis](https://img.shields.io/badge/Redis-7.x-dc382d)](https://redis.io)
[![License](https://img.shields.io/badge/License-MIT-red)]()

---

## 📋 目录

- [技术栈](#技术栈)
- [核心功能](#核心功能)
- [项目结构](#项目结构)
- [模块说明](#模块说明)
- [环境配置](#环境配置)
- [快速开始（本地开发）](#快速开始本地开发)
- [调试指南](#调试指南)
- [构建与部署](#构建与部署)
- [PM2 生产部署](#pm2-生产部署)
- [API 文档](#api-文档)
- [日志系统](#日志系统)
- [API 自动验证](#api-自动验证)
- [数据库迁移](#数据库迁移)
- [监控与告警](#监控与告警)
- [开发约定](#开发约定)
- [常见问题](#常见问题)

---

## 技术栈

| 类别 | 技术 |
|------|------|
| **运行时** | Node.js ≥ 20，可选 **Bun** ≥ 1.1 加速开发 |
| **语言** | TypeScript 6.x（严格模式） |
| **后端框架** | NestJS 11.x |
| **数据库** | MySQL 5.7.x + TypeORM 1.0.x |
| **缓存** | Redis 7.x + ioredis |
| **AI / LLM** | LangChain + OpenAI / Ollama / 自定义 LLM 供应商 |
| **向量数据库** | Qdrant（知识库 RAG） |
| **图数据库** | Neo4j（知识图谱） |
| **ORM** | TypeORM + DataSource + migrations |
| **流式传输** | WebSocket (WsAdapter) + SSE |
| **定时任务** | @nestjs/schedule + cron |
| **参数校验** | class-validator + class-transformer |
| **API 文档** | Swagger / OpenAPI 3.0 |
| **任务调度** | cron |
| **日志** | Winston + 每日滚动 + JSONL 结构化 |
| **部署** | PM2（ecosystem.config.cjs） |
| **构建** | tsc / Nest CLI / Bun bundler（编译为单文件） |
| **包管理** | pnpm（推荐） / npm / bun |
| **代码规范** | ESLint + Prettier |

---

## 核心功能

### 🔐 系统管理（RBAC + 多租户）
- **用户管理**：用户 CRUD、状态管理、密码重置
- **角色管理**：RBAC 角色权限控制
- **菜单管理**：动态菜单树、按钮级权限
- **部门管理**：树形部门结构、数据权限隔离
- **岗位管理**：岗位 CRUD
- **字典管理**：字典类型 + 字典数据
- **配置管理**：系统参数配置（支持缓存）
- **租户管理**：多租户隔离
- **插件管理**：插件注册与管理

### 🧠 AI 智能（FssAI + RAG）
- **AI 对话（FssAI）**：多供应商 LLM 对话，支持流式输出
  - 多 LLM 供应商（OpenAI / Ollama / 自定义）
  - WebSocket 实时流式对话
  - 对话 Session 管理
  - Agent 管理
  - 上下文构建 + 会话摘要
- **RAG知识库**：完整的 RAG 系统
  - 文档管理（上传、解析、索引）
  - 向量检索（Qdrant）
  - 知识图谱（Neo4j）
  - 多轮对话历史
  - LLM 管理 + 模型配置
  - RAG 检索 + 图谱检索
  - Agentic 编排引擎（LangGraph）
    - Pattern Agent：模式化 Agent
    - Program Agents：可编程 Agent
    - Agentic Orchestrator：编排调度器
    - MCP 客户端工具
    - 搜索记忆服务
    - Prompt 管理

### 📊 系统监控
- **服务器监控**：CPU、内存、磁盘、网络等系统指标
- **缓存监控**：Redis 缓存管理（查看、清理）
- **数据库监控**：数据库连接池、表空间
- **在线用户**：当前在线会话管理
- **登录日志**：登录历史记录
- **操作日志**：API 操作审计日志
- **定时任务**：任务 CRUD + 执行日志 + 手动执行
- **内存监控**：RSS / 堆使用率监控告警
- **邮件日志**：邮件发送记录

### 📦 其他模块
- **文件上传**：本地 / COS（云存储暂无），附件分类管理
- **内容管理**：文章 CRUD
- **数据备份**：自动备份任务
- **通用工具**：验证码（SVG）、Excel 导入导出、敏感词过滤、XSS 防护

### 🛡️ 安全防护
- JWT 身份认证（passport-jwt）
- 角色 + 权限双校验守卫
- 请求频率限制（rate-limit）
- Web 安全头（helmet）
- XSS 过滤
- 敏感词过滤
- 全局参数清洗（whitelist + transform）
- 操作日志审计（拦截器）
- 多租户数据隔离（拦截器）
- 只读模式（DEBUG=false 时禁止写操作）

---

## 项目结构

```text
server1/
├── src/
│   ├── main.ts                    # 应用入口（单进程 / 集群模式）
│   ├── app.module.ts              # 根模块
│   ├── config/                    # 配置读取、环境变量校验
│   │   ├── configuration.ts       # 配置工厂（所有配置集中读取）
│   │   ├── env.validation.ts      # Joi 环境变量校验
│   │   ├── database.config.ts     # TypeORM 数据库配置
│   │   └── redis.config.ts        # Redis 连接配置
│   ├── common/                    # 公共基础设施
│   │   ├── constant/              # 业务常量
│   │   ├── decorators/            # 自定义装饰器（auth、permission、role、operlog、redis、captcha、task）
│   │   ├── dto/                   # 通用 DTO
│   │   ├── entities/              # 基础实体
│   │   ├── enum/                  # 通用枚举
│   │   ├── filters/               # 全局异常过滤器
│   │   ├── guards/                # 全局守卫（debug、auth、roles、permission）
│   │   ├── interceptor/           # 拦截器（security、operlog、tenant、memory-monitor）
│   │   ├── services/              # 公共服务（敏感词）
│   │   ├── subscriber/            # TypeORM 订阅器（审计日志）
│   │   ├── tenant/                # 多租户上下文
│   │   ├── typeorm/               # TypeORM 审计补丁
│   │   └── utils/                 # 工具函数（captcha、export、ip、crypto、sanitize、result、audit）
│   ├── database/                  # 数据库全局模块
│   ├── redis/                     # Redis 模块（REDIS_CLIENT + RedisService）
│   │   └── decorators/            # Redis 操作装饰器
│   ├── logging/                   # 日志系统
│   │   ├── sinks/                 # 日志输出（console、file、winston）
│   │   ├── dto/                   # 日志查询参数
│   │   ├── interfaces/            # 日志类型定义
│   │   ├── app-logger.service.ts  # 结构化日志服务
│   │   ├── request-logging.middleware.ts  # 请求日志中间件
│   │   ├── dependency-monitor.service.ts  # 依赖（MySQL/Redis）状态监控
│   │   ├── log-query.service.ts   # 本地日志查询
│   │   └── logs.controller.ts     # 日志查询 API
│   ├── modules/                   # 内置轻量模块
│   │   ├── health/                # 健康检查
│   │   ├── demo-kit/              # 演示 / 示例模块
│   │   └── demo-kit-test/         # 演示测试模块
│   ├── module/                    # 业务模块目录
│   │   ├── main/                  # 核心入口（登录、退出、注册、验证码、路由、个人信息）
│   │   ├── system/                # 系统管理
│   │   │   ├── auth/              # JWT 认证策略
│   │   │   ├── user/              # 用户管理
│   │   │   ├── role/              # 角色管理
│   │   │   ├── menu/              # 菜单管理
│   │   │   ├── dept/              # 部门管理
│   │   │   ├── post/              # 岗位管理
│   │   │   ├── dict/              # 字典管理
│   │   │   ├── config/            # 配置管理
│   │   │   ├── tenant/            # 租户管理
│   │   │   ├── plugin/            # 插件管理
│   │   │   ├── tool/              # 代码生成工具（含 NestJS + Vue 模板）
│   │   │   └── operlog/           # 操作日志
│   │   ├── monitor/               # 系统监控
│   │   │   ├── server/            # 服务器监控
│   │   │   ├── cache/             # 缓存监控
│   │   │   ├── redis/             # Redis 监控
│   │   │   ├── database/          # 数据库监控
│   │   │   ├── online/            # 在线用户
│   │   │   ├── loginlog/          # 登录日志
│   │   │   ├── operlog/           # 操作日志
│   │   │   ├── job/               # 定时任务
│   │   │   ├── email-log/         # 邮件日志
│   │   │   └── memory/            # 内存监控
│   │   ├── ai/                    # FssAI 对话模块
│   │   │   ├── entities/          # 实体（Provider、Model、Agent、Session、Message）
│   │   │   ├── providers/         # LLM 供应商工具 + OpenAI 流式处理
│   │   │   └── services/          # 对话、配置、上下文、摘要、流停止、信号量
│   │   ├── Taixu/                 # RAG 知识库 / Agent 系统
│   │   │   ├── common/            # 公共信息、验证码
│   │   │   ├── home/              # 首页（天气、统计）
│   │   │   ├── user/              # 用户管理
│   │   │   ├── model/             # LLM 模型管理
│   │   │   ├── setting/           # 系统设置
│   │   │   ├── history/           # 对话历史
│   │   │   ├── document/          # 文档管理（上传、解析、索引）
│   │   │   ├── llm/               # LLM 调用管理
│   │   │   ├── vector/            # 向量检索服务
│   │   │   ├── graph/             # 知识图谱服务
│   │   │   ├── retrieval/         # RAG 检索
│   │   │   ├── agent/             # Agent 服务
│   │   │   ├── modal/             # 模态框（兼容层）
│   │   │   └── agentic/           # Agentic 编排引擎
│   │   │       ├── agent/         # Pattern/Program Agents + Orchestrator
│   │   │       ├── memory/        # 搜索记忆
│   │   │       ├── tools/         # Agent 工具 + MCP 客户端
│   │   │       ├── prompt/        # Prompt 管理
│   │   │       └── rag/           # RAG 集成
│   │   ├── upload/                # 文件上传（本地 / COS）
│   │   ├── article/               # 文章管理
│   │   ├── backup/                # 数据备份
│   │   └── common/                # 公共模块（Axios 封装）
│   ├── api-verifier/              # API 自动验证 CLI
│   │   ├── cli/                   # 命令行入口
│   │   ├── http/                  # HTTP 验证客户端
│   │   ├── openapi/               # OpenAPI 用例生成
│   │   └── report/                # Markdown 报告生成
│   ├── migrations/                # TypeORM 迁移文件
│   ├── prompt/                    # 系统 prompt 模板
│   └── data-source.ts             # TypeORM DataSource 配置
├── api_test_web/                  # API 测试 Web 页面
├── public/                        # 静态资源目录
│   └── openApi.json               # 导出的 OpenAPI 规范文件
├── scripts/                       # 工具脚本
├── sql/                           # SQL 脚本
├── test/                          # 测试
├── database/                      # 数据库初始化脚本
├── logs/                          # 日志目录（gitignore）
├── dist/                          # 构建输出
├── ecosystem.config.cjs           # PM2 部署配置
├── nest-cli.json                  # Nest CLI 配置
├── tsconfig.json                  # TypeScript 编译配置
├── tsconfig.build.json            # 构建编译配置
├── nodemon.json                   # Nodemon 开发热重启
├── .env.example                   # 环境变量模板（可提交 Git）
├── .env.development                # 开发环境配置（不提交 Git）
├── .env.production                 # 生产环境配置（不提交 Git）
├── package.json                   # 包管理
├── pnpm-lock.yaml                 # pnpm 锁文件
└── bun.lock                       # Bun 锁文件
```

---

## 模块说明

### 1. AppModule（根模块）

全局引入所有业务模块，注册全局 Guard、Interceptor、Subscriber。主要职责：

- 配置加载：`@nestjs/config` + Joi 校验
- TypeORM 数据库连接
- Schedule 定时任务
- DemoKit 模块注册
- 全局安全拦截器 / 守卫注册

### 2. 系统管理模块（SystemModule）

| 子模块 | 说明 |
|--------|------|
| Auth | JWT 策略（passport-jwt），Token 签发与验证 |
| User | 用户 CRUD、状态管理、密码重置、个人中心 |
| Role | 角色 CRUD、角色-菜单权限分配 |
| Menu | 动态菜单树、按钮权限标识 |
| Dept | 树形部门管理 |
| Post | 岗位管理 |
| Dict | 字典类型 + 字典数据 |
| Config | 系统参数配置（支持 Redis 缓存） |
| Notice | 通知公告发布 |
| Tenant | 多租户管理 |
| Plugin | 插件注册与管理 |
| Tool | 代码生成（支持模板引擎，NestJS + Vue模板） |

### 3. 监控模块（MonitorModule）

| 子模块 | 说明 |
|--------|------|
| Server | CPU、内存、磁盘、网络、操作系统信息 |
| Cache | 缓存列表、清理 |
| Redis | Redis 服务器信息、Key 管理 |
| Database | 数据库连接池、表信息、SQL 监控 |
| Online | 在线用户会话管理、强制下线 |
| LoginLog | 登录日志查询、导出 |
| OperLog | 操作日志查询、导出 |
| Job | 定时任务 CRUD、执行日志、手动触发 |
| EmailLog | 邮件发送记录查询 |
| Memory | RSS/堆内存监控告警 |

### 4. AI 对话模块（AiModule）

- 多供应商 LLM 对话（OpenAI / Ollama 等）
- WebSocket 实时流式对话（WsAdapter，与 HTTP 同端口）
- 对话 Session / Message 管理
- Agent 配置
- 上下文构建 + 会话摘要
- LLM 信号量并发控制
- 流中断控制

### 5. 知识库模块（TaixuModule）

- **文档管理**：上传、解析（PDF/Word/HTML/TXT）、分块索引
- **向量检索**：Qdrant 向量数据库
- **知识图谱**：Neo4j 实体关系图抽取
- **LLM 管理**：多模型配置（OpenAI / Ollama）
- **RAG 检索**：混合检索（向量 + 图谱 + 全文）
- **Agentic 编排**：基于 LangGraph 的 Agent 编排
  - Pattern Agent、Program Agent
  - MCP 工具集成
  - 搜索记忆
  - Prompt 管理

### 6. 文件上传模块（UploadModule）

- 本地存储 / 腾讯云 COS 存储
- 文件类型 / 大小校验
- 附件分类管理
- 静态文件服务（一年长缓存）

### 7. API 验证模块（ApiVerifierModule）

- 命令行 API 自动验证
- OpenAPI 规范生成验证用例
- Markdown 报告输出
- 绿色/红色状态标记

### 8. 日志模块（LoggingModule）

- 结构化日志（JSONL 格式）
- 每日滚动分片（按小时分目录）
- 控制台 + 文件 + Winston 三路输出
- 请求日志（中间件）
- 依赖状态监控（MySQL / Redis）
- 日志查询 API

---

## 环境配置

环境变量文件加载顺序：`.env.${NODE_ENV}` → `.env`

### 核心配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `development` | 运行环境 |
| `DEBUG` | `true` | `false` 时进入只读模式 |
| `APP_NAME` | `nextjs-server` | 应用名称 |
| `APP_PORT` | `3000` | HTTP 端口 |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL 连接 |
| `DB_USERNAME` / `DB_PASSWORD` | `root` / ` ` | MySQL 账号密码 |
| `DB_NAME` | `nestjs` | 数据库名 |
| `JWT_SECRET` | （必填） | JWT 签名密钥 |
| `JWT_EXPIRES_IN` | `2h` | JWT 过期时间 |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Redis 连接 |
| `SWAGGER_ENABLED` | `false` | Swagger 文档开关 |
| `CORS_MODE` | `off` | CORS 模式（off / all / list） |
| `FILE_STORAGE` | `local` | 文件存储方式（local / cos） |
| `TAIXU_QDRANT_URL` | - | Qdrant 向量数据库地址 |
| `TAIXU_NEO4J_BOLT_URL` | - | Neo4j 图数据库地址 |

完整配置请参考 `.env.example` 和 `src/config/configuration.ts`。

> ⚠️ **安全提醒**：`.env.development` 和 `.env.production` 包含真实连接信息，**不要提交 Git**。`.env.example` 只放随机示例值。

---

## 快速开始（本地开发）

### 前置条件

| 依赖 | 版本要求 |
|------|----------|
| Node.js | ≥ 20.0.0 |
| pnpm（推荐） | ≥ 9 |
| Bun（可选） | ≥ 1.1.0 |
| MySQL | 5.7.x |
| Redis | 7.x |

### 1. 克隆并安装依赖

```bash
git clone <repo-url>
cd server1

# 推荐使用 pnpm
pnpm install

# 或使用 npm
npm install

# 或使用 bun
bun install
```

### 2. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 创建开发环境配置（不提交 Git）
cp .env.example .env.development
```

编辑 `.env.development`，填入本地 MySQL 和 Redis 连接信息：

```env
NODE_ENV=development
APP_PORT=48137
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=your_password
DB_NAME=fssoa-net
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
JWT_SECRET=your_jwt_secret_at_least_32_chars
```

### 3. 创建数据库

```sql
CREATE DATABASE IF NOT EXISTS `fssoa-net` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 4. 初始化数据

```bash
# 方式一：运行 SQL 脚本（如果 sql/ 目录下有初始化脚本）
mysql -u root -p fssoa-net < sql/init.sql

# 方式二：运行 TypeORM 迁移（推荐）
pnpm run migration:run

# 方式三：同步 Entity（仅开发环境临时使用，需设置 DB_SYNC=true）
```

### 5. 初始化管理员账号

```bash
# 构建项目
pnpm run build

# 初始化认证数据（创建默认 admin 账号）
pnpm run init:auth
```

默认管理员：`admin`，密码：`123456`

### 6. 启动开发服务器

```bash
# 使用 Bun（最快热重启）
pnpm run dev

# 使用 Node.js + tsx
pnpm run dev:node

# 使用 Nest CLI
pnpm run dev:nest

# 生产模式启动开发
pnpm run dev:prd
```

服务默认启动于 `http://localhost:8181`。

---

## 调试指南

### Bun Inspector 调试

```bash
# 启动调试模式（--inspect）
pnpm run dev:debug
# 或
pnpm run start:debug
```

浏览器打开 `chrome://inspect` 连接调试。

### Node.js Inspector 调试

```bash
pnpm run start:debug:nest
```

### 调试 Swagger / API

```bash
# 在 .env.development 中启用 Swagger
SWAGGER_ENABLED=true

# 重启后访问
# http://localhost:8181/api/swagger-ui/
```

### API 自动验证

```bash
# 构建并验证所有 API
pnpm run verify:api:dev

# 验证指定模块
pnpm run verify:api:dev -- --include=health

# 生成测试报告
pnpm run verify:api:dev -- --output=logs/verify/report.md
```

### 日志查询

```http
GET http://localhost:8181/api/log/query?level=info&category=system.startup
```

---

## 构建与部署

### 构建

```bash
# TypeScript 编译（推荐）
pnpm run build:prd

# Nest CLI 构建
pnpm run build:prd:nest

# Bun 单文件编译（实验性）
pnpm run build:bun

# Bun 编译为可执行文件（实验性）
pnpm run bundle:bun
```

### 启动生产服务

```bash
# Node.js 运行构建产物
pnpm run start:prod

# Bun 运行构建产物
pnpm run start:prod:bun

# PM2 部署（推荐生产环境）
pnpm run prod
```

### 生产环境检查清单

- [v] **JWT_SECRET**：替换为强随机字符串（≥32位）
- [v] **ADMIN_PASSWORD**：修改默认管理员密码
- [v] **DB_SYNC=false**：禁止自动同步表结构
- [v] **DB_LOGGING=false**：关闭 SQL 日志
- [v] **DEBUG=false**：生产环境开启只读模式
- [v] **Redis 密码**：设置 `REDIS_PASSWORD`
- [v] **CORS 配置**：设置 `CORS_MODE=list` + `CORS_ORIGINS`
- [v] **文件存储**：配置 `FILE_DOMAIN` 为可访问域名
- [v] **日志保留**：按需调整 `LOG_RETENTION_DAYS`
- [v] **内存限制**：检查 `MEMORY_RSS_WARN_MB` / `MEMORY_RSS_FATAL_MB`
- [ ] **备份策略**：配置数据备份计划

---

## PM2 生产部署

项目内置 PM2 配置文件 `ecosystem.config.cjs`：

```javascript
module.exports = {
  apps: [{
    name: 'nextjs-server',
    script: './dist/main.js',
    instances: 1,
    exec_mode: 'fork',
    env_production: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=400',
    },
    max_memory_restart: '400M',
    // ... 自动重启、日志、优雅关闭等配置
  }],
};
```

### 常用 PM2 命令

```bash
# 启动（使用 pnpm）
pnpm run prod

# 重启
pnpm run prod:pm2

# 停止
pnpm run prod:stop

# 查看日志
pnpm run logs:pm2

# 或直接使用 pm2
pm2 start ecosystem.config.cjs --interpreter bun
pm2 restart nextjs-server
pm2 stop nextjs-server
pm2 logs nextjs-server
pm2 monit              # 监控面板
```

### 集群模式

项目内置**多进程集群模式**（Windows 除外，自动退化为单进程）。

- 主进程自动根据 CPU 核心数 `fork` 工作进程
- 工作进程异常退出自动重启（含重启保护：60 秒内最多 10 次）
- 优雅关闭（SIGTERM → 等待 3 秒 → SIGKILL）
- 环境变量 `WEB_CONCURRENCY` 可覆盖工作进程数量
- 环境变量 `NO_CLUSTER` 可禁用集群模式

```bash
# 指定 4 个工作进程
WEB_CONCURRENCY=4 pnpm run prod

# 禁用集群
NO_CLUSTER=true pnpm run prod
```

---

## API 文档

### Swagger / OpenAPI

```env
# 启用 Swagger
SWAGGER_ENABLED=true
SWAGGER_USERNAME=swagger     # 可选 Basic Auth
SWAGGER_PASSWORD=swagger123
```

访问地址：`http://localhost:8181/api/swagger-ui/`

Swagger 文档支持 Basic Auth 保护，需配置 `SWAGGER_USERNAME` / `SWAGGER_PASSWORD`。

OpenAPI JSON 规范自动导出到 `public/openApi.json`，可用于 API 验证CI。

### WebSocket

AI 对话使用 WebSocket 协议，与 HTTP 共用端口（无需单独启动）：

```text
ws://localhost:8181/ws/ai
```

WebSocket 通过 `@nestjs/platform-ws`（WsAdapter）挂载。

### 核心 API 路径

| 路径 | 说明 |
|------|------|
| `POST /api/core/login` | 用户登录 |
| `POST /api/core/logout` | 退出登录 |
| `GET /api/core/captcha` | 获取验证码 |
| `POST /api/core/register` | 用户注册 |
| `GET /api/core/refresh` | 刷新 Token |
| `GET /api/health` | 健康检查 |
| `GET /api/log/query` | 日志查询 |
| `GET/POST/PUT/DELETE /api/system/*` | 系统管理 |
| `GET/POST/PUT/DELETE /api/monitor/*` | 系统监控 |
| `GET/POST/PUT/DELETE /api/ai/*` | AI 对话管理 |
| `GET/POST/PUT/DELETE /api/taixu/*` | 知识库 |
| `POST /api/upload/*` | 文件上传 |
| `GET/POST/PUT/DELETE /api/article/*` | 文章管理 |
| `GET/POST/PUT/DELETE /api/tool/*` | 代码生成 |

---

## 日志系统

### 日志文件结构

```text
logs/
├── YYYY/
│   └── MM/
│       └── DD/
│           ├── HH.jsonl          # 按小时分片
│           ├── HH-02.jsonl       # 超大小自动分片
│           └── ...
├── pm2/
│   ├── error.log
│   └── out.log
└── verify/
    └── api-verify-result-*.md    # API 验证报告
```

### 日志级别

`fatal` > `error` > `warn` > `info` > `debug` > `trace`

### 日志记录基础字段

| 字段 | 说明 |
|------|------|
| `timestamp` | 日志时间（ISO 8601） |
| `level` | 日志级别 |
| `category` | 日志分类（如 `system.startup`、`http.request`） |
| `message` | 日志消息 |
| `service` | 服务名称 |
| `env` | 运行环境 |
| `requestId` | 请求 ID |
| `traceId` | 链路 ID |
| `source` | 日志来源 |
| `meta` | 扩展信息（任意 JSON） |

### 日志配置

```env
LOG_LEVEL=info                     # 日志级别
LOG_CONSOLE_ENABLED=true           # 控制台输出
LOG_FILE_ENABLED=true              # 文件输出
LOG_DIR=logs                       # 日志目录
LOG_MAX_FILE_SIZE_MB=20            # 单文件最大（MB）
LOG_RETENTION_DAYS=30              # 保留天数
LOG_HEALTH_LOG_ENABLED=false       # 健康检查日志
```

---

## API 自动验证

内置 `api-verifier` 模块用于对已注册的 API 进行可用性验证并生成报告。

### 基本使用

```bash
# 构建并运行验证
pnpm run verify:api:dev

# 指定目标服务地址
pnpm run verify:api:dev -- --base-url=http://127.0.0.1:3000/api

# 只验证指定模块
pnpm run verify:api:dev -- --include=health

# 排除指定模块
pnpm run verify:api:dev -- --exclude=logging
```

### 高级选项

```bash
# 只执行指定用例（多用例逗号分隔）
pnpm run verify:api:dev -- --case=health.check,logging.query

# 设置超时（ms）
pnpm run verify:api:dev -- --timeout=10000

# 指定报告输出
pnpm run verify:api:dev -- --output=logs/verify/report.md

# 失败即停止
pnpm run verify:api:dev -- --fail-fast

# 允许执行 unsafe 用例（写操作、删除操作）
pnpm run verify:api:dev -- --allow-unsafe
```

---

## 数据库迁移

```bash
# 创建空迁移文件
pnpm run migration:create -- src/migrations/MigrationName

# 根据 Entity 变更生成迁移
pnpm run migration:generate -- src/migrations/MigrationName

# 执行所有未执行迁移
pnpm run migration:run

# 回滚最近一次迁移
pnpm run migration:revert
```

---

## 监控与告警

### 内置监控

| 监控项 | 实现方式 |
|--------|----------|
| 内存监控 | MemoryMonitorInterceptor + MemoryMonitorService |
| 依赖状态 | DependencyMonitorService（MySQL / Redis 定期检查） |
| 健康检查 | `GET /api/health`（含数据库 + Redis 状态） |
| 请求审计 | OperlogInterceptor（自动记录 API 操作日志） |
| 在线用户 | OnlineService（Redis 会话管理） |
| 服务器指标 | ServerService（os 模块 CPU/内存/磁盘） |

### 内存告警配置

```env
# Node.js 环境
MEMORY_RSS_WARN_MB=300        # RSS 警告阈值
MEMORY_RSS_FATAL_MB=450       # RSS 致命阈值
MEMORY_HEAP_WARN_PERCENT=85   # 堆使用率警告
MEMORY_HEAP_FATAL_PERCENT=95  # 堆使用率致命
MEMORY_FATAL_EXIT=true        # 致命时退出进程

# Bun 环境（默认阈值更高）
MEMORY_RSS_WARN_MB=768
MEMORY_RSS_FATAL_MB=1536
```


## 开发约定

### 路由约定

```typescript
// Controller 中只写模块名和动作名，不写 /api 前缀
@Controller('user')
export class UserController {
  @Get('list')
  list() {}
}
```

全局前缀由 `APP_API_PREFIX` 控制，默认空字符串。

### 路径别名

```typescript
import { utils } from '@/utils/utils';
// 等价于
import { utils } from 'src/utils/utils';
```

### 新增模块模板

```text
src/modules/<module-name>/
├── <module-name>.controller.ts
├── <module-name>.service.ts
├── <module-name>.module.ts
├── <module-name>.api-verifier.ts  # 可选
├── dto/
│   ├── create-<entity>.dto.ts
│   └── query-<entity>.dto.ts
└── entities/
    └── <entity>.entity.ts
```

### 工具函数

统一从 `@/utils/utils` 导出，优先复用 `cross-env-plugins` 已有方法。

### 配置管理

新增环境变量时必须同步更新：

1. `src/config/configuration.ts` — 配置读取
2. `src/config/env.validation.ts` — Joi 校验
3. `.env.example` — 模板注释
4. 对应环境文件（`.env.development` / `.env.production`）

### 代码规范

```bash
# 检查
pnpm run lint

# 测试
pnpm run test              # Jest 单元测试
pnpm run test:e2e          # E2E 测试
pnpm run test:bun          # Bun test
pnpm run test:cov          # 覆盖率
pnpm run typecheck         # TypeScript 类型检查
```

---

## 常见问题

### Q1: 启动报错 MySQL / Redis 连接失败？

项目设计为 MySQL / Redis 连接失败**不会阻断启动**，服务仍可正常接收请求。

检查：
1. MySQL / Redis 服务是否已启动
2. `.env.development` 中的连接信息是否正确
3. 查看启动日志中的依赖状态提示


> ⚠️ 生产环境部署后应立即修改密码。

### Q2: 如何启用 Swagger 文档？

在 `.env.development` 或 `.env.production` 中配置：

```env
SWAGGER_ENABLED=true
SWAGGER_USERNAME=swagger
SWAGGER_PASSWORD=swagger123
```

访问 `http://localhost:8181/api/swagger-ui/`。


### Q2: 如何集成知识库（RAG）？

1. 启动 Qdrant 向量数据库
2. 配置 `TAIXU_QDRANT_URL`
3. 启动 Neo4j 配置 `TAIXU_NEO4J_BOLT_URL`
4. 在太虚模块中上传文档
5. 系统自动完成解析 → 分块 → 向量化 → 索引

### Q3: Bun 兼容性？

项目支持 Bun 运行时，但注意：

- Bun 的 `--watch` 模式热重启速度远快于 Node.js + tsx
- Bun 的 RSS 基线高于 Node.js，内存监控阈值已自动适配
- Bun 单文件编译 `build:bun` 和 `bundle:bun` 为实验性功能
- PM2 生产部署可通过 `--interpreter bun` 使用 Bun

### Q4: 如何备份数据？

- **数据库**：使用 `mysqldump` 定时备份
- **文件**：备份 `FILE_UPLOAD_DIR` 目录
- **配置**：备份 `.env.production` 等环境配置
- 项目内置的 `BackupService` 提供定时备份任务框架

---

## 许可证

本项目为私有项目（MIT）,欢迎start & fork。
