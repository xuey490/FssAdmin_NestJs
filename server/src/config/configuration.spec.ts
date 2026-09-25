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
});
