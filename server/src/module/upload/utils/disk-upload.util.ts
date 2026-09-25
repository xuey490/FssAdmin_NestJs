import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Multer 磁盘落盘临时目录（`FileInterceptor('file', { dest: UPLOAD_TEMP_DIR })`）。
 *
 * 使用系统临时目录承载上传内容，避免把整份文件读进内存；
 * 业务处理完成后再移动到最终上传目录，失败时由调用方清理临时文件。
 */
export const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'fssadmin-upload-tmp');

export interface PersistedUpload {
  /** 落盘后的字节数 */
  sizeBytes: number;
  /** 文件内容 MD5 */
  hash: string;
}

/**
 * 流式计算文件 MD5，不把整份文件读入内存。
 * @param filePath 文件路径
 * @returns MD5 十六进制字符串
 */
export function hashFileByPath(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 删除 Multer 落盘的临时文件（校验失败或异常分支调用），避免临时目录堆积。
 * @param file Multer 文件对象（仅磁盘落盘时带 path）
 */
export function cleanupUploadedFile(file?: { path?: string }): void {
  if (!file?.path) return;

  try {
    fs.rmSync(file.path, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 把 Multer 上传结果持久化到目标路径，并返回体积与 MD5。
 *
 * - 磁盘落盘（配置了 `dest`/`diskStorage`）：源为临时文件，优先 `rename` 移动，跨盘时退化为复制 + 删除，
 *   随后流式计算哈希，全程不把整份文件读进内存；
 * - 内存存储（未配置 `dest` 的兼容场景）：退化为直接写入 Buffer。
 *
 * @param file Multer 文件对象（磁盘落盘时有 `path`，内存存储时有 `buffer`）
 * @param targetFile 目标文件绝对路径
 * @returns 字节数与 MD5
 */
export async function persistUploadedFile(
  file: { path?: string; buffer?: Buffer },
  targetFile: string,
): Promise<PersistedUpload> {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });

  if (file?.path) {
    try {
      await moveFile(file.path, targetFile);
      const hash = await hashFileByPath(targetFile);
      const { size } = await fs.promises.stat(targetFile);
      return { sizeBytes: size, hash };
    } catch (error) {
      // 已移动到目标路径但后续步骤失败时删除目标文件，避免留下无记录的孤儿文件
      try {
        fs.rmSync(targetFile, { force: true });
      } catch {
        /* 清理失败不影响错误上抛 */
      }

      throw error;
    } finally {
      cleanupUploadedFile(file);
    }
  }

  const buffer = file?.buffer ?? Buffer.alloc(0);
  await fs.promises.writeFile(targetFile, buffer);

  return {
    sizeBytes: buffer.length,
    hash: crypto.createHash('md5').update(buffer).digest('hex'),
  };
}

/**
 * 清理上传临时目录中的陈旧文件（进程异常退出或流程中断遗留）。
 *
 * 建议在应用启动时调用一次：上层（守卫/管道）中断请求时 Multer 已完成落盘的文件不会被业务代码感知，
 * 由本方法兜底回收。只删除超过 `maxAgeMs` 未被修改的文件，避免误删正在上传的文件。
 *
 * @param maxAgeMs 视为陈旧的最大存活时间（默认 2 小时）
 * @returns 实际清理的文件数量
 */
export function cleanupStaleTempUploads(maxAgeMs: number = 2 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: string[];

  try {
    entries = fs.readdirSync(UPLOAD_TEMP_DIR);
  } catch {
    return 0; // 临时目录尚未创建
  }

  for (const name of entries) {
    const filePath = path.join(UPLOAD_TEMP_DIR, name);

    try {
      const fileStat = fs.statSync(filePath);
      if (fileStat.isFile() && fileStat.mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      }
    } catch {
      /* 单项清理失败不影响其它文件 */
    }
  }

  return removed;
}

/**
 * 移动文件；跨设备（EXDEV）时退化为复制 + 删除源文件。
 * @param source 源文件
 * @param target 目标文件
 */
async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') {
      throw error;
    }
  }

  await fs.promises.copyFile(source, target);
  await fs.promises.rm(source, { force: true });
}
