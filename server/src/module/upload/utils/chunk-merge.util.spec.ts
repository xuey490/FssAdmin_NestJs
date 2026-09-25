import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isMergeInProgress, mergeChunksToFile } from './chunk-merge.util';

/** 创建独立临时目录，测试结束统一清理 */
const createWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-merge-'));
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });

  return {
    root,
    sourceDir,
    targetFile: path.join(root, 'merged.bin'),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

/** 统计残留的文件流句柄（运行时不支持该私有 API 时返回 0） */
const countFileStreamHandles = (): number => {
  const getActiveHandles = (process as any)._getActiveHandles;
  if (typeof getActiveHandles !== 'function') return 0;

  return (getActiveHandles.call(process) as any[]).filter((handle) => {
    const name = handle?.constructor?.name ?? '';
    return name === 'ReadStream' || name === 'WriteStream';
  }).length;
};

describe('mergeChunksToFile', () => {
  it('按分片序号升序合并，内容完整并删除分片目录', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'file@1'), 'AAA');
    fs.writeFileSync(path.join(ws.sourceDir, 'file@2'), 'BBBB');
    fs.writeFileSync(path.join(ws.sourceDir, 'file@3'), 'CC');

    const result = await mergeChunksToFile(ws.sourceDir, ws.targetFile);

    expect(result.chunkCount).toBe(3);
    expect(result.sizeBytes).toBe(9);
    expect(fs.readFileSync(ws.targetFile, 'utf8')).toBe('AAABBBBCC');
    expect(fs.existsSync(ws.sourceDir)).toBe(false);

    ws.dispose();
  });

  it('分片序号按数值排序（避免字符串排序导致的错乱）', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), '1');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@2'), '2');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@10'), 'x');

    await mergeChunksToFile(ws.sourceDir, ws.targetFile);

    expect(fs.readFileSync(ws.targetFile, 'utf8')).toBe('12x');

    ws.dispose();
  });

  it('忽略目录内的非文件条目', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');
    fs.mkdirSync(path.join(ws.sourceDir, 'nested-dir'));

    const result = await mergeChunksToFile(ws.sourceDir, ws.targetFile);

    expect(result.chunkCount).toBe(1);
    expect(fs.readFileSync(ws.targetFile, 'utf8')).toBe('A');

    ws.dispose();
  });

  it('分片目录为空时抛错', async () => {
    const ws = createWorkspace();

    await expect(mergeChunksToFile(ws.sourceDir, ws.targetFile)).rejects.toThrow(/分片目录为空/);

    ws.dispose();
  });

  it('目标文件写入失败时抛错而不是永久挂起，并保留分片目录以便重试', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');
    const badTarget = path.join(ws.root, 'not-exist-dir', 'merged.bin');

    await expect(mergeChunksToFile(ws.sourceDir, badTarget)).rejects.toBeTruthy();

    // 分片目录保留，半成品目标文件不存在
    expect(fs.existsSync(path.join(ws.sourceDir, 'f@1'))).toBe(true);
    expect(fs.existsSync(badTarget)).toBe(false);

    ws.dispose();
  });

  it('文件名缺少序号时排在末尾，不影响其它分片顺序', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'no-index'), 'Z');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), '1');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@2'), '2');

    await mergeChunksToFile(ws.sourceDir, ws.targetFile);

    expect(fs.readFileSync(ws.targetFile, 'utf8')).toBe('12Z');

    ws.dispose();
  });

  it('同一分片目录并发合并会被拒绝，且合并结束后守卫自动释放', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');

    expect(isMergeInProgress(ws.sourceDir)).toBe(false);

    const first = mergeChunksToFile(ws.sourceDir, ws.targetFile);
    expect(isMergeInProgress(ws.sourceDir)).toBe(true);

    await expect(mergeChunksToFile(ws.sourceDir, ws.targetFile)).rejects.toThrow(/正在合并/);
    await first;

    expect(isMergeInProgress(ws.sourceDir)).toBe(false);

    ws.dispose();
  });

  it('分片条目在扫描后消失（lstat 抛错）时跳过该项，不影响其它分片', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@2'), 'B');

    // 模拟"readdir 之后条目被移除/无权限"的竞态：让 f@2 的 lstat 抛错
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const originalLstat = realFs.lstatSync;
    const spy = jest
      .spyOn(realFs, 'lstatSync')
      .mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).endsWith('f@2')) {
          throw new Error('ENOENT: 条目在扫描后已被移除');
        }
        return (originalLstat as (...a: unknown[]) => unknown)(...args);
      }) as typeof realFs.lstatSync);

    try {
      const result = await mergeChunksToFile(ws.sourceDir, ws.targetFile);

      expect(result.chunkCount).toBe(1);
      expect(fs.readFileSync(ws.targetFile, 'utf8')).toBe('A');
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('合并失败且半成品清理也失败时，仍然上抛原始错误', async () => {
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');
    const badTarget = path.join(ws.root, 'missing-dir', 'merged.bin');

    // 让"删除半成品"这一步也失败，覆盖清理失败的兜底 catch
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const originalRm = realFs.rmSync;
    const spy = jest
      .spyOn(realFs, 'rmSync')
      .mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === badTarget) {
          throw new Error('EACCES: 半成品文件删除失败');
        }
        return (originalRm as (...a: unknown[]) => unknown)(...args);
      }) as typeof realFs.rmSync);

    try {
      await expect(mergeChunksToFile(ws.sourceDir, badTarget)).rejects.toThrow();

      // 分片仍然保留，便于客户端重试
      expect(fs.existsSync(path.join(ws.sourceDir, 'f@1'))).toBe(true);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('合并完成后不残留文件流句柄', async () => {
    const before = countFileStreamHandles();
    const ws = createWorkspace();
    fs.writeFileSync(path.join(ws.sourceDir, 'f@1'), 'A');
    fs.writeFileSync(path.join(ws.sourceDir, 'f@2'), 'B');

    await mergeChunksToFile(ws.sourceDir, ws.targetFile);

    expect(countFileStreamHandles()).toBeLessThanOrEqual(before);

    ws.dispose();
  });
});
