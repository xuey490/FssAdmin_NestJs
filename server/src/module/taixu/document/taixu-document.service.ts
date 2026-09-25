import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { In, Repository } from 'typeorm';

import { generateUUID } from '../../../common/utils';
import { getTenantId } from '../../../common/utils/tenant.util';
import { TaixuGraphService } from '../graph/taixu-graph.service';
import { TaixuVectorService } from '../vector/taixu-vector.service';
import { TaixuSystemDocumentEntity } from './entities/taixu-system-document.entity';
import { TaixuDocumentPageDto } from './dto';
import { TaixuDocumentIndexTracker } from './document-index-tracker.service';
import { TaixuDocumentIndexQueueService } from './document-index-queue.service';
import { extractTextByType } from './utils/document-extractor';
import { decodeUploadFilename } from './utils/decode-upload-filename.util';
import { persistUploadedFile } from '../../upload/utils/disk-upload.util';
import type { DocumentIndexJob } from './document-index.types';

@Injectable()
export class TaixuDocumentService {
  constructor(
    private readonly configService: ConfigService,
    private readonly vectorService: TaixuVectorService,
    private readonly graphService: TaixuGraphService,
    private readonly indexTracker: TaixuDocumentIndexTracker,
    private readonly indexQueue: TaixuDocumentIndexQueueService,
    @InjectRepository(TaixuSystemDocumentEntity)
    private readonly documentRepo: Repository<TaixuSystemDocumentEntity>,
  ) {}

  private requireTenantId(): number {
    const tenantId = getTenantId();
    if (!tenantId) throw new UnauthorizedException('Unauthorized');
    return tenantId;
  }

  /**
   * 获取文档存储目录。
   * @param tenantId - 租户 ID
   * @returns 租户专属的文档保存路径
   */
  private getSaveDir(tenantId: number) {
    const configured = this.configService.get<string>('taixu.documents.saveDir') || '';
    const base = configured
      ? path.resolve(process.cwd(), configured)
      : path.resolve(process.cwd(), '../upload/taixu/documents');
    return path.join(base, String(tenantId));
  }

  private calcLibraryNumber(input: string) {
    const hex = crypto.createHash('md5').update(input).digest('hex');
    return hex.substring(8, 24);
  }

  /**
   * 将文档实体转换为索引任务对象。
   * @param row - 文档实体
   * @returns 索引任务
   */
  private toJob(row: TaixuSystemDocumentEntity): DocumentIndexJob {
    return {
      documentId: row.id,
      tenantId: Number(row.tenantId ?? 0),
      libraryNumber: String(row.libraryNumber || ''),
      ext: String(row.documentType || 'unknown'),
      documentName: String(row.documentName || ''),
    };
  }

  /**
   * 将文档实体映射为前端展示的记录格式，合并索引状态信息。
   * @param row - 文档实体
   * @returns 包含索引进度和状态信息的记录对象
   */
  private async mapRecord(row: TaixuSystemDocumentEntity) {
    const job = await this.indexTracker.get(row.id);
    const indexed = Number(row.status ?? 0) === 1 || Boolean(row.documentSummary?.trim());
    let index_status = job?.status || (indexed ? 'done' : 'pending');
    let index_progress = job?.progress ?? (indexed ? 100 : 0);
    let index_message = job?.message || '';
    if (!job && !indexed) {
      index_message = '等待入库分析';
    }
    if (indexed && index_status !== 'failed') {
      index_status = 'done';
      index_progress = 100;
    }
    return {
      id: row.id,
      tenant_id: Number(row.tenantId ?? 0),
      document_name: row.documentName,
      document_type: row.documentType,
      document_size: Number(row.documentSize ?? 0),
      library_number: row.libraryNumber,
      document_summary: row.documentSummary,
      status: Number(row.status ?? 0),
      upload_time: row.uploadTime ? row.uploadTime.toISOString().replace('T', ' ').slice(0, 19) : null,
      index_status,
      index_progress,
      index_message,
    };
  }

