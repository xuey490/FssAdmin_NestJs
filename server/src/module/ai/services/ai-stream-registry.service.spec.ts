import { AiStreamRegistry } from './ai-stream-registry.service';
import type { LlmSemaphoreService } from './llm-semaphore.service';

/** 构造登记表实例；容量上限 = max(64, 并发上限 × 4) */
const createRegistry = (maxConcurrent = 2) =>
  new AiStreamRegistry({ maxConcurrent } as LlmSemaphoreService);

describe('AiStreamRegistry', () => {
  it('登记后 size 增加，注销后减少', () => {
    const registry = createRegistry();

    registry.register('msg-1', { abort: new AbortController(), sessionUuid: 'session-1' });
    expect(registry.size).toBe(1);

    const removed = registry.unregister('msg-1');
    expect(removed?.sessionUuid).toBe('session-1');
    expect(registry.size).toBe(0);
  });

  it('注销是幂等的，未登记时返回 undefined', () => {
    const registry = createRegistry();

    expect(registry.unregister('not-exist')).toBeUndefined();
    registry.register('msg-1', { abort: new AbortController(), sessionUuid: 'session-1' });
    expect(registry.unregister('msg-1')).toBeDefined();
    expect(registry.unregister('msg-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('同一 messageUuid 重复登记只占一个位置，并保留最新条目', () => {
    const registry = createRegistry();
    const first = new AbortController();
    const second = new AbortController();

    registry.register('msg-1', { abort: first, sessionUuid: 'session-1' });
    registry.register('msg-1', { abort: second, sessionUuid: 'session-2' });

    expect(registry.size).toBe(1);
    expect(registry.unregister('msg-1')?.sessionUuid).toBe('session-2');
  });

  it('超过容量上限时驱逐最早登记的条目（防止无界增长）', () => {
    const registry = createRegistry(1); // 上限 = max(64, 4) = 64

    for (let i = 1; i <= 64; i += 1) {
      registry.register(`msg-${i}`, { abort: new AbortController(), sessionUuid: 'session-1' });
    }
    expect(registry.size).toBe(64);

    registry.register('msg-65', { abort: new AbortController(), sessionUuid: 'session-1' });

    expect(registry.size).toBe(64);
    expect(registry.unregister('msg-1')).toBeUndefined(); // 最早的已被驱逐
    expect(registry.unregister('msg-65')).toBeDefined();
  });

  it('按 messageUuid 中止会 abort 对应控制器并移出登记表', () => {
    const registry = createRegistry();
    const abort = new AbortController();
    registry.register('msg-1', { abort, sessionUuid: 'session-1' });

    expect(registry.abort('msg-1')).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('按 sessionUuid 中止会 abort 该会话下的流', () => {
    const registry = createRegistry();
    const target = new AbortController();
    const other = new AbortController();
    registry.register('msg-1', { abort: other, sessionUuid: 'session-other' });
    registry.register('msg-2', { abort: target, sessionUuid: 'session-1' });

    expect(registry.abort(undefined, 'session-1')).toBe(true);
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('按 sessionUuid 中止会停掉该会话下的全部并发流', () => {
    const registry = createRegistry();
    const first = new AbortController();
    const second = new AbortController();
    const other = new AbortController();
    registry.register('msg-1', { abort: first, sessionUuid: 'session-1' });
    registry.register('msg-2', { abort: second, sessionUuid: 'session-1' });
    registry.register('msg-3', { abort: other, sessionUuid: 'session-other' });

    expect(registry.abort(undefined, 'session-1')).toBe(true);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('未命中任何条目时中止返回 false', () => {
    const registry = createRegistry();

    expect(registry.abort('not-exist')).toBe(false);
    expect(registry.abort(undefined, 'not-exist')).toBe(false);
  });

  it('模块销毁时清空登记表', () => {
    const registry = createRegistry();
    registry.register('msg-1', { abort: new AbortController(), sessionUuid: 'session-1' });

    registry.onModuleDestroy();

    expect(registry.size).toBe(0);
  });
});
