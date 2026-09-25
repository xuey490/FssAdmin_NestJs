import * as ExcelJS from 'exceljs';
import type { Response } from 'express-serve-static-core';
import { Writable } from 'node:stream';

import { ExportTable, commonExportMap } from './export';

interface MockResponse {
  res: Response;
  headers: Record<string, string>;
  end: jest.Mock;
  chunks: Buffer[];
}

type XlsxLike = { write: (target: unknown) => Promise<void>; writeBuffer: () => Promise<Buffer> };

/**
 * 拦截 ExcelJS.Workbook.prototype.xlsx 的 getter，用于确定性驱动"流式写出失败"分支。
 * 直接用缺少 write 方法的响应对象会让 exceljs 抛出无法被 await 捕获的错误（逃逸成未处理异常），
 * 因此改为在这里注入可控的 write 实现。
 */
const realXlsxGetter = Object.getOwnPropertyDescriptor(ExcelJS.Workbook.prototype, 'xlsx')?.get;
const mockXlsxWrite = jest.fn();
let latestReal: XlsxLike | undefined;

beforeAll(() => {
  if (!realXlsxGetter) {
    throw new Error('ExcelJS.Workbook.prototype.xlsx getter 不存在，无法打桩');
  }

  Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', {
    configurable: true,
    get(this: ExcelJS.Workbook) {
      const real = realXlsxGetter.call(this) as XlsxLike;
      latestReal = real;

      // 用代理透传其余方法（如 load），仅替换 write
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'write') {
            return (writeTarget: unknown) => mockXlsxWrite(writeTarget);
          }

          const value = (target as unknown as Record<string | symbol, unknown>)[prop];

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
});

afterAll(() => {
  if (realXlsxGetter) {
    Object.defineProperty(ExcelJS.Workbook.prototype, 'xlsx', {
      configurable: true,
      get: realXlsxGetter,
    });
  }
});

beforeEach(() => {
  mockXlsxWrite.mockReset();
  // 默认走真实实现
  mockXlsxWrite.mockImplementation(async (target: unknown) => {
    await latestReal!.write(target);
  });
});

/** 可写入的响应对象：基于真实 Writable，兼容 exceljs 的流式写出 */
const createWritableResponse = (): MockResponse => {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const headers: Record<string, string> = {};
  const target = writable as unknown as Record<string, unknown>;

  target.setHeader = (key: string, value: string) => {
    headers[key] = value;
  };
  target.headers = headers;
  target.chunks = chunks;

  const end = jest.spyOn(writable, 'end') as unknown as jest.Mock;

  return { res: writable as unknown as Response, headers, end, chunks };
};

/** 最小响应对象（缺少 write 方法），用于驱动写出失败分支 */
const createMinimalResponse = (writableEnded = false): MockResponse => {
  const headers: Record<string, string> = {};
  const end = jest.fn();

  const res = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    end,
    writableEnded,
  };

  return { res: res as unknown as Response, headers, end, chunks: [] };
};

