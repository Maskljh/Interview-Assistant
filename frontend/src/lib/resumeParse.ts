import mammoth from 'mammoth';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

const TEXT_EXTS = new Set(['.txt', '.md', '.text', '.csv']);
const DOCX_EXTS = new Set(['.docx']);
const PDF_EXTS = new Set(['.pdf']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

async function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

async function readAsText(file: File): Promise<string> {
  return file.text();
}

async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const pdf = await getDocument({ data }).promise;
  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');
    if (line.trim()) {
      parts.push(line.trim());
    }
  }
  return parts.join('\n\n');
}

async function extractDocxText(data: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return result.value ?? '';
}

/** Extract plain text from an uploaded resume file (txt/md/pdf/docx). */
export async function extractResumeText(file: File): Promise<string> {
  const ext = extOf(file.name);
  const lowerType = file.type.toLowerCase();

  if (ext === '.doc' || lowerType === 'application/msword') {
    throw new Error('暂不支持旧版 .doc，请另存为 .docx、.pdf 或 .txt 后上传');
  }

  if (TEXT_EXTS.has(ext) || lowerType.startsWith('text/')) {
    const text = (await readAsText(file)).trim();
    if (!text) {
      throw new Error('文件内容为空，请换一份简历再试');
    }
    return text;
  }

  if (
    DOCX_EXTS.has(ext) ||
    lowerType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const text = (await extractDocxText(await readAsArrayBuffer(file))).trim();
    if (!text) {
      throw new Error('未能从 Word 文件中提取文字，请检查文件或改用 .txt');
    }
    return text;
  }

  if (PDF_EXTS.has(ext) || lowerType === 'application/pdf') {
    const text = (await extractPdfText(await readAsArrayBuffer(file))).trim();
    if (!text) {
      throw new Error(
        '未能从 PDF 中提取文字（可能是扫描件图片）。请上传可选中文字的 PDF，或另存为 .txt',
      );
    }
    return text;
  }

  throw new Error('仅支持 .txt、.md、.pdf、.docx 格式的简历文件');
}
