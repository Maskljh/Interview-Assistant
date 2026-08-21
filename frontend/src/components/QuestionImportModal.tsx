import { useRef, useState } from 'react';
import {
  confirmImport,
  parseImportImage,
  parseImportText,
  type ImportItem,
  type ImportParseResult,
} from '../api/questions';
import { ApiError } from '../api/client';

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
      setStep('candidates'); // 有解析结果进候选编辑；无结果（raw 模式）也进候选区手动整理
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '解析失败';
      if (msg.includes('改用文本粘贴') || msg.includes('unavailable')) {
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
            <p className="import-hint">
              已解析 {items.length} 题，可编辑后确认导入。
              {raw && !items.length && ' 自动解析失败，请手动整理以下原文。'}
            </p>
            {raw && !items.length && (
              <textarea rows={6} value={raw} readOnly className="import-raw" />
            )}
            {ocrText && (
              <details className="import-ocr-detail">
                <summary>查看 OCR 识别原文</summary>
                <p className="import-ocr-text">{ocrText}</p>
              </details>
            )}
            {items.map((it, i) => (
              <div key={i} className="import-candidate">
                <input
                  className="import-candidate-question"
                  value={it.question}
                  onChange={(e) => updateItem(i, { question: e.target.value })}
                  placeholder="题干"
                />
                <textarea
                  rows={2}
                  value={it.answer ?? ''}
                  onChange={(e) => updateItem(i, { answer: e.target.value })}
                  placeholder="参考答案（可选）"
                />
                <input
                  value={it.reference ?? ''}
                  onChange={(e) => updateItem(i, { reference: e.target.value })}
                  placeholder="出处（可选）"
                />
                <button
                  type="button"
                  className="interview-inline-link"
                  onClick={() => removeItem(i)}
                >
                  删除
                </button>
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
                className="interview-submit"
                disabled={parsing || items.filter((x) => x.question.trim()).length === 0}
                onClick={() => void handleConfirm()}
              >
                {parsing ? '导入中…' : '确认导入'}
              </button>
              <button
                type="button"
                className="interview-inline-link"
                onClick={() => setStep('input')}
              >
                返回
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
