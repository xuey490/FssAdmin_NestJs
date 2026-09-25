import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';

import { pathToRegexp } from 'path-to-regexp';

import { ReadonlyModeGuard } from './readonly-mode.guard';

// 打桩 pathToRegexp：覆盖"返回 { regexp }"、"返回 RegExp"、"抛错回落"三种形态，
// 避免依赖具体版本的返回结构
jest.mock('path-to-regexp', () => ({ pathToRegexp: jest.fn() }));

const mockPathToRegexp = pathToRegexp as unknown as jest.Mock;

const createConfig = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const createContext = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('ReadonlyModeGuard', () => {
  beforeEach(() => {
    mockPathToRegexp.mockReset();
    // 默认返回一个带 regexp 字段的结果（path-to-regexp v8 形态）
    mockPathToRegexp.mockImplementation((path: string) => ({
      regexp: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`),
    }));
  });

  describe('非只读模式', () => {
    it.each([
      ['readonly=false', false],
      ['readonly 未配置', undefined],
      ['readonly 为非 true 字符串', 'true'],
    ])('%s 时放行所有请求', (_name, readonly) => {
      const guard = new ReadonlyModeGuard(createConfig({ 'app.readonly': readonly }));

      expect(guard.canActivate(createContext({ method: 'DELETE', url: '/api/x' }))).toBe(true);
    });
  });

  describe('只读模式下的安全方法', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('%s 永远放行', (method) => {
      const guard = new ReadonlyModeGuard(createConfig({ 'app.readonly': true }));

      expect(guard.canActivate(createContext({ method, url: '/api/anything' }))).toBe(true);
    });

    it('请求缺少 method 时按 GET 处理并放行', () => {
      const guard = new ReadonlyModeGuard(createConfig({ 'app.readonly': true }));

      expect(guard.canActivate(createContext({ url: '/api/anything' }))).toBe(true);
    });
  });

  describe('只读模式下的写操作', () => {
    it('白名单未配置时拒绝写操作', () => {
      const guard = new ReadonlyModeGuard(createConfig({ 'app.readonly': true }));

      expect(() => guard.canActivate(createContext({ method: 'POST', url: '/api/x' }))).toThrow(
        ForbiddenException,
      );
    });

    it('命中白名单（路径+方法都匹配）时放行', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/login', method: 'POST' }],
        }),
      );

      expect(
        guard.canActivate(createContext({ method: 'POST', url: '/api/system/auth/login' })),
      ).toBe(true);
    });

    it('路径匹配但方法不匹配时拒绝', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/login', method: 'POST' }],
        }),
      );

      expect(() =>
        guard.canActivate(createContext({ method: 'PUT', url: '/api/system/auth/login' })),
      ).toThrow(ForbiddenException);
    });

    it('方法匹配但路径不匹配时拒绝', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/login', method: 'POST' }],
        }),
      );

      expect(() => guard.canActivate(createContext({ method: 'POST', url: '/api/other' }))).toThrow(
        ForbiddenException,
      );
    });

    it('pathToRegexp 返回裸 RegExp 时也能匹配', () => {
      mockPathToRegexp.mockReturnValue(/^\/api\/system\/auth\/logout$/);
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/logout', method: 'POST' }],
        }),
      );

      expect(
        guard.canActivate(createContext({ method: 'POST', url: '/api/system/auth/logout' })),
      ).toBe(true);
    });

    it('pathToRegexp 抛错时回退为全等比较', () => {
      mockPathToRegexp.mockImplementation(() => {
        throw new Error('invalid path');
      });
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/legacy', method: 'POST' }],
        }),
      );

      expect(guard.canActivate(createContext({ method: 'POST', url: '/api/legacy' }))).toBe(true);
      expect(() =>
        guard.canActivate(createContext({ method: 'POST', url: '/api/legacy/child' })),
      ).toThrow(ForbiddenException);
    });

    it('存在 route.path 时优先按路由模板匹配', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/dept/:id', method: 'DELETE' }],
        }),
      );

      const request = { method: 'DELETE', url: '/api/system/dept/123', route: { path: '/api/system/dept/:id' } };

      expect(guard.canActivate(createContext(request))).toBe(true);
      expect(mockPathToRegexp).toHaveBeenCalledWith('/api/system/dept/:id');
    });

    it('白名单条目缺少 method 时视为不匹配', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/login' }],
        }),
      );

      expect(() =>
        guard.canActivate(createContext({ method: 'POST', url: '/api/system/auth/login' })),
      ).toThrow(ForbiddenException);
    });

    it('请求既无 route 也无 url 时使用空路径', () => {
      const guard = new ReadonlyModeGuard(
        createConfig({
          'app.readonly': true,
          'perm.router.whitelist': [{ path: '/api/system/auth/login', method: 'POST' }],
        }),
      );

      expect(() => guard.canActivate(createContext({ method: 'POST' }))).toThrow(ForbiddenException);
    });
  });
});
