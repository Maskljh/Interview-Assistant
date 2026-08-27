import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateInterviewPage from './CreateInterviewPage';
import { AuthProvider } from '../auth/AuthContext';
import { recognizeImage } from '../api/ocr';
import { listQuestions } from '../api/questions';


vi.mock('../api/ocr', () => ({
  recognizeImage: vi.fn(async () => ({ text: '识别出的 JD 文本' })),
}));

// pdfjs-dist requires DOMMatrix/legacy build at import time in Node; mock the parser
// so the page module graph loads in jsdom without pulling in PDF worker internals.
vi.mock('../lib/resumeParse', () => ({
  extractResumeText: vi.fn(async () => ''),
}));

// 简历库 / 题库 API mock
vi.mock('../api/resumes', () => ({
  listResumes: vi.fn(async () => []),
}));
vi.mock('../api/questions', () => ({
  listQuestions: vi.fn(async () => [
    { id: 1, question: '请介绍一个你主导的项目', source: 'import', starred: false, usage_count: 0, created_at: '2026-01-01' },
    { id: 2, question: '如何处理需求冲突？', source: 'import', starred: false, usage_count: 0, created_at: '2026-01-01' },
  ]),
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

/** 点击「面试岗位」卡的「选择」按钮，打开 JD/岗位信息 Modal */
function openJdModal() {
  fireEvent.click(screen.getAllByRole('button', { name: '选择' })[0]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateInterviewPage 面试间准备页', () => {
  it('渲染标题、四卡片与开始按钮', () => {
    renderPage();
    expect(screen.getByText('面试间准备')).toBeTruthy();
    expect(screen.getByText(/选择面试岗位开始面试/)).toBeTruthy();
    // 四卡片标题
    expect(screen.getByText('面试岗位')).toBeTruthy();
    expect(screen.getByText('个人简历')).toBeTruthy();
    expect(screen.getByText('岗位信息')).toBeTruthy();
    expect(screen.getByText('选择题库')).toBeTruthy();
    // 开始按钮
    expect(screen.getByRole('button', { name: /开始模拟面试/ })).toBeTruthy();
  });

  it('初始展示占位文案', () => {
    renderPage();
    expect(screen.getByText('点击选择 ▽')).toBeTruthy();
    expect(screen.getByText(/暂无岗位信息/)).toBeTruthy();
    expect(screen.getByText(/暂无题目，请导入/)).toBeTruthy();
  });

  it('目标岗位从 JD 首行提取', () => {
    renderPage();
    openJdModal();
    const ta = screen.getByLabelText('岗位 JD') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '高级产品经理\n1. 负责增长方向...' } });
    // 关闭 Modal 后卡片显示提取的岗位名
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText('高级产品经理')).toBeTruthy();
    expect(screen.queryByText('点击选择 ▽')).toBeNull();
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

  it('简历拖拽上传：成功解析后关闭 Modal，卡片显示文件名', async () => {
    renderPage();
    // 打开简历 Modal：先出「来源选择」，点「自己上传」进入上传弹窗
    fireEvent.click(screen.getByRole('button', { name: '上传' }));
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
    // 卡片显示文件名，按钮变为「替换」
    expect(screen.getByText('resume.txt')).toBeTruthy();
    expect(screen.getByRole('button', { name: '替换' })).toBeTruthy();
  });

  it('选择题库：打开弹窗可勾选题目', async () => {
    renderPage();
    // 「选择题库」卡的「导入」按钮打开题库弹窗
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(screen.getByRole('dialog', { name: '选择题库' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('请介绍一个你主导的项目')).toBeTruthy();
    });
    // 勾选一题（限定在弹窗内的 .bank-pick-question）
    const bankItem = screen.getByText('请介绍一个你主导的项目').closest('.bank-pick-item');
    fireEvent.click(bankItem!);
    expect(bankItem?.className).toContain('is-selected');
  });

  it('未填简历时开始面试被拦截并提示', () => {
    renderPage();
    // 先填 JD，否则先报「请填写岗位信息」
    openJdModal();
    const ta = screen.getByLabelText('岗位 JD') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '高级产品经理\n1. 负责增长方向...' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    // 未填简历直接开始 → 提示上传简历
    fireEvent.click(screen.getByRole('button', { name: /开始模拟面试/ }));
    expect(screen.getByText('请上传或填写简历')).toBeTruthy();
  });

  it('题库勾选超过 10 题被阻止并提示', async () => {
    vi.mocked(listQuestions).mockResolvedValueOnce(
      Array.from({ length: 11 }, (_, i) => ({
        id: i + 1,
        question: `题目 ${i + 1}`,
        answer: null,
        user_answer: null,
        source_session_id: null,
        reference: null,
        source: 'import',
        starred: false,
        usage_count: 0,
        created_at: '2026-01-01',
        job_tag: '电商项目',
        dimension: 'logic',
      })),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(screen.getByText('题目 1')).toBeTruthy());
    // 勾选前 10 题
    for (let i = 1; i <= 10; i++) {
      fireEvent.click(screen.getByText(`题目 ${i}`).closest('.bank-pick-item')!);
    }
    // 第 11 题被阻止并提示
    fireEvent.click(screen.getByText('题目 11').closest('.bank-pick-item')!);
    expect(screen.getByText(/最多选择 10 题/)).toBeTruthy();
    expect(screen.getByText(/共 10 题/)).toBeTruthy();
  });

  it('已选列表显示推荐范围提示', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(screen.getByText('请介绍一个你主导的项目')).toBeTruthy());
    const bankItem = screen.getByText('请介绍一个你主导的项目').closest('.bank-pick-item');
    fireEvent.click(bankItem!);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText(/建议 5~8 题/)).toBeTruthy();
  });

  it('所选题目来自同一项目时显示补全提示', async () => {
    vi.mocked(listQuestions).mockResolvedValueOnce([
      {
        id: 1,
        question: '电商项目A',
        answer: null,
        user_answer: null,
        source_session_id: null,
        reference: null,
        source: 'import',
        starred: false,
        usage_count: 0,
        created_at: '2026-01-01',
        job_tag: '电商项目',
        dimension: 'logic',
      },
      {
        id: 2,
        question: '电商项目B',
        answer: null,
        user_answer: null,
        source_session_id: null,
        reference: null,
        source: 'import',
        starred: false,
        usage_count: 0,
        created_at: '2026-01-01',
        job_tag: '电商项目',
        dimension: 'content',
      },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(screen.getByText('电商项目A')).toBeTruthy());
    fireEvent.click(screen.getByText('电商项目A').closest('.bank-pick-item')!);
    fireEvent.click(screen.getByText('电商项目B').closest('.bank-pick-item')!);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText(/所选题目都来自同一项目/)).toBeTruthy();
  });
});
