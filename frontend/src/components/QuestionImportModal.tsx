import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  confirmImport,
  parseImportImage,
  parseImportText,
  type ImportItem,
} from '../api/questions';
import { ApiError } from '../api/client';
import { extractResumeText } from '../lib/resumeParse';
import { importCloudFile, listCloudFiles, type WpsCloudFile } from '../api/wps';
import './QuestionImportModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  /** 现有题目内容列表，用于预览时标记重复题目（设计稿 duplicate 态）。 */
  existingQuestions?: string[];
}

/** 预览态单题：设计稿 import-preview-item。 */
interface PreviewItem {
  key: string;
  content: string;
  answer?: string;
  reference?: string;
  duplicate: boolean;
  skip: boolean;
}

interface WpsState {
  open: boolean;
  files: WpsCloudFile[];
  keyword: string;
  loading: boolean;
  error: string;
}

/** 题目归一：与设计稿 normalizeQuestionContent 一致，用于重复判断。 */
function normalizeQuestionContent(content: string): string {
  return String(content || '')
    .replace(/\s+/g, '')
    .replace(/[。！？!?，,、]/g, '')
    .toLowerCase();
}

/** 把原文按行拆成候选题目：去空行、去序号前缀（“1. ” / “1、” / “- ”）。 */
function splitLinesIntoItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\s*(?:\d+[.、．:：]?\s*|[-*]\s*)/, ''))
    .filter((line) => line.length > 0);
}

