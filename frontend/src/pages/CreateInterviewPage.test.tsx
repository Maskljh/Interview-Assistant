import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// 简历库 / 题库 / 面试创建 API mock
vi.mock('../api/resumes', () => ({
  listResumes: vi.fn(async () => []),
}));
vi.mock('../api/questions', () => ({
  listQuestions: vi.fn(async () => [
    { id: 1, question: '请介绍一个你主导的项目', source: 'import', starred: false, usage_count: 0, created_at: '2026-01-01' },
    { id: 2, question: '如何处理需求冲突？', source: 'import', starred: false, usage_count: 0, created_at: '2026-01-01' },
  ]),
}));
vi.mock('../api/interviews', () => ({
  createInterview: vi.fn(async () => ({ id: 1 })),
  createInterviewFromBank: vi.fn(async () => ({ id: 1 })),
  startInterview: vi.fn(async () => ({ id: 1 })),
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

/** 按卡片标题定位卡片容器，精确点击卡内「导入」按钮（页面上有多个同名按钮）。 */
function openCardModal(cardTitle: string) {
  const card = screen.getByText(cardTitle).closest('article');
  if (!card) throw new Error(`未找到卡片：${cardTitle}`);
  fireEvent.click(within(card).getByRole('button', { name: '导入' }));
}

/** 打开岗位下拉并输入/确定一个岗位。 */
function chooseJobByInput(job: string) {
  fireEvent.click(screen.getByRole('button', { name: /点击选择/ }));
  fireEvent.change(screen.getByLabelText('输入面试岗位'), { target: { value: job } });
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateInterviewPage 面试间准备页（设计稿工作台）', () => {
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
    expect(screen.getByText('点击选择')).toBeTruthy();
    expect(screen.getByText('暂未上传文件')).toBeTruthy();
    expect(screen.getByText(/暂无岗位信息，请输入或导入/)).toBeTruthy();
    expect(screen.getByText(/暂无题目，请导入/)).toBeTruthy();
  });

  it('岗位：输入岗位名并确定后显示', () => {
    renderPage();
    chooseJobByInput('高级产品经理');
    expect(screen.getByText('高级产品经理')).toBeTruthy();
    expect(screen.queryByText('点击选择')).toBeNull();
  });

  it('岗位：点击常用岗位标签直接选中', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /点击选择/ }));
    fireEvent.click(screen.getByRole('button', { name: '产品经理' }));
    expect(screen.getByText('产品经理')).toBeTruthy();
  });

  it('岗位信息：打开导入弹窗显示拖拽上传区', () => {
    renderPage();
    openCardModal('岗位信息');
    expect(screen.getByRole('dialog', { name: /导入岗位信息/ })).toBeTruthy();
    expect(screen.getByText(/拖拽文件或图片到这里/)).toBeTruthy();
    expect(screen.getByText(/自动 OCR/)).toBeTruthy();
  });

  it('岗位信息：拖入图片后 OCR 文本填入编辑框', async () => {
    renderPage();
    openCardModal('岗位信息');
    const dropzone = screen.getByRole('button', { name: '上传岗位 JD' });
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect((screen.getByLabelText('岗位 JD') as HTMLTextAreaElement).value).toBe('识别出的 JD 文本');
    });
    expect(recognizeImage).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/图片识别失败|未识别到文字/)).toBeNull();
  });

  it('岗位信息：超过 10MB 的文件被拒绝且不调用 OCR', async () => {
    renderPage();
    openCardModal('岗位信息');
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

  it('简历：自己上传成功后关闭弹窗，卡片显示文件名', async () => {
    renderPage();
    // 简历卡「导入」→ 来源选择 → 自己上传
    openCardModal('个人简历');
    expect(screen.getByRole('dialog', { name: '导入简历' })).toBeTruthy();
    expect(screen.getByText(/自己上传/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /自己上传/ }));
    expect(screen.getByRole('dialog', { name: '导入简历' })).toBeTruthy();
    expect(screen.getByText('拖拽简历到这里，或点击选择文件')).toBeTruthy();

    // 拖入合法文件（.txt）→ 解析成功自动关闭弹窗
    const file = new File(['简历内容'], 'resume.txt', { type: 'text/plain' });
    const dropzone = screen.getByRole('button', { name: '上传简历' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导入简历' })).toBeNull();
    });
    // 卡片显示文件名
    expect(screen.getByText('resume.txt')).toBeTruthy();
  });

  it('选择题库：打开弹窗可勾选题目，完成后卡片显示计数', async () => {
    renderPage();
    openCardModal('选择题库');
    expect(screen.getByRole('dialog', { name: '选择题库' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('请介绍一个你主导的项目')).toBeTruthy();
    });
    const bankItem = screen.getByText('请介绍一个你主导的项目').closest('.bank-pick-item');
    fireEvent.click(bankItem!);
    expect(bankItem?.className).toContain('is-selected');
    // 完成 → 卡片显示已选计数与推荐范围
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText(/共 1 题 · 建议 5~8 题/)).toBeTruthy();
  });

  it('未选择岗位时开始面试被拦截并提示', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /开始模拟面试/ }));
    expect(screen.getByText('请选择面试岗位')).toBeTruthy();
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
    openCardModal('选择题库');
    await waitFor(() => expect(screen.getByText('题目 1')).toBeTruthy());
    // 勾选前 10 题
    for (let i = 1; i <= 10; i++) {
      fireEvent.click(screen.getByText(`题目 ${i}`).closest('.bank-pick-item')!);
    }
    // 第 11 题被阻止并提示
    fireEvent.click(screen.getByText('题目 11').closest('.bank-pick-item')!);
    expect(screen.getByText(/最多选择 10 题/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText(/共 10 题/)).toBeTruthy();
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
    openCardModal('选择题库');
    await waitFor(() => expect(screen.getByText('电商项目A')).toBeTruthy());
    fireEvent.click(screen.getByText('电商项目A').closest('.bank-pick-item')!);
    fireEvent.click(screen.getByText('电商项目B').closest('.bank-pick-item')!);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByText(/所选题目都来自同一项目/)).toBeTruthy();
  });
});
