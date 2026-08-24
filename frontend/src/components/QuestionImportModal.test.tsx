import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuestionImportModal from './QuestionImportModal';
import type { ImportItem } from '../api/questions';
import { parseImportImage } from '../api/questions';
import { ApiError } from '../api/client';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

vi.mock('../api/questions', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    parseImportText: vi.fn(async () => ({
      items: [{ question: '解析出的题目', answer: '答案' }] as ImportItem[],
      raw: '',
      ocr_text: '',
    })),
    parseImportImage: vi.fn(async () => ({
      items: [] as ImportItem[],
      raw: '',
      ocr_text: 'OCR 文本',
    })),
    confirmImport: vi.fn(async () => ({ imported: 2, skipped: 1 })),
  };
});

function renderModal(open = true, onClose = vi.fn(), onImported = vi.fn()) {
  return render(
    <QuestionImportModal open={open} onClose={onClose} onImported={onImported} />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuestionImportModal', () => {
  it('renders input step when open', () => {
    renderModal();
    expect(screen.getByText('导入题目')).toBeTruthy();
    expect(screen.getByPlaceholderText(/粘贴面经文本/)).toBeTruthy();
  });

  it('parses text and shows editable candidates', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/粘贴面经文本/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByDisplayValue('解析出的题目')).toBeTruthy();
    });
  });

  it('confirms import and reports counts', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/粘贴面经文本/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByDisplayValue('解析出的题目')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(screen.getByText(/新增 2 题，跳过 1 题重复/)).toBeTruthy();
    });
  });

  it('shows mandated copy when OCR is unavailable (502)', async () => {
    const err = new ApiError(
      502,
      '服务器开小差了，请稍后重试',
      'image recognition unavailable, please use text input',
    );
    vi.mocked(parseImportImage).mockRejectedValueOnce(err);
    const { container } = renderModal();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByText('图片识别失败，请改用文本粘贴')).toBeTruthy();
    });
    // 通用 502 文案不得出现
    expect(screen.queryByText('服务器开小差了，请稍后重试')).toBeNull();
  });
});
