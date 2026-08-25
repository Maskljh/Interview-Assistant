import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateInterviewPage from './CreateInterviewPage';
import { AuthProvider } from '../auth/AuthContext';
import { recognizeImage } from '../api/ocr';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

vi.mock('../api/ocr', () => ({
  recognizeImage: vi.fn(async () => ({ text: '识别出的 JD 文本' })),
}));

// pdfjs-dist requires DOMMatrix/legacy build at import time in Node; mock the parser
// so the page module graph loads in jsdom without pulling in PDF worker internals.
vi.mock('../lib/resumeParse', () => ({
  extractResumeText: vi.fn(async () => ''),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <CreateInterviewPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** 点击 JD 行的「导入」按钮，打开 JD 编辑 Modal */
function openJdModal() {
  fireEvent.click(screen.getByTestId('jd-import-btn'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateInterviewPage 准备配置页', () => {
  it('展示态显示未导入与四个步骤，右侧计划摘要', () => {
    renderPage();
    expect(screen.getByText('开始一场更像真实面试的练习')).toBeTruthy();
    // 进度条
    expect(screen.getByText('01 资料准备')).toBeTruthy();
    expect(screen.getByText('04 开始面试')).toBeTruthy();
    // 资料卡展示态
    expect(screen.getByText('我的简历')).toBeTruthy();
    expect(screen.getAllByText('未导入').length).toBe(2);
    expect(screen.getByText('目标岗位')).toBeTruthy();
    expect(screen.getByText('未设置')).toBeTruthy();
    // 右侧计划卡摘要
    expect(screen.getByText('面试时长')).toBeTruthy();
    expect(screen.getByText('30 分钟')).toBeTruthy();
    expect(screen.getByText('视频行为分析')).toBeTruthy();
    expect(screen.getByRole('button', { name: /开始模拟面试/ })).toBeTruthy();
    // 编辑 Modal 默认不显示
    expect(screen.queryByLabelText('岗位 JD')).toBeNull();
  });

  it('目标岗位从 JD 首行提取', () => {
    renderPage();
    openJdModal();
    const ta = screen.getByLabelText('岗位 JD') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '高级产品经理\n1. 负责增长方向...' } });
    expect(screen.getByText('高级产品经理')).toBeTruthy();
    expect(screen.queryByText('未设置')).toBeNull();
  });

  it('JD 编辑器打开后显示拖拽上传区', () => {
    renderPage();
    openJdModal();
    expect(screen.getByText(/拖拽文件或图片到这里/)).toBeTruthy();
    expect(screen.getByText(/自动 OCR/)).toBeTruthy();
  });

  it('fills JD textarea with OCR text after dropping image', async () => {
    renderPage();
    openJdModal();
    const dropzone = screen.getByRole('button', { name: '上传岗位 JD' });
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect((screen.getByLabelText('岗位 JD') as HTMLTextAreaElement).value).toBe('识别出的 JD 文本');
    });
    expect(recognizeImage).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/图片识别失败|未识别到文字/)).toBeNull();
  });

  it('rejects files larger than 10MB without calling OCR', async () => {
    renderPage();
    openJdModal();
    const dropzone = screen.getByRole('button', { name: '上传岗位 JD' });
    const bigFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'big.png', {
      type: 'image/png',
    });
    fireEvent.drop(dropzone, { dataTransfer: { files: [bigFile] } });
    await waitFor(() => {
      expect(screen.getByText('文件不能超过 10MB')).toBeTruthy();
    });
    expect(recognizeImage).not.toHaveBeenCalled();
  });

  it('clears the error when OCR returns no text', async () => {
    vi.mocked(recognizeImage).mockResolvedValueOnce({ text: '   ' });
    renderPage();
    openJdModal();
    const dropzone = screen.getByRole('button', { name: '上传岗位 JD' });
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText('未识别到文字，请尝试更清晰的图片')).toBeTruthy();
    });
  });

  it('shows error when OCR recognition fails', async () => {
    vi.mocked(recognizeImage).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    openJdModal();
    const dropzone = screen.getByRole('button', { name: '上传岗位 JD' });
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText('图片识别失败')).toBeTruthy();
    });
  });

  it('计划卡点击行打开选择 Modal', () => {
    renderPage();
    fireEvent.click(screen.getByText('面试风格'));
    // Modal 弹出，含选项胶囊
    expect(screen.getByRole('dialog', { name: '选择面试风格' })).toBeTruthy();
    expect(screen.getByText('严厉技术面')).toBeTruthy();
  });

  it('简历拖拽上传：成功解析后关闭 Modal', async () => {
    renderPage();
    // 打开简历 Modal：先出「来源选择」，点「自己上传」进入上传弹窗
    fireEvent.click(screen.getAllByRole('button', { name: '导入' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /自己上传/ }));
    expect(screen.getByRole('dialog', { name: '导入简历' })).toBeTruthy();
    expect(screen.getByText('拖拽简历到这里，或点击选择文件')).toBeTruthy();

    // 模拟拖入合法文件（.txt）
    const file = new File(['简历内容'], 'resume.txt', { type: 'text/plain' });
    const dropzone = screen.getByRole('button', { name: '上传简历' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    // 解析成功 → Modal 自动关闭
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导入简历' })).toBeNull();
    });
  });

  it('简历拖拽上传：不支持的格式提示错误且不关闭', async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: '导入' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /自己上传/ }));
    const dropzone = screen.getByRole('button', { name: '上传简历' });
    const badFile = new File(['x'], 'resume.exe', { type: 'application/octet-stream' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [badFile] } });
    await waitFor(() => {
      expect(screen.getByText('不支持的文件类型，请上传 .txt、.md、.pdf 或 .docx 文件')).toBeTruthy();
    });
    // Modal 仍打开
    expect(screen.getByRole('dialog', { name: '导入简历' })).toBeTruthy();
  });
});
