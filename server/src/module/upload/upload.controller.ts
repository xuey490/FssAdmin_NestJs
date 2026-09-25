import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { UploadService } from './upload.service';
import { ResultData } from '../../common/utils/result';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ChunkFileDto } from './dto/index';
import { UPLOAD_TEMP_DIR } from './utils/disk-upload.util';

/**
 * 上传拦截器选项：磁盘落盘到系统临时目录，避免整份文件驻留内存。
 * 文件由 UploadService 移动到最终上传目录（失败时清理临时文件）。
 */
const diskUploadOptions = { dest: UPLOAD_TEMP_DIR };

@ApiTags('文件上传')
@Controller('api/core/system')
@ApiBearerAuth('Authorization')
export class CoreUploadController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * 上传图片
   * 接收上传的图片文件，保存至本地磁盘，并可选择关联附件分类。
   * @param file - 上传的文件（Multer 格式）
   * @param body - 请求体，可选 category_id / categoryId 用于关联分类
   * @returns 包含文件名、新文件名、URL 的响应结果
   */
  @ApiOperation({ summary: '上传图片' })
  @HttpCode(200)
  @Post('uploadImage')
  @UseInterceptors(FileInterceptor('file', diskUploadOptions))
  async uploadImage(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    const res = await this.uploadService.singleFileUpload(file);
    const categoryId = Number(body?.category_id ?? body?.categoryId ?? 0);
    if (res?.newFileName && categoryId > 0) {
      await this.uploadService.updateCategoryByFileName(res.newFileName, categoryId);
    }
    return ResultData.ok(res);
  }

  @ApiOperation({ summary: '上传文件' })
  @HttpCode(200)
  @Post('uploadFile')
  @UseInterceptors(FileInterceptor('file', diskUploadOptions))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    const res = await this.uploadService.singleFileUpload(file);
    return ResultData.ok(res);
  }

  @ApiOperation({ summary: '分片上传' })
  @HttpCode(200)
  @Post('chunkUpload')
  @UseInterceptors(FileInterceptor('file', diskUploadOptions))
  chunkUpload(@UploadedFile() file: Express.Multer.File, @Body() body: ChunkFileDto) {
    return this.uploadService.chunkFileUpload(file, body);
  }
}

@ApiTags('附件管理')
@Controller('api/system/attachment')
@ApiBearerAuth('Authorization')
export class AttachmentController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiOperation({ summary: '附件列表' })
  @RequirePermission('core:attachment:index')
  @Get('list')
  list(@Query() query: any) {
    return this.uploadService.findAll(query);
  }

  @ApiOperation({ summary: '附件详情' })
  @RequirePermission('core:attachment:index')
  @Get('detail/:id')
  detail(@Param('id') id: string) {
    return this.uploadService.findOne(+id);
  }

  @ApiOperation({ summary: '上传附件' })
  @RequirePermission('core:attachment:edit')
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', diskUploadOptions))
  upload(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    return this.uploadService.uploadAttachment(file, body);
  }

  @ApiOperation({ summary: '更新附件' })
  @RequirePermission('core:attachment:edit')
  @Put('update/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.uploadService.updateAttachment(+id, body);
  }

  @ApiOperation({ summary: '删除附件' })
  @RequirePermission('core:attachment:edit')
  @Delete('delete/:id')
  delete(@Param('id') ids: string) {
    const idList = ids.split(',').map((id) => +id);
    return this.uploadService.remove(idList);
  }

  @ApiOperation({ summary: '批量删除附件' })
  @RequirePermission('core:attachment:edit')
  @Delete('batchDelete')
  batchDelete(@Query('ids') ids: string, @Body() body?: { ids?: number[] }) {
    const idList = body?.ids?.length ? body.ids.map((id) => +id) : ids.split(',').map((id) => +id);
    return this.uploadService.remove(idList);
  }

  @ApiOperation({ summary: '移动附件' })
  @RequirePermission('core:attachment:edit')
  @Put('move')
  move(@Body() body: { ids: number[]; categoryId?: number; category_id?: number }) {
    return this.uploadService.moveAttachments(body);
  }

  @ApiOperation({ summary: '下载附件' })
  @RequirePermission('core:attachment:index')
  @Get('download/:id')
  download(@Param('id') id: string) {
    return this.uploadService.download(+id);
  }

  @ApiOperation({ summary: '附件统计' })
  @RequirePermission('core:attachment:index')
  @Get('stats')
  stats() {
    return this.uploadService.stats();
  }
}

@ApiTags('附件分类')
@Controller('api/system/attachment-category')
@ApiBearerAuth('Authorization')
export class AttachmentCategoryController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiOperation({ summary: '分类列表' })
  @RequirePermission('core:attachment:index')
  @Get('list')
  list(@Query() query: any) {
    return this.uploadService.getCategoryList(query);
  }

  @ApiOperation({ summary: '分类详情' })
  @RequirePermission('core:attachment:index')
  @Get('detail/:id')
  detail(@Param('id') id: string) {
    return this.uploadService.getCategoryDetail(+id);
  }

  @ApiOperation({ summary: '创建分类' })
  @RequirePermission('core:attachment:edit')
  @Post('create')
  create(@Body() body: any) {
    return this.uploadService.createCategory(body);
  }

  @ApiOperation({ summary: '更新分类' })
  @RequirePermission('core:attachment:edit')
  @Put('update/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.uploadService.updateCategory(+id, body);
  }

  @ApiOperation({ summary: '删除分类' })
  @RequirePermission('core:attachment:edit')
  @Delete('delete/:id')
  delete(@Param('id') id: string) {
    return this.uploadService.deleteCategory(+id);
  }
}
