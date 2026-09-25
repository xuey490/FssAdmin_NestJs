/**
 * 启动期环境快照。
 *
 * 必须在 AppModule 之前被导入：`ConfigModule.forRoot()` 在模块求值阶段就会读取
 * `.env.<NODE_ENV>` 并把文件里的键写回 `process.env`（见 @nestjs/config 的
 * `assignVariablesToProcess`），其中就包含 `.env.development` 里的 `NODE_ENV=development`。
 * 因此到了 bootstrap() 阶段再读 `process.env.NODE_ENV` 已无法区分
 * "用户显式设置" 与 "从 .env 文件注入"，启动自检会误报。
 *
 * 使用方法：在 main.ts 中把本模块的 import 放在 `./app.module` 之前。
 */

/** 用户/运行时在进程启动时就已存在的 NODE_ENV（未被 .env 文件注入污染）；未设置时为 undefined */
export const originalNodeEnv: string | undefined = process.env.NODE_ENV;

/** NODE_ENV 是否为进程启动时显式提供（shell / PM2 env / 命令行前缀），而非 .env 文件注入或默认值 */
export const isNodeEnvExplicit = Boolean(originalNodeEnv);
