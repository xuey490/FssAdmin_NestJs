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
});
