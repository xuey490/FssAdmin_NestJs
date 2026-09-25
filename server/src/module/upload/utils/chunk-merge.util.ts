import * as fs from 'node:fs';
import * as path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

/** 分片文件名的序号分隔符（格式：`<任意>@<序号>`） */
const CHUNK_INDEX_SEPARATOR = '@';

/** 正在合并中的分片目录（绝对路径），避免同一批分片被并发合并而互相破坏 */
const mergingDirs = new Set<string>();

export interface ChunkMergeResult {
  /** 实际合并的分片数量 */
  chunkCount: number;
  /** 合并后的文件字节数 */
  sizeBytes: number;
}

/**
 * 提取分片序号。
 * 文件名不含分隔符或序号非数字时返回极大值，保证异常分片排在末尾而不是打乱排序。
 * @param fileName 分片文件名
 * @returns 分片序号
 */
function chunkIndex(fileName: string): number {
  const index = Number(fileName.split(CHUNK_INDEX_SEPARATOR)[1]);
  return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

/**
 * 指定分片目录是否正在合并中（供调用方提前返回友好提示，真正的互斥由内部守卫保证）。
 * @param sourceDir 分片文件所在目录
 */
export function isMergeInProgress(sourceDir: string): boolean {
  return mergingDirs.has(path.resolve(sourceDir));
}

/**
 * 按分片序号升序把分片目录流式合并为单个文件。
 *
 * 与旧实现（手写递归 `pipe(..., { end: false })`）的关键差异：
 * - 使用 `stream.pipeline` 逐分片写入，读取失败会正确传播而不是静默断链；
 * - 全部写完后显式 `end()` 并等待 `finish`，确保文件 flush、句柄释放；
 * - 任一步骤失败都会 `destroy()` 写流并删除半成品目标文件，再把错误抛给调用方（不会永久挂起）；
 * - 同一分片目录并发合并会被拒绝，避免两个调用互相覆盖目标文件。
 *
 * 失败时**保留分片目录**，便于客户端重试合并；成功后才删除分片目录。
 *
 * @param sourceDir 分片文件所在目录
 * @param targetFile 合并后的目标文件路径
 * @returns 分片数量与最终字节数
 * @throws 该批次正在合并、分片目录为空、分片读取失败、目标文件写入失败时抛出
 */
export async function mergeChunksToFile(
  sourceDir: string,
  targetFile: string,
): Promise<ChunkMergeResult> {
  const mergeKey = path.resolve(sourceDir);

  if (mergingDirs.has(mergeKey)) {
    throw new Error(`该分片批次正在合并中，请勿重复提交：${sourceDir}`);
  }
  mergingDirs.add(mergeKey);

  try {
    const chunkFiles = fs
      .readdirSync(sourceDir)
      .filter((name) => {
        try {
          return fs.lstatSync(path.join(sourceDir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => chunkIndex(a) - chunkIndex(b));

    if (chunkFiles.length === 0) {
      throw new Error(`分片目录为空，无法合并：${sourceDir}`);
    }

    const writeStream = fs.createWriteStream(targetFile);
    // 先创建结束等待 Promise，保证写入阶段的 error 一定被消费（避免 unhandled 'error' / 未处理 rejection）
    const writeFinished = finished(writeStream);
    writeFinished.catch(() => undefined);

    try {
      for (const name of chunkFiles) {
        // end: false —— 逐分片追加，写流由下方统一收尾
        await pipeline(fs.createReadStream(path.join(sourceDir, name)), writeStream, {
          end: false,
        });
      }

      writeStream.end();
      await writeFinished;

      const sizeBytes = fs.statSync(targetFile).size;
      fs.rmSync(sourceDir, { recursive: true, force: true });

      return { chunkCount: chunkFiles.length, sizeBytes };
    } catch (error) {
      writeStream.destroy();
      try {
        fs.rmSync(targetFile, { force: true });
      } catch {
        /* 清理半成品失败不影响错误上抛 */
      }

      throw error;
    }
  } finally {
    mergingDirs.delete(mergeKey);
  }
}
