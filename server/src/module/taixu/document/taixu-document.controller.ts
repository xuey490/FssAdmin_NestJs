import { Body, Controller, Get, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express-serve-static-core';
import { ResultData } from '../../../common/utils/result';
import { TaixuDocumentDeleteDto, TaixuDocumentDownloadDto, TaixuDocumentIndexStatusDto, TaixuDocumentPageDto, TaixuDocumentPreviewDto, TaixuDocumentReindexDto, TaixuDocumentWebsiteDto } from './dto';
import { TaixuDocumentService } from './taixu-document.service';
import { UPLOAD_TEMP_DIR } from '../../upload/utils/disk-upload.util';

@Controller('api/taixu/document')
export class TaixuDocumentController {
  constructor(private readonly documentService: TaixuDocumentService) {}

  @Get('list')
  async list(@Query() query: TaixuDocumentPageDto) {
    return ResultData.ok(await this.documentService.page(query));
  }

  /**
   * 批量删除文档。
   * @param body - 包含逗号分隔的文档 ID 字符串
   */
  @Post('delete')
  async delete(@Body() body: TaixuDocumentDeleteDto) {
    const ids = String(body.ids || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    await this.documentService.deleteByIds(ids);
    return ResultData.ok(await this.documentService.page(body));
  }

  @Post('upload')
  // 磁盘落盘：文档可能较大，避免整份文件驻留内存（服务层会移动到正式目录）
  @UseInterceptors(FileInterceptor('file', { dest: UPLOAD_TEMP_DIR }))
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) return ResultData.fail(500, '没有上传任何文件');
    const result = await this.documentService.uploadFile(file);
    return ResultData.ok(result, '上传成功，正在后台索引');
  }

  /**
   * 获取文档索引状态。
   * @param query - 包含逗号分隔的文档 ID 列表
   */
  @Get('index-status')
  async indexStatus(@Query() query: TaixuDocumentIndexStatusDto) {
    const ids = String(query.ids || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return ResultData.ok(await this.documentService.getIndexStatus(ids));
  }

  @Get('queue/status')
  async queueStatus() {
    return ResultData.ok(await this.documentService.getQueueControlStatus());
  }

  @Get('queue/health')
  async queueHealth() {
    return ResultData.ok(this.documentService.getQueueHealthStatus());
  }

  @Post('queue/pause')
  async pauseQueue() {
    return ResultData.ok(await this.documentService.pauseQueue(), '队列已暂停');
  }

  @Post('queue/resume')
  async resumeQueue() {
    return ResultData.ok(await this.documentService.resumeQueue(), '队列已恢复');
  }

  /**
   * 重新索引指定文档。
   * @param body - 包含逗号分隔的文档 ID 字符串
   */
  @Post('reindex')
  async reindex(@Body() body: TaixuDocumentReindexDto) {
    const ids = String(body.ids || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const result = await this.documentService.reindexByIds(ids);
    return ResultData.ok(result, `已加入队列 ${result.queued} 个文档`);
  }

  @Post('website')
  async website(@Body() body: TaixuDocumentWebsiteDto) {
    const result = await this.documentService.uploadWebsite(body.website);
    return ResultData.ok(result, '上传成功，正在后台索引');
  }

  @Get('preview')
  async preview(@Query() query: TaixuDocumentPreviewDto) {
    const content = await this.documentService.previewContent(query.documentName, query.documentType);
    return ResultData.ok(content);
  }

  @Post('download')
  async download(@Body() body: TaixuDocumentDownloadDto, @Res() res: Response) {
    // 只解析路径，文件由 res.download 流式发送，避免整份读入内存
    const filePath = await this.documentService.resolveDocumentPath(body.documentName);
    res.download(filePath, body.documentName);
  }
}
