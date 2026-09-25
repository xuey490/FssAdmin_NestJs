import { Controller, Get, Post, Body, Query, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DatabaseService } from './database.service';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { ConfigService } from '@nestjs/config';

@ApiTags('数据库管理')
@ApiBearerAuth('Authorization')
@Controller('api/core/database')
export class DatabaseController {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /** 只读/演示模式下禁止远程查看与操作数据结构 */
  private checkReadonly() {
    const readonly = this.config.get<boolean>('app.readonly');
    if (readonly === true) {
      throw new ForbiddenException('只读模式下禁止远程访问数据结构');
    }
  }

  @ApiOperation({ summary: '数据表列表' })
  @RequirePermission('core:database:index')
  @Get('table/list')
  async getTableList(@Query() query: Record<string, any>) {
    return this.databaseService.getTableList(query);
  }

  @ApiOperation({ summary: '数据源信息' })
  @RequirePermission('core:database:index')
  @Get('table/dataSource')
  async getDataSource() {
    return this.databaseService.getDataSource();
  }

  @ApiOperation({ summary: '表详细信息' })
  @RequirePermission('core:database:index')
  @Get('table/detailed')
  async getDetailed(@Query() query: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.getDetailed(query);
  }

  @ApiOperation({ summary: '回收站列表' })
  @RequirePermission('core:recycle:index')
  @Get('recycle/list')
  async getRecycleList(@Query() query: Record<string, any>) {
    return this.databaseService.getRecycleList(query);
  }

  @ApiOperation({ summary: '销毁回收站数据' })
  @RequirePermission('core:recycle:edit')
  @Post('recycle/destroy')
  async destroy(@Body() body: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.destroy(body);
  }

  @ApiOperation({ summary: '恢复回收站数据' })
  @RequirePermission('core:recycle:edit')
  @Post('recycle/recovery')
  async recovery(@Body() body: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.recovery(body);
  }

  @ApiOperation({ summary: '优化表' })
  @RequirePermission('core:database:edit')
  @Post('table/optimize')
  async optimize(@Body() body: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.optimize(body);
  }

  @ApiOperation({ summary: '清除表碎片' })
  @RequirePermission('core:database:edit')
  @Post('table/fragment')
  async fragment(@Body() body: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.fragment(body);
  }

  @ApiOperation({ summary: '查看建表语句' })
  @RequirePermission('core:database:index')
  @Get('table/createSql')
  async getCreateSql(@Query() query: Record<string, any>) {
    this.checkReadonly();
    return this.databaseService.getCreateSql(query);
  }
}