  /**
   * 分页查询文档列表。
   * @param dto - 分页查询参数，支持按文档名称、类型、上传时间筛选
   * @returns 分页结果，包含总记录数、总页数和当前页记录
   */
  async page(dto: TaixuDocumentPageDto) {
    const tenantId = this.requireTenantId();
    const currentPage = Math.max(1, Number(dto.current_page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Number(dto.page_size ?? 10)));

    const qb = this.documentRepo.createQueryBuilder('d');
    qb.where('d.tenantId = :tenantId', { tenantId });

    if (dto.document_name) {
      qb.andWhere('d.documentName LIKE :documentName', { documentName: `%${dto.document_name}%` });
    }
    if (dto.document_type) {
      qb.andWhere('d.documentType = :documentType', { documentType: dto.document_type });
    }
    if (dto.upload_time) {
      qb.andWhere('DATE(d.uploadTime) = :uploadDate', { uploadDate: dto.upload_time });
    }

    qb.orderBy('d.uploadTime', 'DESC');
    qb.skip((currentPage - 1) * pageSize).take(pageSize);
    const [list, total] = await qb.getManyAndCount();
    const pages = Math.ceil(total / pageSize);
    const records = await Promise.all(list.map((row) => this.mapRecord(row)));

    return { total, pages, records };
  }

  async getIndexStatus(ids: string[]) {
    return this.indexTracker.getMany(ids);
  }

  async getQueueControlStatus() {
    return this.indexQueue.getControlStatus();
  }

  async pauseQueue() {
    return this.indexQueue.pause();
  }

  async resumeQueue() {
    return this.indexQueue.resume();
  }

  getQueueHealthStatus() {
    return this.indexQueue.getHealthStatus();
  }

  /**
   * 上传文档文件，保存到磁盘并加入索引队列。
   * @param file - 上传的文件（Multer 格式）
   * @returns 包含文档 ID、编号和队列状态的对象
   */
  async uploadFile(file: Express.Multer.File) {
    const tenantId = this.requireTenantId();
    const filename = decodeUploadFilename(file.originalname);
    const libraryNumber = this.calcLibraryNumber(filename);
    const ext = path.extname(filename).replace('.', '').toLowerCase() || 'unknown';
    const fileSizeMb = Math.max(0, Math.floor(file.size / 1024 / 1024));

    const saveDir = this.getSaveDir(tenantId);
    // 磁盘落盘：上传拦截器已把文件写入临时目录，这里移动到位，避免整份文件驻留内存
    await persistUploadedFile(file, path.join(saveDir, filename));

    const entity = this.documentRepo.create({
      id: generateUUID(),
      tenantId,
      documentName: filename,
      documentType: ext,
      documentSize: fileSizeMb,
      libraryNumber,
      documentSummary: null,
      status: 0,
      uploadTime: new Date(),
    });
    await this.documentRepo.save(entity);

    await this.indexQueue.enqueue(this.toJob(entity));

    return { id: entity.id, library_number: libraryNumber, index_status: 'queued' };
  }