describe('ExportTable', () => {
  describe('响应头与写出模式', () => {
    it('默认流式写出：设置响应头并在结束后关闭响应', async () => {
      const { res, headers, end } = createWritableResponse();

      await ExportTable(
        {
          data: [{ name: '张三' }],
          header: [{ title: '姓名', dataIndex: 'name' }],
        },
        res,
      );

      expect(headers['Content-Type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(headers['Content-Disposition']).toBe('attachment;filename=sheet.xlsx');
      expect(headers['Access-Control-Expose-Headers']).toBe('Content-Disposition');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(end).toHaveBeenCalled();
    });

    it('buffer 模式：整份序列化后用 binary 结束响应', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [{ name: '李四', status: '0' }],
          header: [
            { title: '姓名', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status' },
          ],
          mode: 'buffer',
        },
        res,
      );

      expect(end).toHaveBeenCalledTimes(1);
      const [rawBuffer, encoding] = end.mock.calls[0] as unknown as [Buffer, string];
      const buffer = rawBuffer as unknown as Buffer;

      expect(encoding).toBe('binary');

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as never);
      const sheet = workbook.getWorksheet('Sheet1');

      expect(sheet).toBeDefined();
      expect(String(sheet?.getCell('A1').value)).toBe('姓名');
      expect(String(sheet?.getCell('A2').value)).toBe('李四');
      // 内置字典把 status=0 映射为“正常”
      expect(String(sheet?.getCell('B2').value)).toBe('正常');
    });

    it('写出失败时记录错误并结束响应，不向外抛错', async () => {
      const { res, end } = createMinimalResponse();
      mockXlsxWrite.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        ExportTable({ data: [], header: [{ title: '列', dataIndex: 'x' }] }, res),
      ).resolves.toBeUndefined();

      // 写出失败仍要保证响应被结束，避免调用方一直等待
      expect(end).toHaveBeenCalled();
    });

    it('响应已结束时不再重复 end', async () => {
      const { res, end } = createMinimalResponse(true);
      mockXlsxWrite.mockResolvedValueOnce(undefined);

      await ExportTable({ data: [], header: [{ title: '列', dataIndex: 'x' }] }, res);

      expect(end).not.toHaveBeenCalled();
    });
  });

  describe('表头归一化与字典映射', () => {
    const readSheet = async (buffer: Buffer, sheetName: string) => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as never);

      return workbook.getWorksheet(sheetName);
    };

    it('支持 header/key 别名与自定义工作表名', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [{ age: 18 }],
          header: [{ header: '年龄', key: 'age' }],
          sheetName: '用户表',
          mode: 'buffer',
        },
        res,
      );

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, '用户表');

      expect(sheet).toBeDefined();
      expect(String(sheet?.getCell('A1').value)).toBe('年龄');
      expect(Number(sheet?.getCell('A2').value)).toBe(18);
    });

    it('列宽为空或非数字时回落到 16', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [],
          header: [
            { title: 'A', dataIndex: 'a', width: 30 },
            { title: 'B', dataIndex: 'b', width: Number.NaN },
            { title: 'C', dataIndex: 'c' },
          ],
          mode: 'buffer',
        },
        res,
      );

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(sheet?.getColumn(1).width).toBe(30);
      expect(sheet?.getColumn(2).width).toBe(16);
      expect(sheet?.getColumn(3).width).toBe(16);
    });

    it('自定义字典优先于内置字典，未命中时保留原值', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [
            { status: '0' },
            { status: '9' },
          ],
          header: [{ title: '状态', dataIndex: 'status' }],
          dictMap: { status: { '0': '自定义正常' } },
          mode: 'buffer',
        },
        res,
      );

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(String(sheet?.getCell('A2').value)).toBe('自定义正常');
      expect(String(sheet?.getCell('A3').value)).toBe('9');
    });

    it('内置字典包含状态/性别/删除标记映射', () => {
      expect(commonExportMap.status['1']).toBe('停用');
      expect(commonExportMap.sex['0']).toBe('男');
      expect(commonExportMap.delFlag['2']).toBe('已删除');
    });

    it('formateStr 在字典映射之后生效', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [{ sex: '1' }],
          header: [
            {
              title: '性别',
              dataIndex: 'sex',
              formateStr: (val: unknown) => `【${String(val)}】`,
            },
          ],
          mode: 'buffer',
        },
        res,
      );

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(String(sheet?.getCell('A2').value)).toBe('【女】');
    });

    it('formateStr 非函数时忽略', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable(
        {
          data: [{ name: '王五' }],
          header: [{ title: '姓名', dataIndex: 'name', formateStr: 'not-a-function' as never }],
          mode: 'buffer',
        },
        res,
      );

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(String(sheet?.getCell('A2').value)).toBe('王五');
    });

    it('表头既无 dataIndex 也无 key 时列键回落为空字符串', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable({ data: [{ x: 1 }], header: [{ title: '列' }], mode: 'buffer' }, res);

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(String(sheet?.getCell('A1').value)).toBe('列');
      // 未声明取值键时该列不应写入数据
      expect(sheet?.getCell('A2').value ?? null).toBeNull();
    });

    it('表头缺少 title/header 时使用空字符串', async () => {
      const { res, end } = createMinimalResponse();

      await ExportTable({ data: [], header: [{ dataIndex: 'x' }], mode: 'buffer' }, res);

      const buffer = (end.mock.calls[0] as unknown as [Buffer])[0] as unknown as Buffer;
      const sheet = await readSheet(buffer, 'Sheet1');

      expect(sheet?.getCell('A1').value ?? '').toBe('');
    });
  });
});
