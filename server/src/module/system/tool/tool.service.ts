import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ResultData } from '../../../common/utils/result';
import { formatDate, getNowDate } from '../../../common/utils/index';
import { GenTableEntity } from './entities/gen-table.entity';
import { GenTableColumnEntity } from './entities/gen-table-cloumn.entity';
import toolConfig from './config';
import { camelCase, toLower } from 'lodash';
import { arraysContains, getColumnLength, StringUtils, capitalize } from './utils/index';
import { index as templateIndex } from './template/index';
import { ZipArchive } from 'archiver';
import * as fs from 'fs-extra';
import * as path from 'path';
import type { UserDto } from '../user/user.decorator';

@Injectable()
export class ToolService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(GenTableEntity)
    private readonly genTableEntityRep: Repository<GenTableEntity>,
    @InjectRepository(GenTableColumnEntity)
    private readonly genTableColumnEntityRep: Repository<GenTableColumnEntity>,
  ) {}
  /**
   * 解析 JSON 字符串为对象
   * @param value - 待解析的任意值
   * @returns 解析后的对象，解析失败返回空对象
   */
  private parseJson(value: any) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private toFlag(value: any): number {
    if (value === 2 || value === '2') return 2;
    if (value === 1 || value === '1') return 1;
    if (value === true) return 2;
    if (value === false) return 1;
    return 1;
  }

  private validateTableName(tableName: string) {
    if (!tableName) throw new BadRequestException('表名不能为空');
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) throw new BadRequestException('表名格式不正确');
  }

  /**
   * 格式化表行数据
   * @param row - 数据库表实体对象
   * @returns 格式化后的表行数据对象
   */
  private formatTableRow(row: GenTableEntity) {
    const options = this.parseJson((row as any).options);
    return {
      id: Number(row.id),
      table_name: row.tableName,
      table_comment: row.tableComment,
      package_name: row.packageName,
      business_name: row.businessName,
      class_name: row.className,
      tpl_category: row.tplCategory,
      options,
      remark: row.remark,
      created_by: row.createdBy,
      updated_by: row.updatedBy,
      create_time: formatDate(row.createTime),
      update_time: formatDate(row.updateTime),
      delete_time: formatDate(row.deleteTime),
      sub_table_name: row.subTableName,
      sub_table_fk_name: row.subTableFkName,
      tpl_web_type: row.tplWebType,
      module_name: row.moduleName,
      function_name: row.functionName,
      function_author: row.functionAuthor,
      gen_type: row.genType,
      gen_path: row.genPath,
    };
  }

  /**
   * 格式化列行数据
   * @param row - 数据库表列实体对象
   * @returns 格式化后的列行数据对象
   */
  private formatColumnRow(row: GenTableColumnEntity) {
    const javaField = row.javaField || camelCase(row.columnName || '');
    const javaType = row.javaType || this.inferJavaType(row.columnType);
    const htmlType = row.htmlType || this.inferHtmlType(row.columnName || '', row.columnType);
    return {
      id: Number(row.id),
      table_id: row.tableId,
      column_name: row.columnName,
      column_comment: row.columnComment,
      column_type: row.columnType,
      is_pk: row.isPk,
      is_required: row.isRequired,
      is_insert: row.isInsert,
      is_edit: row.isEdit,
      is_list: row.isList,
      is_query: row.isQuery,
      query_type: row.queryType,
      dict_type: row.dictType,
      sort: row.sort,
      remark: row.remark,
      created_by: row.createdBy,
      updated_by: row.updatedBy,
      create_time: formatDate(row.createTime),
      update_time: formatDate(row.updateTime),
      delete_time: formatDate(row.deleteTime),
      java_type: javaType,
      java_field: javaField,
      is_increment: row.isIncrement,
      html_type: this.normalizeHtmlType(htmlType),
      column_default: row.columnDefault,
    };
  }

  /**
   * 将列数据映射为模板格式
   * @param row - 数据库表列实体对象
   * @returns 映射后的模板列数据对象
   */
  private mapColumnToTemplate(row: GenTableColumnEntity) {
    const javaField = row.javaField || camelCase(row.columnName || '');
    const javaType = row.javaType || this.inferJavaType(row.columnType);
    const htmlType = row.htmlType || this.inferHtmlType(row.columnName || '', row.columnType);
    return {
      id: Number(row.id),
      tableId: row.tableId,
      columnName: row.columnName,
      columnComment: row.columnComment,
      columnType: row.columnType,
      isPk: row.isPk,
      isRequired: row.isRequired,
      isInsert: row.isInsert,
      isEdit: row.isEdit,
      isList: row.isList,
      isQuery: row.isQuery,
      queryType: this.normalizeQueryType(row.queryType),
      dictType: row.dictType || '',
      sort: row.sort,
      remark: row.remark,
      javaType,
      javaField,
      isIncrement: row.isIncrement,
      htmlType: this.normalizeHtmlType(htmlType),
      columnDefault: row.columnDefault,
    };
  }

  /**
   * 从数据库获取指定表的列信息
   * @param tableName - 数据表名称
   * @returns 表的列信息数组
   */
  private async getDbColumns(tableName: string) {
    this.validateTableName(tableName);
    const rows = await this.dataSource.query(`SHOW FULL COLUMNS FROM \`${tableName}\``);
    return (rows || []).map((row: Record<string, any>) => ({
      column_name: row.Field || '',
      column_type: row.Type || '',
      column_key: row.Key || '',
      is_nullable: (row.Null || '') === 'YES',
      column_default: row.Default ?? null,
      column_comment: row.Comment || '',
      extra: row.Extra || '',
    }));
  }

  /**
   * 根据数据库列类型推断对应的 Java 类型
   * @param columnType - 数据库列类型字符串
   * @returns 推断出的 Java 类型（Date | Number | String）
   */
  private inferJavaType(columnType: string): string {
    const type = String(columnType || '').toLowerCase();
    const baseType = type.includes('(') ? type.slice(0, type.indexOf('(')) : type;
    if (arraysContains(['datetime', 'timestamp', 'date', 'time'], baseType)) return 'Date';
    if (arraysContains(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'float', 'double', 'decimal'], baseType)) return 'Number';
    return 'String';
  }

  /**
   * 根据列名和列类型推断对应的 HTML 组件类型
   * @param columnName - 列名称
   * @param columnType - 列类型
   * @returns 推断出的 HTML 组件类型（textarea | radio | select | datetime | editor | input）
   */
  private inferHtmlType(columnName: string, columnType: string): string {
    const type = String(columnType || '').toLowerCase();
    if (type.includes('text')) return 'textarea';
    const lowerName = toLower(columnName);
    if (lowerName.includes('status')) return 'radio';
    if (lowerName.includes('type') || lowerName.includes('sex')) return 'select';
    if (lowerName.includes('time') || lowerName.includes('_date')) return 'datetime';
    if (lowerName.includes('content')) return 'editor';
    return 'input';
  }

  /**
   * 标准化查询类型为后端枚举格式
   * @param value - 原始查询类型值
   * @returns 标准化后的查询类型字符串
   */
  private normalizeQueryType(value: any): string {
    const v = String(value || '').trim().toLowerCase();
    const map: Record<string, string> = {
      eq: 'EQ',
      neq: 'NE',
      gt: 'GT',
      gte: 'GTE',
      lt: 'LT',
      lte: 'LTE',
      like: 'LIKE',
      between: 'BETWEEN',
      in: 'IN',
      notin: 'NOTIN',
    };
    return map[v] || String(value || '');
  }

  /**
   * 标准化 HTML 组件类型名称
   * @param value - 原始 HTML 类型值
   * @returns 标准化后的 HTML 类型字符串
   */
  private normalizeHtmlType(value: any): string {
    const v = String(value || '').trim();
    const map: Record<string, string> = {
      uploadImage: 'imageUpload',
      uploadFile: 'fileUpload',
      date: 'datetime',
    };
    return map[v] || v;
  }

  /**
   * 根据数据库列信息构建默认的列配置实体
   * @param dbCol - 数据库列信息对象
   * @param tableId - 关联的表 ID
   * @param sort - 排序序号
   * @param userId - 操作人用户 ID（可选）
   * @returns 生成的列配置实体
   */
  private buildDefaultColumn(dbCol: Record<string, any>, tableId: number, sort: number, userId?: number) {
    const columnName = dbCol.column_name;
    const isPk = String(dbCol.column_key || '').toLowerCase() === 'pri';
    const skipFields = ['id', 'created_by', 'updated_by', 'create_time', 'update_time', 'delete_time'].includes(columnName);
    const javaType = this.inferJavaType(dbCol.column_type);
    const javaField = camelCase(columnName);
    const htmlType = this.inferHtmlType(columnName, dbCol.column_type);
    const isQuery = toLower(columnName).includes('name') && htmlType !== 'textarea' ? 2 : 1;
    const queryType = isQuery === 2 ? 'like' : 'eq';
    const isRequired = !dbCol.is_nullable && !isPk && !skipFields ? 2 : 1;

    return this.genTableColumnEntityRep.create({
      tableId,
      columnName,
      columnComment: dbCol.column_comment || columnName,
      columnType: dbCol.column_type || '',
      isPk: isPk ? 2 : 1,
      isRequired,
      isInsert: skipFields || isPk ? 1 : 2,
      isEdit: skipFields || isPk ? 1 : 2,
      isList: skipFields ? 1 : 2,
      isQuery,
      queryType,
      dictType: '',
      sort,
      remark: null,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
      createTime: new Date() as any,
      updateTime: new Date() as any,
      javaType,
      javaField,
      isIncrement: String(dbCol.extra || '').toLowerCase().includes('auto_increment') ? 1 : 0,
      htmlType,
      columnDefault: dbCol.column_default,
    } as any);
  }

  private getZipPaths(info: { BusinessName: string; businessName: string }) {
    return {
      entity: `nest/${info.BusinessName}/entities/${info.businessName}.entity.ts`,
      dto: `nest/${info.BusinessName}/dto/${info.businessName}.dto.ts`,
      controller: `nest/${info.BusinessName}/${info.businessName}.controller.ts`,
      service: `nest/${info.BusinessName}/${info.businessName}.service.ts`,
      module: `nest/${info.BusinessName}/${info.businessName}.module.ts`,
      api: `vue/${info.BusinessName}/${info.businessName}.js`,
      indexVue: `vue/${info.BusinessName}/${info.businessName}/index.vue`,
      dialogVue: `vue/${info.BusinessName}/${info.businessName}/components/indexDialog.vue`,
    };
  }

  private buildPreviewTabs(templateMap: Record<string, string>) {
    const items = [
      { name: 'entity', key: 'tool/template/nestjs/entity.ts.vm', tab_name: 'entity.ts', lang: 'ts' },
      { name: 'dto', key: 'tool/template/nestjs/dto.ts.vm', tab_name: 'dto.ts', lang: 'ts' },
      { name: 'controller', key: 'tool/template/nestjs/controller.ts.vm', tab_name: 'controller.ts', lang: 'ts' },
      { name: 'service', key: 'tool/template/nestjs/service.ts.vm', tab_name: 'service.ts', lang: 'ts' },
      { name: 'module', key: 'tool/template/nestjs/module.ts.vm', tab_name: 'module.ts', lang: 'ts' },
      { name: 'api', key: 'tool/template/vue/api.js.vm', tab_name: 'api.js', lang: 'js' },
      { name: 'indexVue', key: 'tool/template/vue/indexVue.vue.vm', tab_name: 'indexVue.vue', lang: 'vue' },
      { name: 'dialogVue', key: 'tool/template/vue/dialogVue.vue.vm', tab_name: 'dialogVue.vue', lang: 'vue' },
    ];
    return items
      .map((item) => ({
        name: item.name,
        tab_name: item.tab_name,
        lang: item.lang,
        code: templateMap[item.key] ?? '',
      }))
      .filter((v) => v.code !== '');
  }

  /**
   * 分页查询业务表列表
   * @param query - 查询参数（包含分页、表名筛选、排序等信息）
   * @returns 分页结果数据
   */
  async findAll(query: Record<string, any>) {
    const page = Math.max(1, Number(query.page || query.pageNum || 1));
    const limit = Math.max(1, Number(query.limit || query.pageSize || 10));
    const tableName = String(query.table_name || query.tableNames || '').trim();
    const tableComment = String(query.table_comment || query.tableComment || '').trim();

    const entity = this.genTableEntityRep.createQueryBuilder('entity');
    entity.where('entity.deleteTime IS NULL');
    if (tableName) {
      entity.andWhere('entity.tableName LIKE :tableName', { tableName: `%${tableName}%` });
    }
    if (tableComment) {
      entity.andWhere('entity.tableComment LIKE :tableComment', { tableComment: `%${tableComment}%` });
    }

    const orderField = String(query.orderField || '').trim();
    const orderType = String(query.orderType || '').toUpperCase();
    const safeOrderType = orderType === 'ASC' ? 'ASC' : orderType === 'DESC' ? 'DESC' : undefined;
    if (safeOrderType && ['update_time', 'create_time'].includes(orderField)) {
      const mapped = orderField === 'create_time' ? 'entity.createTime' : 'entity.updateTime';
      entity.orderBy(mapped, safeOrderType as any);
    } else {
      entity.orderBy('entity.updateTime', 'DESC');
    }

    const [rows, total] = await entity
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return ResultData.ok({
      list: rows.map((r) => this.formatTableRow(r)),
      total,
    });
  }

  /**
   * 查询单个业务表详情及其列信息
   * @param id - 表记录 ID
   * @returns 表详情及列列表
   */
  async findOne(id: number) {
    const row = await this.genTableEntityRep.findOne({ where: { id } });
    if (!row) throw new BadRequestException('记录不存在');
    const columns = await this.genTableColumnEntityRep.find({ where: { tableId: id }, order: { sort: 'ASC' } as any });
    const table = this.formatTableRow(row);
    return ResultData.ok({
      ...table,
      columns: columns.map((c) => this.formatColumnRow(c)),
    });
  }

  async getTableColumns(tableId: number) {
    const columns = await this.genTableColumnEntityRep.find({ where: { tableId }, order: { sort: 'ASC' } as any });
    return ResultData.ok(columns.map((c) => this.formatColumnRow(c)));
  }

  /**
   * 更新业务表配置及其列信息
   * @param body - 更新数据，包含表信息和列数组
   * @param user - 当前操作用户信息（可选）
   * @returns 操作结果
   */
  async genUpdate(body: Record<string, any>, user?: UserDto) {
    const id = Number(body.id || 0);
    if (!id) throw new BadRequestException('参数 id 不能为空');
    const userId = user?.userId || user?.user?.id;

    const table = await this.genTableEntityRep.findOne({ where: { id } });
    if (!table) throw new BadRequestException('记录不存在');

    const options = this.parseJson(table.options);
    const incomingOptions = body.options && typeof body.options === 'object' ? body.options : {};
    const nextOptions = { ...options, ...incomingOptions };

    const updateData: Partial<GenTableEntity> = {};
    if (body.table_comment !== undefined) updateData.tableComment = body.table_comment;
    if (body.class_name !== undefined) updateData.className = body.class_name;
    if (body.package_name !== undefined) updateData.packageName = body.package_name;
    if (body.business_name !== undefined) updateData.businessName = body.business_name;
    if (body.tpl_category !== undefined) updateData.tplCategory = body.tpl_category;
    if (body.sub_table_name !== undefined) updateData.subTableName = body.sub_table_name;
    if (body.sub_table_fk_name !== undefined) updateData.subTableFkName = body.sub_table_fk_name;
    if (body.tpl_web_type !== undefined) updateData.tplWebType = body.tpl_web_type;
    if (body.module_name !== undefined) updateData.moduleName = body.module_name;
    if (body.function_name !== undefined) updateData.functionName = body.function_name;
    if (body.function_author !== undefined) updateData.functionAuthor = body.function_author;
    if (body.gen_type !== undefined) updateData.genType = Number(body.gen_type);
    if (body.gen_path !== undefined) updateData.genPath = body.gen_path;
    if (body.remark !== undefined) updateData.remark = body.remark;
    updateData.options = JSON.stringify(nextOptions);
    if (userId) updateData.updatedBy = userId as any;

    await this.genTableEntityRep.update({ id }, updateData as any);

    const columns = Array.isArray(body.columns) ? body.columns : null;
    if (columns) {
      for (const item of columns) {
        if (!item || !item.id) continue;
        const columnUpdate: Partial<GenTableColumnEntity> = {};
        if (item.column_comment !== undefined) columnUpdate.columnComment = item.column_comment;
        if (item.column_type !== undefined) columnUpdate.columnType = item.column_type;
        if (item.is_pk !== undefined) columnUpdate.isPk = this.toFlag(item.is_pk);
        if (item.is_required !== undefined) columnUpdate.isRequired = this.toFlag(item.is_required);
        if (item.is_insert !== undefined) columnUpdate.isInsert = this.toFlag(item.is_insert);
        if (item.is_edit !== undefined) columnUpdate.isEdit = this.toFlag(item.is_edit);
        if (item.is_list !== undefined) columnUpdate.isList = this.toFlag(item.is_list);
        if (item.is_query !== undefined) columnUpdate.isQuery = this.toFlag(item.is_query);
        if (item.query_type !== undefined) columnUpdate.queryType = item.query_type;
        if (item.dict_type !== undefined) columnUpdate.dictType = item.dict_type;
        if (item.sort !== undefined) columnUpdate.sort = Number(item.sort);
        if (item.remark !== undefined) columnUpdate.remark = item.remark;
        if (item.java_type !== undefined) columnUpdate.javaType = item.java_type;
        if (item.java_field !== undefined) columnUpdate.javaField = item.java_field;
        if (item.is_increment !== undefined) columnUpdate.isIncrement = Number(item.is_increment);
        if (item.html_type !== undefined) columnUpdate.htmlType = item.html_type;
        if (item.view_type !== undefined && item.html_type === undefined) columnUpdate.htmlType = item.view_type;
        if (item.column_default !== undefined) columnUpdate.columnDefault = item.column_default;
        if (userId) columnUpdate.updatedBy = userId as any;
        await this.genTableColumnEntityRep.update({ id: Number(item.id) }, columnUpdate as any);
      }
    }

    return ResultData.ok();
  }

  /**
   * 批量删除业务表记录及其关联的列配置
   * @param ids - 要删除的表记录 ID 数组
   * @returns 操作结果
   */
  async remove(ids: number[]) {
    const validIds = (ids || []).map((v) => Number(v)).filter((v) => !Number.isNaN(v) && v > 0);
    if (!validIds.length) throw new BadRequestException('请选择要删除的记录');
    await this.genTableColumnEntityRep.delete({ tableId: In(validIds) } as any);
    await this.genTableEntityRep.delete({ id: In(validIds) } as any);
    return ResultData.ok();
  }

  /**
   * 从数据库装载数据表，自动创建业务表和列配置
   * @param body - 请求体（包含 names 数组，即要装载的表名和注释）
   * @param user - 当前操作用户信息（可选）
   * @returns 装载结果（成功列表和失败列表）
   */
  async loadTable(body: Record<string, any>, user?: UserDto) {
    const names = Array.isArray(body.names) ? body.names : [];
    if (!names.length) throw new BadRequestException('请选择要装载的数据表');
    const userId = user?.userId || user?.user?.id;

    const success: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    for (const item of names) {
      const tableName = String(item?.name || '').trim();
      const tableComment = String(item?.comment || '').trim();
      if (!tableName) continue;
      try {
        this.validateTableName(tableName);
        const exists = await this.genTableEntityRep.findOne({ where: { tableName } });
        if (exists) {
          failed.push({ name: tableName, reason: '已装载，请勿重复添加' });
          continue;
        }

        const normalized = tableName.startsWith('sa_') ? tableName.slice(3) : tableName;
        const className = toolConfig.autoRemovePre
          ? StringUtils.toPascalCase(normalized.replace(new RegExp(toolConfig.tablePrefix.join('|')), ''))
          : StringUtils.toPascalCase(normalized);
        const businessName = camelCase(normalized);

        const now = new Date();
        const [table] = await this.genTableEntityRep.save(
          this.genTableEntityRep.create({
            tableName,
            tableComment: tableComment || tableName,
            className,
            packageName: toolConfig.packageName,
            moduleName: toolConfig.moduleName,
            businessName,
            functionName: tableComment || tableName,
            functionAuthor: toolConfig.author,
            tplCategory: 'single',
            tplWebType: 'element-plus',
            genType: 0,
            genPath: '/',
            options: JSON.stringify({}),
            remark: '',
            createdBy: userId ?? null,
            updatedBy: userId ?? null,
            createTime: now as any,
            updateTime: now as any,
          } as any),
        );

        const dbColumns = await this.getDbColumns(tableName);
        const columnEntities = dbColumns.map((col: any, idx: number) => this.buildDefaultColumn(col, table.id, idx, userId));
        await this.genTableColumnEntityRep.save(columnEntities as any[]);
        success.push(tableName);
      } catch (e: any) {
        failed.push({ name: tableName, reason: e?.message || '装载失败' });
      }
    }

    if (failed.length && !success.length) {
      throw new BadRequestException(failed[0]?.reason || '装载失败');
    }

    return ResultData.ok({ success, failed });
  }

  /**
   * 同步数据库表结构，自动新增/更新/删除列配置
   * @param body - 请求体（包含 ids 数组，即要同步的表记录 ID）
   * @param user - 当前操作用户信息（可选）
   * @returns 同步结果（成功列表和失败列表）
   */
  async synchDb(body: Record<string, any>, user?: UserDto) {
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    const validIds = (ids || []).map((v: any) => Number(v)).filter((v: number) => !Number.isNaN(v) && v > 0);
    if (!validIds.length) throw new BadRequestException('参数 id 不能为空');
    const userId = user?.userId || user?.user?.id;

    const success: number[] = [];
    const failed: Array<{ id: number; reason: string }> = [];

    for (const id of validIds) {
      try {
        const table = await this.genTableEntityRep.findOne({ where: { id } });
        if (!table) throw new BadRequestException('记录不存在');
        const dbColumns = await this.getDbColumns(table.tableName);
        const existColumns = await this.genTableColumnEntityRep.find({ where: { tableId: id } });
        const existMap = new Map(existColumns.map((c) => [c.columnName, c]));
        const dbSet = new Set(dbColumns.map((c) => c.column_name));

        for (let idx = 0; idx < dbColumns.length; idx++) {
          const dbCol = dbColumns[idx];
          const name = dbCol.column_name;
          const exist = existMap.get(name);
          if (!exist) {
            const created = this.buildDefaultColumn(dbCol, id, idx, userId);
            await this.genTableColumnEntityRep.save(created as any);
            continue;
          }
          const update: Partial<GenTableColumnEntity> = {};
          const isPk = String(dbCol.column_key || '').toLowerCase() === 'pri';
          update.isPk = isPk ? 2 : 1;
          update.columnType = dbCol.column_type;
          if (!exist.columnComment || exist.columnComment === exist.columnName) {
            update.columnComment = dbCol.column_comment || exist.columnName;
          }
          update.columnDefault = dbCol.column_default;
          update.isIncrement = String(dbCol.extra || '').toLowerCase().includes('auto_increment') ? 1 : 0;
          update.sort = idx;
          if (userId) update.updatedBy = userId as any;
          await this.genTableColumnEntityRep.update({ id: exist.id }, update as any);
        }

        const deleteIds = existColumns.filter((c) => !dbSet.has(c.columnName)).map((c) => c.id);
        if (deleteIds.length) {
          await this.genTableColumnEntityRep.delete(deleteIds);
        }

        if (userId) {
          await this.genTableEntityRep.update({ id }, { updatedBy: userId as any, updateTime: new Date() as any } as any);
        }
        success.push(id);
      } catch (e: any) {
        failed.push({ id, reason: e?.message || '同步失败' });
      }
    }

    if (failed.length && !success.length) {
      throw new BadRequestException(failed[0]?.reason || '同步失败');
    }

    return ResultData.ok({ success, failed });
  }

  private async getPrimaryKey(columns: GenTableColumnEntity[]) {
    const pk = columns.find((c) => Number(c.isPk) === 2);
    return pk ? pk.javaField : null;
  }

  /**
   * 预览代码生成效果
   * @param id - 业务表记录 ID
   * @returns 各模板文件的代码预览
   */
  async preview(id: number) {
    const table = await this.genTableEntityRep.findOne({ where: { id } });
    if (!table) throw new BadRequestException('记录不存在');
    const columns = await this.genTableColumnEntityRep.find({ where: { tableId: id }, order: { sort: 'ASC' } as any });
    const primaryKey = await this.getPrimaryKey(columns);
    const info = {
      primaryKey,
      BusinessName: capitalize(table.businessName),
      ...table,
      columns: columns.map((c) => this.mapColumnToTemplate(c)),
    };
    const templateMap = templateIndex(info);
    return ResultData.ok(this.buildPreviewTabs(templateMap));
  }

  /**
   * 批量生成代码并打包为 ZIP 文件下载
   * @param body - 请求体（包含 ids 数组，即要生成的表记录 ID）
   * @param res - Express 响应对象
   */
  async batchGenCode(body: Record<string, any>, res: any) {
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    const validIds = (ids || []).map((v: any) => Number(v)).filter((v: number) => !Number.isNaN(v) && v > 0);
    if (!validIds.length) throw new BadRequestException('请选择要生成的记录');

    const now = formatDate(new Date(), 'YYYYMMDDHHmmss');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="generate_${now}.zip"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => {
      throw err;
    });
    archive.pipe(res);

    for (const id of validIds) {
      const table = await this.genTableEntityRep.findOne({ where: { id } });
      if (!table) continue;
      const columns = await this.genTableColumnEntityRep.find({ where: { tableId: id } });
      const primaryKey = await this.getPrimaryKey(columns);
      const info = {
        primaryKey,
        BusinessName: capitalize(table.businessName),
        ...table,
        columns: columns.map((c) => this.mapColumnToTemplate(c)),
      };

      const list = templateIndex(info);
      const paths = this.getZipPaths({ BusinessName: info.BusinessName, businessName: table.businessName });
      const templates = [
        { content: list['tool/template/nestjs/entity.ts.vm'], path: paths.entity },
        { content: list['tool/template/nestjs/dto.ts.vm'], path: paths.dto },
        { content: list['tool/template/nestjs/controller.ts.vm'], path: paths.controller },
        { content: list['tool/template/nestjs/service.ts.vm'], path: paths.service },
        { content: list['tool/template/nestjs/module.ts.vm'], path: paths.module },
        { content: list['tool/template/vue/api.js.vm'], path: paths.api },
        { content: list['tool/template/vue/indexVue.vue.vm'], path: paths.indexVue },
        { content: list['tool/template/vue/dialogVue.vue.vm'], path: paths.dialogVue },
      ];

      for (const template of templates) {
        if (!template.content) continue;
        archive.append(Buffer.from(template.content), { name: template.path });
      }
    }

    await archive.finalize();
  }

  /**
   * 生成代码文件到本地项目目录
   * @param body - 请求体（包含 ids 数组，即要生成的表记录 ID）
   * @param user - 当前操作用户信息（可选）
   * @returns 生成结果（成功文件路径列表和失败列表）
   */
  async generateFile(body: Record<string, any>, user?: UserDto) {
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    const validIds = (ids || []).map((v: any) => Number(v)).filter((v: number) => !Number.isNaN(v) && v > 0);
    if (!validIds.length) throw new BadRequestException('请选择要生成的记录');

    const cwd = path.resolve(process.cwd());
    const root =
      path.basename(cwd) === 'server' && (await fs.pathExists(path.resolve(cwd, '..', 'web')))
        ? path.resolve(cwd, '..')
        : cwd;

    const success: string[] = [];
    const failed: Array<{ id: number; reason: string }> = [];

    for (const id of validIds) {
      try {
        const table = await this.genTableEntityRep.findOne({ where: { id } });
        if (!table) throw new BadRequestException('记录不存在');
        const columns = await this.genTableColumnEntityRep.find({ where: { tableId: id } });
        const primaryKey = await this.getPrimaryKey(columns);
        const info = {
          primaryKey,
          BusinessName: capitalize(table.businessName),
          ...table,
          columns: columns.map((c) => this.mapColumnToTemplate(c)),
        };
        const list = templateIndex(info);
        const paths = this.getZipPaths({ BusinessName: info.BusinessName, businessName: table.businessName });

        const mappings = [
          { key: 'tool/template/nestjs/entity.ts.vm', path: paths.entity },
          { key: 'tool/template/nestjs/dto.ts.vm', path: paths.dto },
          { key: 'tool/template/nestjs/controller.ts.vm', path: paths.controller },
          { key: 'tool/template/nestjs/service.ts.vm', path: paths.service },
          { key: 'tool/template/nestjs/module.ts.vm', path: paths.module },
          { key: 'tool/template/vue/api.js.vm', path: paths.api },
          { key: 'tool/template/vue/indexVue.vue.vm', path: paths.indexVue },
          { key: 'tool/template/vue/dialogVue.vue.vm', path: paths.dialogVue },
        ];

        for (const m of mappings) {
          const content = list[m.key];
          if (!content) continue;
          const absPath = path.resolve(root, m.path);
          await fs.outputFile(absPath, content);
          success.push(m.path);
        }
      } catch (e: any) {
        failed.push({ id, reason: e?.message || '生成失败' });
      }
    }

    return ResultData.ok({ success, failed });
  }
}