  /**
   * 上传网站内容作为文档，抓取 HTML 并加入索引队列。
   * @param website - 网站 URL
   * @returns 包含文档 ID、编号和队列状态的对象
   */
  async uploadWebsite(website: string) {
    const tenantId = this.requireTenantId();
    const libraryNumber = this.calcLibraryNumber(website);

    const res = await axios.get(website, { timeout: 15000, responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    const entity = this.documentRepo.create({
      id: generateUUID(),
      tenantId,
      documentName: website,
      documentType: 'html',
      documentSize: 0,
      libraryNumber,
      documentSummary: null,
      status: 0,
      uploadTime: new Date(),
    });
    await this.documentRepo.save(entity);

    await this.indexQueue.enqueue(this.toJob(entity));

    return { id: entity.id, library_number: libraryNumber, index_status: 'queued' };
  }

  /**
   * 根据文档 ID 列表重新索引文档。先清理向量库和图谱，再重新加入队列。
   * @param ids - 文档 ID 数组
   * @returns 成功加入队列的文档数量及 ID 列表
   */
  async reindexByIds(ids: string[]) {
    const tenantId = this.requireTenantId();
    if (!ids.length) return { queued: 0, ids: [] as string[] };
    const list = await this.documentRepo.find({
      where: { tenantId, id: In(ids) } as any,
    });
    if (!list.length) throw new NotFoundException('文档不存在');

    const queued: string[] = [];
    for (const row of list) {
      if (!row.libraryNumber) continue;
      await this.cleanupVectorAndGraph(tenantId, row.libraryNumber);
      await this.documentRepo.update({ id: row.id, tenantId } as any, { documentSummary: null, status: 0 });
      await this.indexTracker.clear(row.id);
      await this.indexQueue.removeFromQueue(row.id);
      const ok = await this.indexQueue.enqueue(this.toJob(row), { force: true });
      if (ok) queued.push(row.id);
    }
    return { queued: queued.length, ids: queued };
  }

  /**
   * 根据文档 ID 列表删除文档，同时清理队列、索引跟踪、向量库和图谱。
   * @param ids - 文档 ID 数组
   */
  async deleteByIds(ids: string[]) {
    const tenantId = this.requireTenantId();
    if (!ids.length) return;
    const list = await this.documentRepo.find({
      where: { tenantId, id: In(ids) } as any,
    });
    if (!list.length) return;
    for (const doc of list) {
      await this.indexQueue.removeFromQueue(doc.id);
      await this.indexTracker.clear(doc.id);
      await this.cleanupVectorAndGraph(tenantId, doc.libraryNumber || '');
    }
    await this.documentRepo.delete({ tenantId, id: In(ids) } as any);
  }

  /**
   * 解析文档在磁盘上的绝对路径（只做路径拼接，不读取内容）。
   * 下载等只需要路径的场景应使用本方法，避免把大文件整份读入内存。
   * @param documentName - 文档名称
   * @returns 文档绝对路径
   */
  async resolveDocumentPath(documentName: string): Promise<string> {
    const tenantId = this.requireTenantId();
    return path.join(this.getSaveDir(tenantId), documentName);
  }

  /**
   * 预览文档内容。支持 HTTP 链接的 HTML 文档和本地文件。
   * @param documentName - 文档名称或 URL
   * @param documentType - 文档类型
   * @returns 提取后的文本内容
   */
  async previewContent(documentName: string, documentType: string) {
    const t = String(documentType || '').toLowerCase();
    if (t === 'html' && /^https?:\/\//i.test(documentName)) {
      const res = await axios.get(documentName, { timeout: 15000, responseType: 'arraybuffer' });
      const buffer = Buffer.from(res.data);
      return extractTextByType(buffer, 'html');
    }
    // 文本抽取需要完整内容，仅此路径读取文件
    const filePath = await this.resolveDocumentPath(documentName);
    return extractTextByType(fs.readFileSync(filePath), documentType);
  }

  /**
   * 根据编号获取文档摘要。
   * @param tenantId - 租户 ID
   * @param libraryNumber - 文档编号
   * @returns 文档摘要或文档名称
   */
  async getSummaryByLibrary(tenantId: number, libraryNumber: string) {
    if (!libraryNumber) return '';
    const rows = await this.documentRepo.find({
      where: { tenantId, libraryNumber } as any,
      order: { uploadTime: 'DESC' } as any,
      take: 1,
    });
    const row = rows[0];
    return row?.documentSummary || row?.documentName || '';
  }

  private async cleanupVectorAndGraph(tenantId: number, libraryNumber: string) {
    await this.vectorService.deleteCollection(tenantId, libraryNumber);
    await this.graphService.deleteByPrefix(tenantId, libraryNumber);
  }
}
