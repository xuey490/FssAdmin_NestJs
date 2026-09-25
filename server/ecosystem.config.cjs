/**
 * PM2 生产部署配置
 *
 * 启动方式（推荐，前台运行，适合容器/直接查看日志）：
 *   pnpm run prod
 * 或后台守护进程方式（必须带 --env production，否则 env_production 不会注入）：
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 restart nextjs-server --update-env   # 修改环境变量后必须加 --update-env 才会刷新
 *
 * 注意：PM2 的 daemon 不会自动继承当前 shell 的新环境变量，
 * 因此 NODE_ENV=production 放在始终生效的 env 块中，避免忘带 --env 时应用回落到 .env.development。
 */
module.exports = {
  apps: [
    {
      name: 'nextjs-server',
      script: './dist/main.js',
	  //cwd: __dirname,          // ← 新增：始终以 ecosystem.config.cjs 所在目录为工作目录
      // 运行时解释器固化在配置内，不再依赖 CLI 的 --interpreter 参数（PM2 原生支持 Bun）
      interpreter: 'bun',
      instances: 1,
      exec_mode: 'fork',
	  
//instances: 4,       // 或 'max'# 指定 4 个工作进程
//exec_mode: 'cluster',
	  
      // 始终生效的基础环境变量（与 --env 参数无关）
      env: {
        NODE_ENV: 'production',
      },
      // 通过 `--env production` 显式选择时额外注入的环境变量
      env_production: {
        NODE_ENV: 'production',
        // 仅在 node 解释器下有意义（V8 堆上限）；Bun 使用 JavaScriptCore，此参数无效，
        // 如需用 Node 运行请把 interpreter 改为 'node' 并打开下一行：
        // NODE_OPTIONS: '--max-old-space-size=650',
      },
      // 进程 RSS 超过该值由 PM2 直接重启（与运行时无关的最终护栏）。
      // 必须高于应用内存告警阈值（生产 .env 中 MEMORY_RSS_WARN_MB=500），
      // 否则会出现"刚重启就满足告警/dump 条件"的循环。Bun 的 RSS 基线高于 Node，故取 700M。
      max_memory_restart: '700M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2/error.log',
      out_file: './logs/pm2/out.log',
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      listen_timeout: 15000,
      kill_timeout: 20000,
      shutdown_with_message: true,
    },
  ],
};
