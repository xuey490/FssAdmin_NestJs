/**
 * 临时验证脚本：加载 src/main.ts（等同 bun src/main.ts），
 * 12 秒后主动退出，用于查看启动横幅新增的"当前配置文件 / 当前运行模式"输出。跑完即删。
 */
const timer = setTimeout(() => {
  console.log('[probe] 横幅已输出，主动退出');
  process.exit(0);
}, 6000);

process.on('uncaughtException', (error) => {
  console.error('[probe] uncaughtException:', error?.name, error?.message);
  clearTimeout(timer);
  process.exit(1);
});

try {
  await import('./src/main');
} catch (error) {
  console.error('[probe] 启动失败:', (error as Error)?.message);
  clearTimeout(timer);
  process.exit(1);
}
