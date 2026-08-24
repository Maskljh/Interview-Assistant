import { useRef, useState } from 'react';
import {
  confirmImport,
  parseImportImage,
  parseImportText,
  type ImportItem,
  type ImportParseResult,
} from '../api/questions';
import { ApiError } from '../api/client';
import './QuestionImportModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

type Step = 'input' | 'candidates' | 'done';

export default function QuestionImportModal({ open, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [text, setText] = useState('');
  const [jobTag, setJobTag] = useState('');
  const [imageName, setImageName] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [raw, setRaw] = useState('');
  const [ocrText, setOcrText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;
  async function handleParse() {
    setParsing(true);
    setError('');
    setMessage('');
    try {
      let res: ImportParseResult;
      if (imageFile) {
        res = await parseImportImage(imageFile);
      } else if (text.trim()) {
        res = await parseImportText(text);
      } else {
        setError('请粘贴面经文本或上传图片');
        return;
      }
      setItems(res.items);
      setRaw(res.raw);
      setOcrText(res.ocr_text);
      // 有解析结果进候选编辑。LLM 解析失败时（items 空但 raw 非空），
      // 自动按行拆分原文生成候选，用户可直接编辑——避免看到"0 道题 + 只读原文"。
      if (res.items.length === 0 && res.raw.trim()) {
        const lines = splitLinesIntoItems(res.raw);
        if (lines.length > 0) {
          setItems(lines);
          setRaw('');
        }
      }
      setStep('candidates');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '解析失败';
      // OCR 不可用时后端返回 502，错误文案被 toUserMessage 映射成通用提示，
      // 必须用原始 message（rawMessage）识别该场景并展示强制的提示文案。
      const raw = err instanceof ApiError ? err.rawMessage : '';
      if (msg.includes('改用文本粘贴') || raw.includes('unavailable')) {
        setError('图片识别失败，请改用文本粘贴');
      } else {
        setError(msg);
      }
    } finally {
      setParsing(false);
    }
  }

  function updateItem(index: number, patch: Partial<ImportItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function addItem() {
    setItems((prev) => [...prev, { question: '' }]);
  }

  // 把原文按行拆成候选题目：去空行、去序号前缀（"1. " / "1、" / "- "）。
  function splitLinesIntoItems(text: string): ImportItem[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\s*(?:\d+[\.、．:：]?\s*|[-*]\s*)/, ''))
      .filter((line) => line.length > 0)
      .map((question) => ({ question }));
  }

  // 手动把 raw 原文按行拆成候选题目（用户在 raw 模式整理后点此按钮）。
  function splitRawIntoItems() {
    const next = splitLinesIntoItems(raw);
    if (next.length > 0) {
      setItems((prev) => [...prev, ...next]);
      setRaw('');
    }
  }

  async function handleConfirm() {
    setParsing(true);
    setError('');
    setMessage('');
    const valid = items.filter((it) => it.question.trim() !== '');
    try {
      const res = await confirmImport(valid, jobTag);
      setMessage(`新增 ${res.imported} 题，跳过 ${res.skipped} 题重复`);
      setStep('done');
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败');
    } finally {
      setParsing(false);
    }
  }

  function reset() {
    setStep('input');
    setText('');
    setJobTag('');
    setImageName('');
    setImageFile(null);
    setItems([]);
    setRaw('');
    setOcrText('');
    setError('');
    setMessage('');
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <div className="import-modal-backdrop" role="dialog" aria-modal="true" aria-label="导入题目">
      <div className="import-modal">
        <div className="import-modal-header">
          <h2>导入题目</h2>
          <button type="button" className="import-modal-close" onClick={close}>
            ✕
          </button>
        </div>

        {step === 'input' && (
          <div className="import-modal-body">
            <div className="interview-field">
              <label htmlFor="import-text">面经文本</label>
              <textarea
                id="import-text"
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴面经文本…"
              />
            </div>
            <div className="interview-field">
              <label htmlFor="import-job-tag">岗位标签（可选）</label>
              <input
                id="import-job-tag"
                type="text"
                value={jobTag}
                onChange={(e) => setJobTag(e.target.value)}
                placeholder="例如：后端开发"
              />
            </div>
            <div className="interview-field">
              <label>或上传图片（截图）</label>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 5 * 1024 * 1024) {
                    setError('图片不能超过 5MB');
                    return;
                  }
                  setImageFile(f);
                  setImageName(f ? f.name : '');
                }}
              />
              {imageName && <p className="import-file-name">{imageName}</p>}
            </div>
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button
                type="button"
                className="interview-submit"
                disabled={parsing}
                onClick={() => void handleParse()}
              >
                {parsing ? '解析中…' : '解析'}
              </button>
              <button type="button" className="interview-inline-link" onClick={close}>
                取消
              </button>
            </div>
          </div>
        )}

        {step === 'candidates' && (
          <div className="import-modal-body">
            <div className="import-candidates-header">
              <h3 className="import-candidates-title">
                已解析 {items.length} 道题目
              </h3>
              <p className="import-hint">
                请核对以下解析结果，可直接编辑修改，确认无误后点击「确认导入」。
              </p>
            </div>
            {ocrText && (
              <details className="import-ocr-detail">
                <summary>查看 OCR 识别原文</summary>
                <p className="import-ocr-text">{ocrText}</p>
              </details>
            )}
            {raw && !items.length && (
              <>
                <p className="interview-error">自动解析未识别出题目，请手动整理以下原文。</p>
                <div className="import-raw-block">
                  <label htmlFor="import-raw-edit" className="import-field-label">
                    原文（可直接编辑，一行一题）
                  </label>
                  <textarea
                    id="import-raw-edit"
                    rows={6}
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    className="import-raw"
                    placeholder="可编辑原文，整理成一行一道题…"
                  />
                  <button
                    type="button"
                    className="interview-inline-link"
                    onClick={splitRawIntoItems}
                  >
                    按行拆分为题目
                  </button>
                </div>
              </>
            )}
            {items.map((it, i) => (
              <div key={i} className="import-candidate">
                <div className="import-candidate-head">
                  <span className="import-candidate-index">第 {i + 1} 题</span>
                  <button
                    type="button"
                    className="interview-inline-link"
                    onClick={() => removeItem(i)}
                  >
                    删除
                  </button>
                </div>
                <div className="import-field">
                  <label htmlFor={`q-${i}`}>题干</label>
                  <input
                    id={`q-${i}`}
                    className="import-candidate-question"
                    value={it.question}
                    onChange={(e) => updateItem(i, { question: e.target.value })}
                    placeholder="点击可修改题干…"
                  />
                </div>
                <div className="import-field">
                  <label htmlFor={`a-${i}`}>参考答案（可选）</label>
                  <textarea
                    id={`a-${i}`}
                    rows={2}
                    value={it.answer ?? ''}
                    onChange={(e) => updateItem(i, { answer: e.target.value })}
                    placeholder="点击可填写参考答案…"
                  />
                </div>
                <div className="import-field">
                  <label htmlFor={`r-${i}`}>出处（可选）</label>
                  <input
                    id={`r-${i}`}
                    value={it.reference ?? ''}
                    onChange={(e) => updateItem(i, { reference: e.target.value })}
                    placeholder="点击可填写出处…"
                  />
                </div>
              </div>
            ))}
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button
                type="button"
                className="interview-inline-link"
                onClick={addItem}
                disabled={parsing}
              >
                + 新增题目
              </button>
              <button
                type="button"
                className="interview-inline-link"
                onClick={() => setStep('input')}
              >
                返回
              </button>
              <button
                type="button"
                className="interview-submit"
                disabled={parsing || items.filter((x) => x.question.trim()).length === 0}
                onClick={() => void handleConfirm()}
              >
                {parsing
                  ? '导入中…'
                  : `确认导入 ${items.filter((x) => x.question.trim()).length} 题`}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="import-modal-body">
            {message && <p className="interview-success">{message}</p>}
            {error && <p className="interview-error">{error}</p>}
            <div className="import-modal-actions">
              <button type="button" className="interview-submit" onClick={close}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