export default function QuestionImportModal({ open, onClose, onImported, existingQuestions = [] }: Props) {
  // ── 导入输入（设计稿 question-import-dialog） ──
  const [bankName, setBankName] = useState('');
  const [content, setContent] = useState('');
  const [validation, setValidation] = useState('');
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  // ── 导入预览（设计稿 import-preview-dialog） ──
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [previewBank, setPreviewBank] = useState('');
  const [editingKey, setEditingKey] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  // ── WPS 云文档选择（设计稿 wps-picker-dialog） ──
  const [wps, setWps] = useState<WpsState>({
    open: false,
    files: [],
    keyword: '',
    loading: false,
    error: '',
  });
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const existingSet = new Set(existingQuestions.map(normalizeQuestionContent));

  function buildPreview(contents: string[], bank: string, extra?: ImportItem[]) {
    const list = contents.length ? contents : (extra ?? []).map((it) => it.question);
    const seen = new Set<string>();
    const items: PreviewItem[] = list.map((rawContent, index) => {
      const normalized = normalizeQuestionContent(rawContent);
      const duplicate = !seen.has(normalized) && existingSet.has(normalized);
      seen.add(normalized);
      const matched = extra?.find((it) => it.question === rawContent);
      return {
        key: `${Date.now()}-${index}`,
        content: rawContent,
        answer: matched?.answer,
        reference: matched?.reference,
        duplicate,
        skip: duplicate,
      };
    });
    setPreviewBank(bank);
    setPreview(items);
    setEditingKey('');
    setImportError('');
  }

  /** 解析文本：优先后端 LLM 结构化，失败或空结果回退按行拆分（设计稿行为）。 */
  async function parseTextToItems(text: string): Promise<{ contents: string[]; extra?: ImportItem[] }> {
    try {
      const res = await parseImportText(text);
      if (res.items.length > 0) {
        return { contents: res.items.map((it) => it.question), extra: res.items };
      }
      if (res.raw.trim()) {
        const lines = splitLinesIntoItems(res.raw);
        if (lines.length > 0) return { contents: lines };
      }
    } catch {
      // 后端解析失败：回退本地按行拆分
    }
    return { contents: splitLinesIntoItems(text) };
  }

  /** “查看导入预览”：校验后解析题目列表并进入预览对话框。 */
  async function handlePreview() {
    const name = bankName.trim();
    const rawContent = content.trim();
    if (!name || !rawContent) {
      setValidation(!name && !rawContent ? '请填写题库名称和题目内容' : !name ? '请填写题库名称' : '请填写题目内容');
      return;
    }
    setValidation('');
    setParsing(true);
    try {
      const { contents, extra } = await parseTextToItems(rawContent);
      if (!contents.length) {
        setValidation('未识别出题目，请检查题目列表内容');
        return;
      }
      buildPreview(contents, name, extra);
    } finally {
      setParsing(false);
    }
  }

  /** 本地文件导入：图片走 OCR 识别，文档先提取文本再交给 LLM 结构化。 */
  async function handleFile(f: File | null) {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      setValidation('文件不能超过 10MB');
      return;
    }
    const name = bankName.trim() || f.name.replace(/\.[^.]+$/, '');
    setValidation('');
    setParsing(true);
    try {
      if (f.type.startsWith('image/')) {
        const res = await parseImportImage(f);
        const contents = res.items.length
          ? res.items.map((it) => it.question)
          : splitLinesIntoItems(res.ocr_text || res.raw);
        if (!contents.length) {
          setValidation('未识别出题目，请换一份文件再试');
          return;
        }
        buildPreview(contents, name, res.items);
        return;
      }
      const extracted = await extractResumeText(f);
      if (!extracted.trim()) {
        setValidation('文件内容为空，请换一份文件再试');
        return;
      }
      const { contents, extra } = await parseTextToItems(extracted);
      if (!contents.length) {
        setValidation('未识别出题目，请换一份文件再试');
        return;
      }
      buildPreview(contents, name, extra);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '解析失败';
      const rawMsg = err instanceof ApiError ? err.rawMessage : '';
      if (msg.includes('改用文本粘贴') || rawMsg.includes('unavailable')) {
        setValidation('图片识别失败，请改用文本粘贴');
      } else {
        setValidation(msg);
      }
    } finally {
      setParsing(false);
    }
  }

  /** 打开 WPS 云文档选择器并加载文件列表。 */
  async function openWpsPicker() {
    setWps({ open: true, files: [], keyword: '', loading: true, error: '' });
    try {
      const data = await listCloudFiles('');
      setWps((prev) => ({
        ...prev,
        files: data.items,
        loading: false,
        error: data.error ?? '',
      }));
    } catch (err) {
      setWps((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof ApiError ? err.message : '云文档加载失败，请稍后重试',
      }));
    }
  }

  /** 按关键词搜索 WPS 云文档。 */
  async function searchWps(keyword = wps.keyword) {
    setWps((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await listCloudFiles(keyword);
      setWps((prev) => ({ ...prev, files: data.items, loading: false, error: data.error ?? '' }));
    } catch (err) {
      setWps((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof ApiError ? err.message : '云文档搜索失败，请稍后重试',
      }));
    }
  }

  /** 选中云文档文件：后端下载转 base64，前端提取文本后按行生成预览。 */
  async function pickWpsFile(file: WpsCloudFile) {
    setWps((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const result = await importCloudFile(file);
      const bin = atob(result.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const local = new File([bytes], result.name, { type: result.mime_type });
      const text = await extractResumeText(local);
      const contents = splitLinesIntoItems(text);
      if (!contents.length) {
        setWps((prev) => ({ ...prev, loading: false, error: '未从文件中识别出题目' }));
        return;
      }
      const bank = bankName.trim() || file.name.replace(/\.[^.]+$/, '');
      setWps((prev) => ({ ...prev, open: false, loading: false }));
      buildPreview(contents, bank);
    } catch (err) {
      setWps((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof ApiError ? err.message : '云文档导入失败，请重试',
      }));
    }
  }

  function updatePreviewContent(key: string, value: string) {
    setPreview((prev) =>
      prev ? prev.map((it) => (it.key === key ? { ...it, content: value } : it)) : prev,
    );
  }

  function toggleSkip(key: string) {
    setPreview((prev) =>
      prev ? prev.map((it) => (it.key === key ? { ...it, skip: !it.skip } : it)) : prev,
    );
  }

  function removePreviewItem(key: string) {
    setPreview((prev) => (prev ? prev.filter((it) => it.key !== key) : prev));
  }

  /** 确认导入：跳过项剔除后提交后端。 */
  async function handleConfirm() {
    if (!preview) return;
    const valid = preview.filter((it) => !it.skip && it.content.trim());
    if (!valid.length) return;
    setImporting(true);
    setImportError('');
    try {
      await confirmImport(
        valid.map((it) => ({
          question: it.content,
          answer: it.answer,
          reference: it.reference,
        })),
        previewBank,
      );
      reset();
      onImported();
      onClose();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setBankName('');
    setContent('');
    setValidation('');
    setDragging(false);
    setParsing(false);
    setPreview(null);
    setPreviewBank('');
    setEditingKey('');
    setImporting(false);
    setImportError('');
    setWps({ open: false, files: [], keyword: '', loading: false, error: '' });
  }

  function close() {
    reset();
    onClose();
  }

  // 挂到 #design-root（缩放画布外）：fixed 定位相对视口、尺寸不被 --home-fit 缩放
  const host = typeof document !== 'undefined' ? document.getElementById('design-root') : null;
  const target = host ?? (typeof document !== 'undefined' ? document.body : null);

  const activeCount = preview ? preview.filter((it) => !it.skip && it.content.trim()).length : 0;
  const duplicateCount = preview ? preview.filter((it) => it.duplicate).length : 0;

  const dialog = preview ? (
    // ── 导入预览：设计稿 import-preview-dialog ──
    <div className="question-dialog-backdrop">
      <section
        className="question-add-dialog import-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入预览"
      >
        <header className="question-add-dialog-head">
          <div>
            <h2>导入预览</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={close}>
            ×
          </button>
        </header>
        <div className="question-add-dialog-rule" />
        <div className="import-preview-body">
          <div className="import-preview-summary">
            <span>将导入至「{previewBank}」</span>
            <small>
              {preview.length} 道题
              {duplicateCount ? `，其中 ${duplicateCount} 道与现有题目重复` : ''}
            </small>
          </div>
          <div className="import-preview-list">
            {preview.length ? (
              preview.map((item, index) => (
                <article
                  key={item.key}
                  className={`import-preview-item${item.duplicate ? ' duplicate' : ''}`}
                >
                  <span>{index + 1}</span>
                  {editingKey === item.key ? (
                    <textarea
                      autoFocus
                      value={item.content}
                      onChange={(e) => updatePreviewContent(item.key, e.target.value)}
                      onBlur={() => setEditingKey('')}
                      aria-label={`编辑第 ${index + 1} 题内容`}
                    />
                  ) : (
                    <strong
                      onClick={() => setEditingKey(item.key)}
                      title={item.content}
                    >
                      {item.content}
                    </strong>
                  )}
                  {item.duplicate ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={item.skip}
                        onChange={() => toggleSkip(item.key)}
                      />
                      跳过重复
                    </label>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => removePreviewItem(item.key)}
                    aria-label="删除题目"
                  >
                    ×
                  </button>
                </article>
              ))
            ) : (
              <div className="import-preview-empty">暂无可导入题目</div>
            )}
          </div>
          {importError && (
            <p className="import-preview-error" role="alert">
              {importError}
            </p>
          )}
          <div className="question-add-dialog-actions">
            <button
              type="button"
              className="management-action"
              disabled={!activeCount || importing}
              onClick={() => void handleConfirm()}
            >
              {importing ? '导入中…' : '确认导入'}
            </button>
          </div>
        </div>
      </section>
    </div>
  ) : wps.open ? (
    // ── 从 WPS 云文档选择：设计稿 wps-picker-dialog ──
    <div className="question-dialog-backdrop">
      <section
        className="question-add-dialog wps-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="从 WPS 云文档选择"
      >
        <header className="question-add-dialog-head">
          <div>
            <h2>从 WPS 云文档选择</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={close}>
            ×
          </button>
        </header>
        <div className="question-add-dialog-rule" />
        <div className="wps-picker-body">
          <div className="wps-picker-search">
            <input
              value={wps.keyword}
              onChange={(e) => setWps((prev) => ({ ...prev, keyword: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !wps.loading) void searchWps();
              }}
              placeholder="输入文件名搜索"
              aria-label="搜索云文档"
            />
            <button
              type="button"
              className="management-action"
              disabled={wps.loading}
              onClick={() => void searchWps()}
            >
              搜索
            </button>
          </div>
          <p className="wps-picker-tip">点击文件即可导入，导入前会自动识别题目</p>
          <div className="wps-picker-list">
            {wps.loading ? (
              <div className="wps-picker-empty">正在加载云文档…</div>
            ) : wps.error ? (
              <div className="wps-picker-empty">{wps.error}</div>
            ) : wps.files.length ? (
              wps.files.map((file) => (
                <article
                  key={file.id}
                  className="wps-file-item"
                  onClick={() => void pickWpsFile(file)}
                >
                  <div>
                    <strong>{file.name}</strong>
                    <span className="wps-file-mtime">
                      <small>
                        {new Date(file.mtime * 1000).toISOString().slice(0, 10).replace(/-/g, '.')}
                      </small>
                    </span>
                  </div>
                  <button type="button">选择</button>
                </article>
              ))
            ) : (
              <div className="wps-picker-empty">未找到匹配的云文档</div>
            )}
          </div>
        </div>
      </section>
    </div>
  ) : (
    // ── 导入题库：设计稿 question-import-dialog ──
    <div className="question-dialog-backdrop">
      <section className="question-import-dialog" role="dialog" aria-modal="true" aria-label="导入题库">
        <div className="dialog-title">
          <div>
            <h2>导入题库</h2>
            <p>支持文字、本地文件和 WPS 云文档导入</p>
          </div>
          <button type="button" aria-label="关闭" onClick={close}>
            ×
          </button>
        </div>
        <div className="question-add-dialog-rule" />
        <label>
          题库名称
          <input
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="例如：产品经理通用题库"
          />
        </label>
        <label
          className={`import-list-field${dragging ? ' is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleFile(e.dataTransfer.files?.[0] ?? null);
          }}
        >
          题目列表
          <textarea
            data-import-content=""
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="单题直接输入；多题回车输入有利于精准识别。"
          />
        </label>
        <div className="import-preview-action">
          <span className="import-validation" aria-live="polite">
            {validation}
          </span>
          <button
            type="button"
            className="management-action"
            disabled={parsing}
            onClick={() => void handlePreview()}
          >
            {parsing ? '识别中…' : '查看导入预览'}
          </button>
        </div>
        <div className="import-alternatives">
          <span>其他导入方式</span>
          <div className="import-alternative-list">
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".doc,.docx,.jpg,.jpeg,.png,.txt,.md,.pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void handleFile(f);
                }}
              />
              <button type="button" onClick={() => fileRef.current?.click()}>
                本地文件导入
              </button>
              <small>支持 DOC、DOCX、JPG、JPEG、PNG 文件</small>
            </div>
            <div>
              <button type="button" onClick={() => void openWpsPicker()}>
                WPS 云文档导入
              </button>
              <small>从 WPS 云文档中选择题库文件</small>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  return target ? createPortal(dialog, target) : dialog;
}
