import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuestionImportModal from './QuestionImportModal';
import type { ImportItem } from '../api/questions';
import { parseImportImage, parseImportText, confirmImport } from '../api/questions';
import { ApiError } from '../api/client';

// 组件内解析文档文件会用到 pdfjs（需要 DOMMatrix）；测试里 mock 掉文本解析器
vi.mock('../lib/resumeParse', () => ({
  extractResumeText: vi.fn(async (file: File) =>
    file.name === '题库.docx' ? '1. 云文档第一题\n2. 云文档第二题' : '1. 文件第一题\n2. 文件第二题',
  ),
}));

vi.mock('../api/wps', () => ({
  listCloudFiles: vi.fn(async () => ({
    items: [
      {
        id: 'w1',
        name: '题库.docx',
        drive_id: 'd1',
        link_url: null,
        mtime: 1700000000,
        size: 1024,
      },
    ],
    error: '',
  })),
  importCloudFile: vi.fn(async () => ({
    name: '题库.docx',
    base64: btoa('1. 云文档第一题\n2. 云文档第二题'),
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 2048,
  })),
}));

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

describe('QuestionImportModal（设计稿导入题库流程）', () => {
  it('打开时渲染导入题库输入对话框', () => {
    renderModal();
    expect(screen.getByText('导入题库')).toBeTruthy();
    expect(screen.getByText('支持文字、本地文件和 WPS 云文档导入')).toBeTruthy();
    expect(screen.getByPlaceholderText('例如：产品经理通用题库')).toBeTruthy();
    expect(screen.getByPlaceholderText(/单题直接输入/)).toBeTruthy();
    expect(screen.getByText('查看导入预览')).toBeTruthy();
    expect(screen.getByText('本地文件导入')).toBeTruthy();
    expect(screen.getByText('WPS 云文档导入')).toBeTruthy();
  });

  it('名称与内容缺失时显示设计稿校验文案', () => {
    renderModal();
    fireEvent.click(screen.getByText('查看导入预览'));
    expect(screen.getByText('请填写题库名称和题目内容')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('例如：产品经理通用题库'), {
      target: { value: '产品题库' },
    });
    fireEvent.click(screen.getByText('查看导入预览'));
    expect(screen.getByText('请填写题目内容')).toBeTruthy();
  });

  it('查看导入预览：后端解析结果进入预览对话框', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText('例如：产品经理通用题库'), {
      target: { value: '产品题库' },
    });
    fireEvent.change(screen.getByPlaceholderText(/单题直接输入/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('查看导入预览'));
    await waitFor(() => {
      expect(screen.getByText('导入预览')).toBeTruthy();
    });
    expect(screen.getByText('将导入至「产品题库」')).toBeTruthy();
    expect(screen.getByText('1 道题')).toBeTruthy();
    expect(screen.getByText('解析出的题目')).toBeTruthy();
    expect(parseImportText).toHaveBeenCalledWith('面经原文');
  });

  it('LLM 未识别时回退按行拆分', async () => {
    vi.mocked(parseImportText).mockResolvedValueOnce({
      items: [],
      raw: '1. React useEffect 依赖\n2. 虚拟 DOM 原理\n3. flex 与 grid 区别',
      ocr_text: '',
    });
    renderModal();
    fireEvent.change(screen.getByPlaceholderText('例如：产品经理通用题库'), {
      target: { value: '前端题库' },
    });
    fireEvent.change(screen.getByPlaceholderText(/单题直接输入/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('查看导入预览'));
    await waitFor(() => {
      expect(screen.getByText('React useEffect 依赖')).toBeTruthy();
    });
    expect(screen.getByText('虚拟 DOM 原理')).toBeTruthy();
    expect(screen.getByText('flex 与 grid 区别')).toBeTruthy();
    expect(screen.getByText('3 道题')).toBeTruthy();
  });

  it('确认导入：提交后端并回调 onImported', async () => {
    const onImported = vi.fn();
    const onClose = vi.fn();
    renderModal(true, onClose, onImported);
    fireEvent.change(screen.getByPlaceholderText('例如：产品经理通用题库'), {
      target: { value: '产品题库' },
    });
    fireEvent.change(screen.getByPlaceholderText(/单题直接输入/), {
      target: { value: '面经原文' },
    });
    fireEvent.click(screen.getByText('查看导入预览'));
    await waitFor(() => {
      expect(screen.getByText('导入预览')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(confirmImport).toHaveBeenCalledWith(
        [{ question: '解析出的题目', answer: '答案', reference: undefined }],
        '产品题库',
      );
    });
    await waitFor(() => {
      expect(onImported).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('本地图片导入：OCR 不可用时显示指定文案', async () => {
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
    await waitFor(() => {
      expect(screen.getByText('图片识别失败，请改用文本粘贴')).toBeTruthy();
    });
    // 通用 502 文案不得出现
    expect(screen.queryByText('服务器开小差了，请稍后重试')).toBeNull();
  });

  it('本地文档导入：提取文本后解析并进入预览', async () => {
    const { container } = renderModal();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    fireEvent.change(fileInput, {
      target: { files: [new File(['resume'], 'notes.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => {
      expect(screen.getByText('导入预览')).toBeTruthy();
    });
    expect(parseImportText).toHaveBeenCalled();
  });

  it('WPS 云文档导入：选择文件后进入预览', async () => {
    renderModal();
    fireEvent.click(screen.getByText('WPS 云文档导入'));
    await waitFor(() => {
      expect(screen.getByText('从 WPS 云文档选择')).toBeTruthy();
      expect(screen.getByText('题库.docx')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('选择'));
    await waitFor(() => {
      expect(screen.getByText('导入预览')).toBeTruthy();
    });
    expect(screen.getByText('云文档第一题')).toBeTruthy();
    expect(screen.getByText('将导入至「题库」')).toBeTruthy();
  });
});
