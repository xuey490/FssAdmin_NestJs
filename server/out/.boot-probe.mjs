/**
 * 临时启动探针：加载打包产物 out/main.js（等同 bun out/main.js），
 * 12 秒后主动退出，用于验证启动阶段无崩溃（字体/canvas 等资源类问题）。跑完即删。
 */
const timer = setTimeout(() => {
  console.log('[probe] 12s 内进程未崩溃 → 启动阶段正常');
  process.exit(0);
}, 12000);

process.on('uncaughtException', (error) => {
  console.error('[probe] uncaughtException:', error?.name, error?.message);
  clearTimeout(timer);
  process.exit(1);
});

try {
  await import('./main.js');
  console.log('[probe] main.js 模块图加载完成');
} catch (error) {
  console.error('[probe] 导入失败:', error?.name, error?.message);
  clearTimeout(timer);
  process.exit(1);
}
