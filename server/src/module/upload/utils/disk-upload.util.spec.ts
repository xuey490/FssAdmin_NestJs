import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cleanupStaleTempUploads,
  cleanupUploadedFile,
  hashFileByPath,
  persistUploadedFile,
  UPLOAD_TEMP_DIR,
} from './disk-upload.util';

const md5 = (content: string) => crypto.createHash('md5').update(content).digest('hex');

/** 创建独立临时工作区，测试结束统一清理 */
const createWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-upload-'));
  return {
    root,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

describe('disk-upload.util', () => {
  it('磁盘落盘：移动到目标路径、流式哈希正确、临时文件被清理', async () => {
    const ws = createWorkspace();
    const sourceFile = path.join(ws.root, 'temp-upload');
    const targetFile = path.join(ws.root, 'nested', 'final.bin');
    fs.writeFileSync(sourceFile, 'hello-disk');

    const result = await persistUploadedFile({ path: sourceFile }, targetFile);

    expect(result.sizeBytes).toBe(10);
    expect(result.hash).toBe(md5('hello-disk'));
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('hello-disk');
    expect(fs.existsSync(sourceFile)).toBe(false);

    ws.dispose();
  });

  it('内存 Buffer 路径（兼容未配置 dest 的场景）', async () => {
    const ws = createWorkspace();
    const targetFile = path.join(ws.root, 'buffer.bin');

    const result = await persistUploadedFile({ buffer: Buffer.from('hello-memory') }, targetFile);

    expect(result.sizeBytes).toBe(12);
    expect(result.hash).toBe(md5('hello-memory'));
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('hello-memory');

    ws.dispose();
  });

  it('空文件也能正确落盘与哈希', async () => {
    const ws = createWorkspace();
    const targetFile = path.join(ws.root, 'empty.bin');

    const result = await persistUploadedFile({ buffer: Buffer.alloc(0) }, targetFile);

    expect(result.sizeBytes).toBe(0);
    expect(result.hash).toBe(md5(''));
    expect(fs.existsSync(targetFile)).toBe(true);

    ws.dispose();
  });

  it('hashFileByPath 与一次性计算一致', async () => {
    const ws = createWorkspace();
    const file = path.join(ws.root, 'hash.bin');
    fs.writeFileSync(file, 'abcdef');

    await expect(hashFileByPath(file)).resolves.toBe(md5('abcdef'));

    ws.dispose();
  });

  it('cleanupUploadedFile 删除临时文件，且对无 path 的输入安全', () => {
    const ws = createWorkspace();
    const tempFile = path.join(ws.root, 'temp');
    fs.writeFileSync(tempFile, 'x');

    cleanupUploadedFile({ path: tempFile });
    expect(fs.existsSync(tempFile)).toBe(false);
    expect(() => cleanupUploadedFile({})).not.toThrow();
    expect(() => cleanupUploadedFile(undefined)).not.toThrow();

    ws.dispose();
  });

  it('cleanupStaleTempUploads 只清理临时目录中的陈旧文件', () => {
    fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
    const staleFile = path.join(UPLOAD_TEMP_DIR, `stale-${Date.now()}`);
    const freshFile = path.join(UPLOAD_TEMP_DIR, `fresh-${Date.now()}`);
    fs.writeFileSync(staleFile, 'old');
    fs.writeFileSync(freshFile, 'new');
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, threeHoursAgo, threeHoursAgo);

    const removed = cleanupStaleTempUploads(2 * 60 * 60 * 1000);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);

    fs.rmSync(freshFile, { force: true });
  });

  it('临时目录常量指向系统临时目录下的专用子目录', () => {
    expect(UPLOAD_TEMP_DIR.startsWith(os.tmpdir())).toBe(true);
    expect(UPLOAD_TEMP_DIR.endsWith('fssadmin-upload-tmp')).toBe(true);
  });

  it('persistUploadedFile：源文件不存在时上抛错误且不留下半成品', async () => {
    const ws = createWorkspace();
    const missingSource = path.join(ws.root, 'not-exist');
    const targetFile = path.join(ws.root, 'out.bin');

    await expect(persistUploadedFile({ path: missingSource }, targetFile)).rejects.toThrow(/ENOENT/);

    expect(fs.existsSync(targetFile)).toBe(false);

    ws.dispose();
  });

  it('persistUploadedFile：失败后删除目标文件，且删除再失败也不掩盖原始错误', async () => {
    const ws = createWorkspace();
    const missingSource = path.join(ws.root, 'not-exist');
    const targetFile = path.join(ws.root, 'out.bin');

    // 让"删除目标文件"这一步也失败，覆盖清理失败的兜底 catch
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const originalRm = realFs.rmSync;
    const spy = jest
      .spyOn(realFs, 'rmSync')
      .mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === targetFile) {
          throw new Error('EACCES: 目标文件删除失败');
        }
        return (originalRm as (...a: unknown[]) => unknown)(...args);
      }) as typeof realFs.rmSync);

    try {
      await expect(persistUploadedFile({ path: missingSource }, targetFile)).rejects.toThrow(/ENOENT/);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('persistUploadedFile：无 path 且无 buffer 时按空文件落盘', async () => {
    const ws = createWorkspace();
    const targetFile = path.join(ws.root, 'empty-fallback.bin');

    const result = await persistUploadedFile({}, targetFile);

    expect(result.sizeBytes).toBe(0);
    expect(result.hash).toBe(md5(''));
    expect(fs.existsSync(targetFile)).toBe(true);

    ws.dispose();
  });

  it('persistUploadedFile：file 为 undefined 时也按空文件落盘（兼容调用方漏传）', async () => {
    const ws = createWorkspace();
    const targetFile = path.join(ws.root, 'undefined-file.bin');

    const result = await persistUploadedFile(
      undefined as unknown as { path?: string; buffer?: Buffer },
      targetFile,
    );

    expect(result.sizeBytes).toBe(0);
    expect(result.hash).toBe(md5(''));

    ws.dispose();
  });

  it('persistUploadedFile：已移动成功但后续 stat 失败时删除目标文件并上抛', async () => {
    const ws = createWorkspace();
    const sourceFile = path.join(ws.root, 'temp-upload');
    const targetFile = path.join(ws.root, 'nested', 'final.bin');
    fs.writeFileSync(sourceFile, 'moved-then-fail');

    // 移动与哈希都成功，仅最后一步 stat 失败，覆盖"清理已落盘目标文件"的 catch 路径
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const spy = jest
      .spyOn(realFs.promises, 'stat')
      .mockImplementation((() =>
        Promise.reject(new Error('EIO: stat 失败'))) as typeof realFs.promises.stat);

    try {
      await expect(persistUploadedFile({ path: sourceFile }, targetFile)).rejects.toThrow(/EIO/);

      expect(fs.existsSync(targetFile)).toBe(false);
      expect(fs.existsSync(sourceFile)).toBe(false);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('persistUploadedFile：已移动成功但哈希阶段失败时清理目标文件', async () => {
    const ws = createWorkspace();
    const sourceFile = path.join(ws.root, 'temp-upload');
    const targetFile = path.join(ws.root, 'nested', 'final.bin');
    fs.writeFileSync(sourceFile, 'moved-then-hash-fail');

    // 移动成功，读取目标文件做流式哈希时失败
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const spy = jest
      .spyOn(realFs, 'createReadStream')
      .mockImplementation((() => {
        throw new Error('EIO: 读取目标文件失败');
      }) as typeof realFs.createReadStream);

    try {
      await expect(persistUploadedFile({ path: sourceFile }, targetFile)).rejects.toThrow(/EIO/);

      expect(fs.existsSync(targetFile)).toBe(false);
      expect(fs.existsSync(sourceFile)).toBe(false);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('persistUploadedFile：跨设备（EXDEV）时退化为复制 + 删除源文件', async () => {
    const ws = createWorkspace();
    const sourceFile = path.join(ws.root, 'temp-upload');
    const targetFile = path.join(ws.root, 'nested', 'final.bin');
    fs.writeFileSync(sourceFile, 'cross-device');

    // rename 抛 EXDEV，迫使走 copyFile + rm 的分支
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const spy = jest
      .spyOn(realFs.promises, 'rename')
      .mockImplementation((() => {
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
        error.code = 'EXDEV';

        return Promise.reject(error);
      }) as typeof realFs.promises.rename);

    try {
      const result = await persistUploadedFile({ path: sourceFile }, targetFile);

      expect(result.sizeBytes).toBe(12);
      expect(result.hash).toBe(md5('cross-device'));
      expect(fs.readFileSync(targetFile, 'utf8')).toBe('cross-device');
      expect(fs.existsSync(sourceFile)).toBe(false);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('cleanupUploadedFile：删除失败时静默忽略', () => {
    const ws = createWorkspace();
    const tempFile = path.join(ws.root, 'temp');
    fs.writeFileSync(tempFile, 'x');

    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const originalRm = realFs.rmSync;
    const spy = jest
      .spyOn(realFs, 'rmSync')
      .mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === tempFile) {
          throw new Error('EACCES: 删除失败');
        }
        return (originalRm as (...a: unknown[]) => unknown)(...args);
      }) as typeof realFs.rmSync);

    try {
      expect(() => cleanupUploadedFile({ path: tempFile })).not.toThrow();
      expect(fs.existsSync(tempFile)).toBe(true);
    } finally {
      spy.mockRestore();
      ws.dispose();
    }
  });

  it('cleanupStaleTempUploads：临时目录尚未创建时返回 0', () => {
    fs.rmSync(UPLOAD_TEMP_DIR, { recursive: true, force: true });

    expect(cleanupStaleTempUploads()).toBe(0);

    fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
  });

  it('cleanupStaleTempUploads：单项 stat 失败时跳过该项，不影响其它文件', () => {
    fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
    const badFile = path.join(UPLOAD_TEMP_DIR, `bad-${Date.now()}`);
    const staleFile = path.join(UPLOAD_TEMP_DIR, `stale2-${Date.now()}`);
    fs.writeFileSync(badFile, 'x');
    fs.writeFileSync(staleFile, 'y');
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, threeHoursAgo, threeHoursAgo);

    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const originalStat = realFs.statSync;
    const spy = jest
      .spyOn(realFs, 'statSync')
      .mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === badFile) {
          throw new Error('EACCES: stat 失败');
        }
        return (originalStat as (...a: unknown[]) => unknown)(...args);
      }) as typeof realFs.statSync);

    try {
      const removed = cleanupStaleTempUploads(2 * 60 * 60 * 1000);

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(badFile)).toBe(true);
    } finally {
      spy.mockRestore();
      fs.rmSync(badFile, { force: true });
    }
  });
});
