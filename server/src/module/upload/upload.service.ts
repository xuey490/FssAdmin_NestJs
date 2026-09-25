import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as iconv from 'iconv-lite';
import * as path from 'path';
import * as fs from 'fs';
import * as mime from 'mime-types';

import { ResultData } from '../../common/utils/result';
import { generateUUID } from '../../common/utils/index';
import { UploadEntity } from './entities/upload.entity';
import { AttachmentCategoryEntity } from './entities/attachment-category.entity';
import { ChunkFileDto, ChunkMergeFileDto } from './dto/index';
import { isMergeInProgress, mergeChunksToFile } from './utils/chunk-merge.util';
import {
  cleanupStaleTempUploads,
  cleanupUploadedFile,
  hashFileByPath,
  persistUploadedFile,
} from './utils/disk-upload.util';

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private readonly thunkDir = 'thunk';

  constructor(
    @InjectRepository(UploadEntity)
    private readonly uploadRepo: Repository<UploadEntity>,
    @InjectRepository(AttachmentCategoryEntity)
    private readonly categoryRepo: Repository<AttachmentCategoryEntity>,
    private readonly config: ConfigService,
  ) {}

  private getUploadDir() {
    return path.resolve(process.cwd(), this.config.get('file.uploadDir') || '../upload');
  }

  /**
   * 启动时清理上传临时目录中的陈旧文件（上层中断请求时 Multer 已落盘但未被业务代码感知的文件）。
   */
  onModuleInit(): void {
    const removed = cleanupStaleTempUploads();
    if (removed > 0) {
      this.logger.log(`已清理 ${removed} 个陈旧的临时上传文件`);
    }
  }

  /**
   * 生成新的文件名
   * 基于时间戳和 UUID 生成唯一文件名，保留原文件扩展名。
   * @param originalname - 原始文件名
   * @returns 新文件名（长度不超过 50 字符）
   */
  private getNewFileName(originalname: string): string {
    const extName = path.extname(originalname || '').replace(/\./g, '');
    const ext = extName ? `.${extName.slice(0, 10)}` : '';
    const unique = `${Date.now()}_${generateUUID().replace(/-/g, '').slice(0, 16)}`;
    const maxLength = 50;
    const maxBaseLength = Math.max(1, maxLength - ext.length);
    return `${unique.slice(0, maxBaseLength)}${ext}`;
  }

  private buildFileUrl(fileName: string) {
    const domain = String(this.config.get('file.domain') || '').replace(/\/+$/, '');
    const serveRoot = this.config.get('file.serveRoot') || '/profile';
    const pathStr = String(fileName || '').replace(/^\/+/, '');
    return domain ? `${domain}${serveRoot}/${pathStr}` : `${serveRoot}/${pathStr}`;
  }

  /**
   * 递归创建目录
   * 若父目录不存在则先创建父目录。
   * @param dirname - 目录路径
   * @returns 是否创建成功
   */
  private mkdirsSync(dirname: string) {
    if (fs.existsSync(dirname)) return true;
    if (this.mkdirsSync(path.dirname(dirname))) {
      fs.mkdirSync(dirname);
      return true;
    }
    return false;
  }

  /**
   * 单文件上传
   * 校验文件大小、扩展名、MIME 类型，保存至本地磁盘并记录上传信息至数据库。
   * @param file - 上传的文件（Multer 格式）
   * @returns 包含 fileName、newFileName、url 的上传结果
   * @throws BadRequestException 文件大小超限或格式不支持时抛出
   */
  async singleFileUpload(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择上传文件');

    const allowedExtensions: string[] = this.config.get<string[]>('file.allowedExtensions') || [];
    const originalname = iconv.decode(Buffer.from(file.originalname, 'binary'), 'utf8');
    const maxSize = Number(this.config.get('file.maxSize') || 10);

    try {
      if (file.size / 1024 / 1024 > maxSize) {
        throw new BadRequestException(`文件大小不能超过${maxSize}MB`);
      }

      // 校验文件扩展名
      const ext = path.extname(originalname).toLowerCase().replace('.', '');
      if (allowedExtensions.length > 0 && ext && !allowedExtensions.includes(ext)) {
        throw new BadRequestException(
          `不支持的文件格式 .${ext}，允许的格式: ${allowedExtensions.join(', ')}`,
        );
      }

      // 额外校验 MIME 类型（防止伪装扩展名）
      if (allowedExtensions.length > 0 && file.mimetype && !file.mimetype.startsWith('image/')) {
        throw new BadRequestException('仅允许上传图片文件');
      }
    } catch (error) {
      // 校验失败也要清理已落盘的临时文件，避免临时目录堆积
      cleanupUploadedFile(file);
      throw error;
    }

    const uploadDir = this.getUploadDir();
    const newFileName = this.getNewFileName(originalname);
    const targetFile = path.join(uploadDir, newFileName);

    // 磁盘落盘 + 流式哈希：不把整份文件读入内存
    const persisted = await persistUploadedFile(file, targetFile);

    const serveRoot = this.config.get('file.serveRoot') || '/profile';
    const fileName = `${serveRoot}/${newFileName}`.replace(/\\/g, '/');
    const url = this.buildFileUrl(newFileName);
    const res = { fileName, newFileName, url };

    await this.uploadRepo.save({
      categoryId: 0,
      storageMode: 1,
      originName: originalname,
      objectName: newFileName,
      hash: persisted.hash,
      mimeType: file.mimetype || 'application/octet-stream',
      storagePath: newFileName,
      suffix: path.extname(newFileName).replace('.', ''),
      sizeByte: persisted.sizeBytes,
      sizeInfo: this.formatSize(persisted.sizeBytes),
      url,
    });

    return res;
  }

  /**
   * 分片上传
   * 将文件分片保存至临时目录，等待后续合并。
   * @param file - 当前分片的文件数据
   * @param body - 分片信息（uploadId、index、fileName 等）
   * @returns 操作结果
   */
  async chunkFileUpload(file: Express.Multer.File, body: ChunkFileDto) {
    const baseDirPath = path.join(this.getUploadDir(), this.thunkDir, body.uploadId);
    if (!fs.existsSync(baseDirPath)) {
      this.mkdirsSync(baseDirPath);
    }
    const chunkFilePath = path.join(baseDirPath, `${body.uploadId}${body.fileName}@${body.index}`);

    if (fs.existsSync(chunkFilePath)) {
      // 分片已存在：直接丢弃本次上传的临时文件即可
      cleanupUploadedFile(file);
      return ResultData.ok();
    }

    // 磁盘落盘：分片内容不进入内存
    await persistUploadedFile(file, chunkFilePath);
    return ResultData.ok();
  }

  /**
   * 合并分片文件
   * 将上传的所有分片按顺序合并为一个完整文件，并记录至数据库。
   * @param body - 合并信息（uploadId、fileName 等）
   * @returns 包含文件名、新文件名、URL 的合并结果
   */
  async chunkMergeFile(body: ChunkMergeFileDto) {
    const uploadDir = this.getUploadDir();
    const sourceFilesDir = path.join(uploadDir, this.thunkDir, body.uploadId);
    if (!fs.existsSync(sourceFilesDir)) {
      return ResultData.fail(500, '文件不存在');
    }

    const newFileName = this.getNewFileName(body.fileName);
    const targetFile = path.join(uploadDir, newFileName);

    if (isMergeInProgress(sourceFilesDir)) {
      return ResultData.fail(429, '该文件正在合并中，请稍后再试');
    }

    try {
      await mergeChunksToFile(sourceFilesDir, targetFile);
    } catch (error) {
      const reason = (error as Error)?.message ?? '';
      this.logger.error(`分片合并失败 uploadId=${body.uploadId}: ${reason}`);

      // 并发重复提交给出可重试提示，其它失败按通用错误返回
      return reason.includes('正在合并')
        ? ResultData.fail(429, '该文件正在合并中，请稍后再试')
        : ResultData.fail(500, '分片合并失败，请重试');
    }

    const serveRoot = this.config.get('file.serveRoot') || '/profile';
    const fileName = `${serveRoot}/${newFileName}`.replace(/\\/g, '/');
    const url = this.buildFileUrl(newFileName);
    const stats = fs.statSync(targetFile);
    const data = { fileName, newFileName, url };

    await this.uploadRepo.save({
      categoryId: 0,
      storageMode: 1,
      originName: body.fileName,
      objectName: newFileName,
      hash: '',
      mimeType: (mime.lookup(body.fileName) as string) || 'application/octet-stream',
      storagePath: newFileName,
      suffix: path.extname(newFileName).replace('.', ''),
      sizeByte: stats.size,
      sizeInfo: this.formatSize(stats.size),
      url,
    });

    return ResultData.ok(data);
  }

  /**
   * 格式化附件数据
   * 将 UploadEntity 转换为前端所需的驼峰/下划线混合格式。
   * @param item - 附件实体
   * @returns 格式化后的附件对象
   */
  private formatAttachment(item: UploadEntity) {
    return {
      id: item.id,
      category_id: item.categoryId,
      storage_mode: item.storageMode,
      origin_name: item.originName,
      object_name: item.objectName,
      hash: item.hash,
      mime_type: item.mimeType,
      storage_path: item.storagePath,
      suffix: item.suffix,
      size_byte: item.sizeByte,
      size_info: item.sizeInfo,
      url: item.url,
      remark: item.remark,
      create_time: item.createTime,
      update_time: item.updateTime,
    };
  }

  /**
   * 格式化文件大小
   * 将字节数转换为人类可读的 B/KB/MB/GB 格式。
   * @param size - 文件字节数
   * @returns 格式化后的大小字符串（如 "1.50 MB"）
   */
  private formatSize(size: number) {
    if (!size || size <= 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = size;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)}${units[index]}`;
  }

  /**
   * 格式化分类数据
   * 将 AttachmentCategoryEntity 转换为前端所需格式。
   * @param item - 分类实体
   * @returns 格式化后的分类对象
   */
  private formatCategory(item: AttachmentCategoryEntity) {
    return {
      id: item.id,
      parent_id: item.parentId,
      level: item.level,
      category_name: item.categoryName,
      sort: item.sort,
      status: item.status,
      remark: item.remark,
      label: item.categoryName,
      value: item.id,
      create_time: item.createTime,
      update_time: item.updateTime,
    };
  }

  /**
   * 递归构建分类树
   * 从指定父级 ID 开始，递归查询子分类并组装为树形结构。
   * @param parentId - 父级分类 ID，默认为 0（根节点）
   * @returns 分类树数组
   */
  private async buildCategoryTree(parentId = 0): Promise<any[]> {
    const items = await this.categoryRepo.find({
      where: { parentId, deleteTime: IsNull() },
      order: { sort: 'ASC', id: 'ASC' },
    });
    const tree = [];
    for (const item of items) {
      const node = this.formatCategory(item);
      const children = await this.buildCategoryTree(item.id);
      if (children.length) node['children'] = children;
      tree.push(node);
    }
    return tree;
  }

  /**
   * 获取附件分类列表
   * 支持以树形或平铺列表形式返回分类数据。
   * @param query - 查询参数，tree 为 true 时返回树形结构
   * @returns 分类列表或分类树
   */
  async getCategoryList(query?: { tree?: boolean | string }) {
    if (query?.tree === true || query?.tree === 'true') {
      return ResultData.ok(await this.buildCategoryTree(0));
    }
    const list = await this.categoryRepo.find({
      where: { deleteTime: IsNull() },
      order: { sort: 'ASC', id: 'ASC' },
    });
    return ResultData.ok(list.map((item) => this.formatCategory(item)));
  }

  /**
   * 查询附件列表（分页）
   * 支持按分类、文件名、MIME 类型过滤，支持自定义排序字段。
   * @param query - 查询参数（含 pageNum/pageSize、category_id、origin_name、mime_type、orderField、orderType）
   * @returns 分页附件列表
   */
  async findAll(query: any) {
    const entity = this.uploadRepo.createQueryBuilder('entity');
    entity.where('entity.deleteTime IS NULL');

    if (query.category_id) {
      entity.andWhere('entity.categoryId = :categoryId', { categoryId: Number(query.category_id) });
    }
    if (query.origin_name) {
      entity.andWhere('entity.originName LIKE :originName', { originName: `%${query.origin_name}%` });
    }
    if (query.mime_type) {
      entity.andWhere('entity.mimeType LIKE :mimeType', { mimeType: `${query.mime_type}%` });
    }

    const orderFieldMap: Record<string, string> = {
      create_time: 'createTime',
      size_byte: 'sizeByte',
      origin_name: 'originName',
    };
    const orderField = orderFieldMap[query.orderField] || 'createTime';
    const orderType = query.orderType === 'asc' ? 'ASC' : 'DESC';
    entity.orderBy(`entity.${orderField}`, orderType);

    const pageNum = Number(query.pageNum || query.page || 1);
    const pageSize = Number(query.pageSize || query.limit || 10);
    entity.skip(pageSize * (pageNum - 1)).take(pageSize);

    const [list, total] = await entity.getManyAndCount();
    return ResultData.ok({
      list: list.map((item) => this.formatAttachment(item)),
      total,
      page: pageNum,
      size: pageSize,
    });
  }

  async findOne(id: number) {
    const data = await this.uploadRepo.findOne({ where: { id } });
    return ResultData.ok(data ? this.formatAttachment(data) : null);
  }

  /**
   * 上传附件
   * 保存文件并更新附件记录的哈希值和分类信息。
   * @param file - 上传的文件
   * @param body - 请求体，可选 category_id / categoryId
   * @returns 上传结果
   */
  async uploadAttachment(file: Express.Multer.File, body: any) {
    if (!file) return ResultData.fail(500, '请选择上传文件');
    const res = await this.singleFileUpload(file);
    if (res instanceof ResultData) return res;

    // 已落盘：从磁盘流式计算哈希，不再依赖内存中的 Buffer
    const hash = await hashFileByPath(path.join(this.getUploadDir(), res.newFileName));
    if (body?.category_id || body?.categoryId) {
      await this.uploadRepo.update(
        { objectName: res.newFileName },
        { categoryId: Number(body.category_id ?? body.categoryId), hash },
      );
    } else {
      await this.uploadRepo.update(
        { objectName: res.newFileName },
        { hash },
      );
    }
    return ResultData.ok(res);
  }

  /**
   * 更新附件信息
   * 更新附件名称和备注。
   * @param id - 附件 ID
   * @param body - 更新数据（origin_name、remark）
   * @returns 操作结果
   */
  async updateAttachment(id: number, body: any) {
    const updateData: any = {};
    if (body.origin_name !== undefined) updateData.originName = body.origin_name;
    if (body.remark !== undefined) updateData.remark = body.remark;
    await this.uploadRepo.update({ id }, updateData);
    return ResultData.ok();
  }

  async updateCategoryByFileName(fileName: string, categoryId: number) {
    await this.uploadRepo.update(
      { objectName: fileName },
      { categoryId },
    );
  }

  async remove(ids: number[]) {
    await this.uploadRepo.softDelete(ids);
    return ResultData.ok();
  }

  /**
   * 移动附件至指定分类
   * 批量将附件移动到目标分类下。
   * @param body - 包含 ids（附件 ID 数组）和 categoryId / category_id（目标分类 ID）
   * @returns 操作结果
   */
  async moveAttachments(body: { ids: number[]; categoryId?: number; category_id?: number }) {
    const categoryId = body.categoryId ?? body.category_id;
    for (const id of body.ids) {
      await this.uploadRepo.update({ id }, { categoryId: Number(categoryId) });
    }
    return ResultData.ok();
  }

  async download(id: number) {
    return ResultData.ok('ok');
  }

  async stats() {
    const total = await this.uploadRepo.count({ where: { deleteTime: IsNull() } });
    return ResultData.ok({ total_count: total });
  }

  async getCategoryDetail(id: number) {
    const data = await this.categoryRepo.findOne({ where: { id } });
    return ResultData.ok(data ? this.formatCategory(data) : null);
  }

  /**
   * 创建附件分类
   * 支持指定父级分类，自动计算 level 层级路径。
   * @param body - 分类信息（parent_id、category_name、sort、status、remark）
   * @returns 操作结果
   */
  async createCategory(body: any) {
    const parentId = Number(body.parent_id || 0);
    let level = '0,';
    if (parentId > 0) {
      const parent = await this.categoryRepo.findOne({ where: { id: parentId } });
      level = parent ? `${parent.level}${parentId},` : '0,';
    }
    await this.categoryRepo.save({
      parentId,
      level,
      categoryName: body.category_name,
      sort: body.sort ?? 100,
      status: body.status ?? 1,
      remark: body.remark ?? '',
    });
    return ResultData.ok();
  }

  /**
   * 更新附件分类
   * 更新分类的名称、排序、状态、备注或父级分类，自动重新计算 level。
   * @param id - 分类 ID
   * @param body - 更新数据
   * @returns 操作结果
   */
  async updateCategory(id: number, body: any) {
    const updateData: any = {};
    if (body.category_name !== undefined) updateData.categoryName = body.category_name;
    if (body.sort !== undefined) updateData.sort = body.sort;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.remark !== undefined) updateData.remark = body.remark;
    if (body.parent_id !== undefined) {
      const parentId = Number(body.parent_id);
      if (parentId === id) {
        return ResultData.fail(500, '上级分类不能是当前分类本身');
      }
      updateData.parentId = parentId;
      if (parentId > 0) {
        const parent = await this.categoryRepo.findOne({ where: { id: parentId } });
        updateData.level = parent ? `${parent.level}${parentId},` : '0,';
      } else {
        updateData.level = '0,';
      }
    }
    await this.categoryRepo.update({ id }, updateData);
    return ResultData.ok();
  }

  /**
   * 删除附件分类
   * 检查是否存在子分类或附件，存在则禁止删除；通过软删除标记删除。
   * @param id - 分类 ID
   * @returns 操作结果
   */
  async deleteCategory(id: number) {
    const childCount = await this.categoryRepo.count({
      where: { parentId: id, deleteTime: IsNull() },
    });
    if (childCount > 0) {
      return ResultData.fail(500, '该分类下存在子分类，无法删除');
    }
    const attachmentCount = await this.uploadRepo.count({
      where: { categoryId: id, deleteTime: IsNull() },
    });
    if (attachmentCount > 0) {
      return ResultData.fail(500, '该分类下存在附件，无法删除');
    }
    await this.categoryRepo.softDelete(id);
    return ResultData.ok();
  }
}
