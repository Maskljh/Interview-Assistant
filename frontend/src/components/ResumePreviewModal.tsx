import { useEffect, useRef, useState } from 'react';
import { getApiBase, getToken } from '../api/client';
import Dialog from './Dialog';
import './ResumePreviewModal.css';

/** 懒加载 pdfjs：只在真正打开 PDF 预览时加载，避免测试环境 DOMMatrix 缺失，也减小首屏体积。 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

interface ResumePreviewModalProps {
  open: boolean;
  /** 简历文件名（弹窗标题展示）。 */
  title: string;
  /** 解析后的文本（docx/txt/md 或 PDF 无文件时兜底展示）。 */
  text?: string;
  /** 简历原始文件（云文档导入等场景）；PDF 时逐页渲染。 */
  file?: File | null;
  /** 简历库中的文件代理 URL（/api/uploads/object?key=...）；PDF 时带 token 拉取渲染。 */
  fileUrl?: string | null;
  onClose: () => void;
}

function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/**
 * 简历预览弹窗：PDF 用 pdfjs 逐页渲染成图片（还原真实排版），
 * docx/txt/md 等展示解析文本。仅支持当前用户自己的简历文件。
 */
export default function ResumePreviewModal({
  open,
  title,
  text = '',
  file,
  fileUrl,
  onClose,
}: ResumePreviewModalProps) {
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pdfFailed, setPdfFailed] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    cancelRef.current = false;
    setPages([]);
    setError('');
    setPdfFailed(false);

    const renderPdf = async (data: ArrayBuffer) => {
      const { getDocument } = await loadPdfjs();
      const pdf = await getDocument({ data }).promise;
      const rendered: string[] = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        if (cancelRef.current) break;
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        // 按设备像素比放大渲染，避免高分屏（Retina/2x）上预览模糊；上限 2 防止超大 canvas。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = (680 / base.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        rendered.push(canvas.toDataURL('image/png'));
      }
      if (!cancelRef.current) setPages(rendered);
      await pdf.cleanup().catch(() => {});
    };

    setLoading(true);
    (async () => {
      try {
        if (file && isPdfName(file.name)) {
          await renderPdf(await file.arrayBuffer());
        } else if (fileUrl && isPdfName(fileUrl)) {
          const full = fileUrl.startsWith('http')
            ? fileUrl
            : `${getApiBase()}${fileUrl}`;
          const token = getToken();
          const res = await fetch(full, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          await renderPdf(await res.arrayBuffer());
        }
        // 非 PDF：直接使用 text 文本展示，无需加载动作。
      } catch {
        if (!cancelRef.current) {
          // PDF 文件加载/渲染失败时回退到文本预览（简历库文本仍可用）。
          if (text.trim()) {
            setPdfFailed(true);
          } else {
            setError('无法加载简历文件，请稍后重试');
          }
        }
      } finally {
        if (!cancelRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelRef.current = true;
    };
  }, [open, title, text, file, fileUrl]);

  const isPdfMode = Boolean(
    (file && isPdfName(file.name)) || (fileUrl && isPdfName(fileUrl)),
  );

  return (
    <Dialog open={open} title={`简历预览 · ${title}`} onClose={onClose} width={720}>
      <div className="resume-preview">
        {loading && <p className="interview-loading">正在加载简历…</p>}
        {error && <p className="dialog-error">{error}</p>}
        {!loading && !error && !pdfFailed && isPdfMode && pages.length === 0 && (
          <p className="dialog-error">PDF 中没有可渲染的页面</p>
        )}
        {!loading && !error && !pdfFailed && pages.map((src, i) => (
          <img
            key={src.slice(0, 32) + String(i)}
            src={src}
            alt={`简历第 ${i + 1} 页`}
            className="resume-preview-page"
          />
        ))}
        {!loading && !error && pdfFailed && text.trim() && (
          <p className="resume-preview-note">PDF 预览失败，已展示文本内容</p>
        )}
        {!loading && !error && (pdfFailed || !isPdfMode) && (
          text.trim() ? (
            <pre className="resume-preview-text">{text}</pre>
          ) : (
            <p className="interview-loading">该简历没有可预览的文本内容</p>
          )
        )}
      </div>
    </Dialog>
  );
}
