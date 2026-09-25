import * as ExcelJS from 'exceljs';
import * as mammoth from 'mammoth';
import { htmlToText } from 'html-to-text';
import JSZip from 'jszip';

/** OOXML 文本节点解码：把 <a:t>…</a:t> / <t>…</t> 里的内容拼成纯文本 */
function decodeXmlEntities(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 把单张幻灯片 XML 的 <a:t> 文本运行拼成纯文本 */
export function pptxXmlToText(xml: string) {
  const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
  return runs.map((r) => decodeXmlEntities(r.replace(/<\/?a:t>/g, ''))).join('');
}

/**
 * 从 PPTX 文件的幻灯片 XML 中提取纯文本。
 * @param buffer - PPTX 文件缓冲区
 * @returns 所有幻灯片的文本内容，按序号顺序拼接
 */
async function extractPptxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  // 仅取幻灯片正文，按 slideN 顺序保证阅读顺序
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });
  const slides: string[] = [];
  for (const p of slidePaths) {
    const xml = await zip.files[p].async('string');
    const text = pptxXmlToText(xml);
    if (text.trim()) slides.push(text);
  }
  return slides.join('\n');
}

/**
 * 根据文档类型从缓冲区中提取文本内容。支持的格式：txt/md/json/csv、pdf、docx、pptx、xlsx/xls、html/htm。
 * @param buffer - 文件缓冲区
 * @param type - 文档类型（小写扩展名）
 * @returns 提取后的纯文本
 */
export async function extractTextByType(buffer: Buffer, type: string) {
  const t = String(type || '').toLowerCase();
  if (t === 'txt' || t === 'md' || t === 'json' || t === 'csv') {
    return buffer.toString('utf8');
  }
  if (t === 'pdf') {
    // 惰性加载 pdf-parse：其内部的 pdfjs 在 Node 下会尝试加载 @napi-rs/canvas 做 DOM polyfill
    // （缺该依赖时 pdfjs 在模块顶层 new DOMMatrix() 会直接抛错），延迟到此处可避免
    // 非 PDF 场景乃至应用启动被这个原生依赖影响
    let PDFParse: typeof import('pdf-parse').PDFParse;
    try {
      ({ PDFParse } = await import('pdf-parse'));
    } catch (error) {
      throw new Error(`PDF 解析依赖加载失败（请确认已安装 @napi-rs/canvas）：${(error as Error).message}`);
    }

    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }
  if (t === 'docx') {
    const res = await mammoth.extractRawText({ buffer });
    return res.value || '';
  }
  if (t === 'pptx') {
    return extractPptxText(buffer);
  }
  if (t === 'xlsx' || t === 'xls') {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const parts: string[] = [];
    workbook.worksheets.forEach((sheet) => {
      sheet.eachRow((row) => {
        const cells = row.values as any[];
        const line = cells
          .slice(1)
          .map((v) => (v === null || v === undefined ? '' : String(v)))
          .join('\t')
          .trim();
        if (line) parts.push(line);
      });
    });
    return parts.join('\n');
  }
  if (t === 'html' || t === 'htm') {
    const html = buffer.toString('utf8');
    return htmlToText(html, { wordwrap: false });
  }
  return buffer.toString('utf8');
}

/** ponytail: fails if pptx run extraction or entity decode breaks */
export function pptxXmlToTextSelfCheck() {
  const xml = '<a:p><a:r><a:t>Hello &amp; </a:t></a:r><a:r><a:t>&lt;world&gt;</a:t></a:r></a:p>';
  const out = pptxXmlToText(xml);
  if (out !== 'Hello & <world>') throw new Error(`pptxXmlToText broken: ${out}`);
}
