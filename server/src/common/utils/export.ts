import { Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express-serve-static-core';

import { StatusEnum, SexEnum, DelFlagEnum } from '../enum/index';

const logger = new Logger('ExportTable');

export const commonExportMap: Record<string, Record<string, string>> = {
  status: {
    [StatusEnum.NORMAL]: '正常',
    [StatusEnum.STOP]: '停用',
  },
  sex: {
    [SexEnum.MAN]: '男',
    [SexEnum.WOMAN]: '女',
  },
  delFlag: {
    [DelFlagEnum.NORMAL]: '正常',
    [DelFlagEnum.DELETE]: '已删除',
  },
};

/**
 * 导出表格数据为 Excel 文件
 * @param options - 导出配置项，包含数据、表头、字典映射、工作表名称
 * @param options.data - 要导出的数据行数组
 * @param options.header - 表头列定义，每项包含 title/header、dataIndex/key、width、formateStr
 * @param options.dictMap - 字段值到显示文本的映射字典（如状态、性别枚举）
 * @param options.sheetName - 工作表名称，默认为 "Sheet1"
 * @param options.mode - 写出方式：`stream`（默认，ZipWriter 直接 pipe 到响应，峰值内存与单块相关）
 *                       或 `buffer`（先序列化整份工作簿再写出，兼容需要完整 Buffer 的场景）
 * @param res - Express 响应对象，用于输出文件流
 */
export async function ExportTable(
  options: {
    data: any[];
    header: Array<{
      title?: string;
      dataIndex?: string;
      header?: string;
      key?: string;
      width?: number;
      formateStr?: (val: any) => string;
    }>;
    dictMap?: any;
    sheetName?: string;
    mode?: 'stream' | 'buffer';
  },
  res: Response,
) {
  const data = options.data;
  const workbook = new ExcelJS.Workbook();
  const sheetName = options.sheetName || 'Sheet1';
  const worksheet = workbook.addWorksheet(sheetName);

  const normalizedHeader = options.header.map((column) => ({
    title: column.title ?? column.header ?? '',
    dataIndex: column.dataIndex ?? column.key ?? '',
    width: column.width,
    formateStr: column.formateStr,
  }));

  worksheet.columns = normalizedHeader.map((column) => ({
    header: column.title,
    key: column.dataIndex,
    width: column.width != null && !isNaN(column.width) ? column.width : 16,
  }));

  const dictMap = { ...commonExportMap, ...options.dictMap };

  const rows = data.map((item) => {
    const newItem: Record<string, any> = {};
    normalizedHeader.forEach((field) => {
      const dataIndex = field.dataIndex;
      const dataValue = item[dataIndex];
      if (dictMap && dictMap[dataIndex]) {
        newItem[dataIndex] = dictMap[dataIndex][dataValue] !== undefined ? dictMap[dataIndex][dataValue] : dataValue;
      } else {
        newItem[dataIndex] = dataValue;
      }
      if (field.formateStr && typeof field.formateStr === 'function') {
        newItem[dataIndex] = field.formateStr(newItem[dataIndex]);
      }
    });
    return newItem;
  });

  const headerStyle: any = {
    font: { size: 10, bold: true, color: { argb: 'ffffff' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '808080' } },
    border: {
      top: { style: 'thin', color: { argb: '9e9e9e' } },
      left: { style: 'thin', color: { argb: '9e9e9e' } },
      bottom: { style: 'thin', color: { argb: '9e9e9e' } },
      right: { style: 'thin', color: { argb: '9e9e9e' } },
    },
  };

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.style = headerStyle;
  });

  rows.forEach((item) => {
    worksheet.addRow(item);
  });

  worksheet.columns.forEach((column) => {
    column.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // 响应头必须在写入前设置：流式写出时数据会立刻开始发送
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment;filename=sheet.xlsx');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 默认流式写出：ZipWriter 直接 pipe 到响应，避免整份工作簿及其 Buffer 同时驻留堆内存
  if ((options.mode ?? 'stream') === 'buffer') {
    const buffer = await workbook.xlsx.writeBuffer();
    res.end(buffer, 'binary');
    return;
  }

  try {
    await workbook.xlsx.write(res);
  } catch (error) {
    // 响应头已发出，无法再返回结构化错误；记录日志并结束响应，避免调用方未 await 时形成未处理 rejection
    logger.error(`流式导出失败: ${(error as Error)?.message}`);
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}
