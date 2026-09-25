import configuration from './configuration';

describe('Configuration', () => {
  it('should return default values when env is not set', () => {
    const config = configuration();
    expect(config).toHaveProperty('app');
    expect(config).toHaveProperty('database');
    expect(config).toHaveProperty('jwt');
    expect(config).toHaveProperty('redis');
    expect(config).toHaveProperty('cors');
    expect(config).toHaveProperty('swagger');
    expect(config).toHaveProperty('log');

    expect(config.app.name).toBe('nextjs-server');
    expect(config.app.port).toBe(3000);
    expect(config.database.host).toBe('127.0.0.1');
    expect(config.swagger.enabled).toBe(false);
  });

  it('should respect environment variables', () => {
    process.env.APP_NAME = 'test-app';
    process.env.APP_PORT = '4000';

    const config = configuration();
    expect(config.app.name).toBe('test-app');
    expect(config.app.port).toBe(4000);

    delete process.env.APP_NAME;
    delete process.env.APP_PORT;
  });

  describe('运行模式推导（READONLY_MODE 与 DEBUG 解耦）', () => {
    const keys = ['DEBUG', 'READONLY_MODE', 'LOG_LEVEL', 'MEMORY_DUMP_ENABLED'] as const;
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
      keys.forEach((key) => {
        original[key] = process.env[key];
      });
    });

    afterEach(() => {
      keys.forEach((key) => {
        if (original[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original[key];
        }
      });
    });

    it('未配置 READONLY_MODE 时兼容回落：DEBUG=false 仍为只读', () => {
      delete process.env.READONLY_MODE;
      process.env.DEBUG = 'false';

      const config = configuration();

      expect(config.app.debug).toBe(false);
      expect(config.app.readonly).toBe(true);
      expect(config.app.readonlySource).toBe('DEBUG(兼容回落)');
      expect(config.log.effectiveLevel).toBe('warn');
    });

    it('未配置 READONLY_MODE 且 DEBUG=true 时为可写模式', () => {
      delete process.env.READONLY_MODE;
      delete process.env.MEMORY_DUMP_ENABLED;
      process.env.DEBUG = 'true';
      process.env.LOG_LEVEL = 'debug';

      const config = configuration();

      expect(config.app.readonly).toBe(false);
      expect(config.log.effectiveLevel).toBe('debug');
      expect(config.memory.dumpEnabled).toBe(true);
    });

    it('显式 READONLY_MODE 优先于 DEBUG，且日志级别仍按调试模式收敛', () => {
      process.env.DEBUG = 'true';
      process.env.READONLY_MODE = 'true';

      expect(configuration().app.readonly).toBe(true);
      expect(configuration().app.readonlySource).toBe('READONLY_MODE');

      process.env.DEBUG = 'false';
      process.env.READONLY_MODE = 'false';

      const config = configuration();

      expect(config.app.readonly).toBe(false);
      expect(config.app.readonlySource).toBe('READONLY_MODE');
      expect(config.log.effectiveLevel).toBe('warn');
    });

    it('显式 MEMORY_DUMP_ENABLED 覆盖调试模式推导', () => {
      process.env.DEBUG = 'true';
      process.env.MEMORY_DUMP_ENABLED = 'false';

      expect(configuration().memory.dumpEnabled).toBe(false);
    });
  });

  describe('运行时与内存阈值派生（Node / Bun 分支）', () => {
    const managedKeys = [
      'NODE_ENV',
      'MEMORY_BUN_MONITOR_ENABLED',
      'MEMORY_RSS_WARN_MB',
      'MEMORY_RSS_FATAL_MB',
      'MEMORY_FATAL_EXIT',
      'MEMORY_RSS_FATAL_ENABLED',
      'MEMORY_HEAP_USAGE_ENABLED',
    ] as const;

    type ManagedKey = (typeof managedKeys)[number];

    /**
     * 在指定"运行时 + 环境变量"组合下重新加载 configuration。
     * isBunRuntime 在模块加载阶段求值，因此必须重置模块缓存后再导入，否则拿不到 Bun 分支。
     * @param runtime 模拟的运行时
     * @param env 本次要设置的环境变量（未列出的受管键会被清空，避免相互影响）
     */
    const loadConfigIn = async (
      runtime: 'node' | 'bun',
      env: Partial<Record<ManagedKey, string>>,
    ) => {
      const saved: Partial<Record<ManagedKey, string | undefined>> = {};

      for (const key of managedKeys) {
        saved[key] = process.env[key];
        if (key in env) {
          process.env[key] = env[key];
        } else {
          delete process.env[key];
        }
      }

      const versions = process.versions as { bun?: string };
      const savedBun = versions.bun;
      if (runtime === 'bun') {
        versions.bun = '1.3.14';
      } else {
        delete versions.bun;
      }

      jest.resetModules();
      const config = (await import('./configuration')).default();

      if (savedBun === undefined) {
        delete versions.bun;
      } else {
        versions.bun = savedBun;
      }
      for (const key of managedKeys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }

      return config;
    };

    it('未设置 NODE_ENV 时回落为 development', async () => {
      const config = await loadConfigIn('node', {});

      expect(config.app.env).toBe('development');
    });

    it('Node 未显式配置时使用 Node 默认阈值并启用堆口径', async () => {
      const config = await loadConfigIn('node', {});

      expect(config.memory.rssWarnMb).toBe(300);
      expect(config.memory.rssFatalMb).toBe(450);
      expect(config.memory.heapUsageEnabled).toBe(true);
      expect(config.memory.rssFatalEnabled).toBe(true);
    });

    it('Bun 未开启内存监控时用保守阈值，并关闭堆口径与 RSS 致命判定', async () => {
      const config = await loadConfigIn('bun', {});

      expect(config.memory.bunMonitorEnabled).toBe(false);
      expect(config.memory.rssWarnMb).toBe(768);
      expect(config.memory.rssFatalMb).toBe(1536);
      expect(config.memory.heapUsageEnabled).toBe(false);
      expect(config.memory.rssFatalEnabled).toBe(false);
    });

    it('Bun 显式开启监控后用 1200/1600 阈值并启用 RSS 致命判定', async () => {
      const config = await loadConfigIn('bun', { MEMORY_BUN_MONITOR_ENABLED: 'true' });

      expect(config.memory.bunMonitorEnabled).toBe(true);
      expect(config.memory.rssWarnMb).toBe(1200);
      expect(config.memory.rssFatalMb).toBe(1600);
      expect(config.memory.rssFatalEnabled).toBe(true);
    });

    it('显式阈值与堆口径开关优先于运行时默认值', async () => {
      const config = await loadConfigIn('bun', {
        MEMORY_RSS_WARN_MB: '900',
        MEMORY_RSS_FATAL_MB: '1200',
        MEMORY_RSS_FATAL_ENABLED: 'false',
        MEMORY_HEAP_USAGE_ENABLED: 'true',
      });

      expect(config.memory.rssWarnMb).toBe(900);
      expect(config.memory.rssFatalMb).toBe(1200);
      expect(config.memory.rssFatalEnabled).toBe(false);
      expect(config.memory.heapUsageEnabled).toBe(true);
    });

    it('fatalExit：MEMORY_FATAL_EXIT=true 时开启', async () => {
      const config = await loadConfigIn('node', { MEMORY_FATAL_EXIT: 'true' });

      expect(config.memory.fatalExit).toBe(true);
    });

    it('fatalExit：生产环境未显式关闭时默认开启', async () => {
      const config = await loadConfigIn('node', { NODE_ENV: 'production' });

      expect(config.memory.fatalExit).toBe(true);
    });

    it('fatalExit：生产环境显式 false 时关闭', async () => {
      const config = await loadConfigIn('node', {
        NODE_ENV: 'production',
        MEMORY_FATAL_EXIT: 'false',
      });

      expect(config.memory.fatalExit).toBe(false);
    });

    it('fatalExit：非生产环境未设置时关闭', async () => {
      const config = await loadConfigIn('node', { NODE_ENV: 'test' });

      expect(config.memory.fatalExit).toBe(false);
    });
  });
});
