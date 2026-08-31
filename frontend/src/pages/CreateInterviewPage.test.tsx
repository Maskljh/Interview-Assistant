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

  it('岗位信息：打开导入弹窗显示岗位信息列表', () => {
    renderPage();
    openCardModal('岗位信息');
    expect(screen.getByRole('dialog', { name: '导入岗位信息' })).toBeTruthy();
    expect(screen.getByText('从已有的岗位信息里选择或新建导入岗位信息')).toBeTruthy();
    expect(screen.getByText('项目管理专员/主管')).toBeTruthy();
    expect(screen.getByRole('button', { name: '上传岗位信息图片' })).toBeTruthy();
  });

  it('岗位信息：选择已有岗位信息后填入编辑框并关闭弹窗', () => {
    renderPage();
    openCardModal('岗位信息');
    fireEvent.click(screen.getByText('项目管理专员/主管'));
    expect(screen.queryByRole('dialog', { name: '导入岗位信息' })).toBeNull();
    const editor = screen.getByLabelText('岗位信息') as HTMLTextAreaElement;
    expect(editor.value).toContain('岗位名称：项目管理专员/主管');
    expect(editor.value).toContain('负责公司各类项目全流程管理');
  });

  it('岗位信息：上传图片后 OCR 文本填入编辑框', async () => {
    renderPage();
    openCardModal('岗位信息');
    const input = document.getElementById('job-info-file-input') as HTMLInputElement;
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect((screen.getByLabelText('岗位信息') as HTMLTextAreaElement).value).toBe('识别出的 JD 文本');
    });
    expect(recognizeImage).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/图片识别失败|未识别到文字/)).toBeNull();
  });

  it('岗位信息：超过 10MB 的图片被拒绝且不调用 OCR', async () => {
    renderPage();
    openCardModal('岗位信息');
    const input = document.getElementById('job-info-file-input') as HTMLInputElement;
    const bigFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'big.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [bigFile] } });
    await waitFor(() => {
      expect(screen.getByText('文件不能超过 10MB')).toBeTruthy();
    });
    expect(recognizeImage).not.toHaveBeenCalled();
  });

  it('简历：本地上传成功后关闭弹窗，卡片显示文件名', async () => {
    renderPage();
    // 简历卡「导入」→ 选择简历（空态）→ 上传简历 → 本地上传
    openCardModal('个人简历');
    expect(screen.getByRole('dialog', { name: '选择简历' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('还没有添加简历')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '上传简历' }));
    expect(screen.getByRole('dialog', { name: '上传简历' })).toBeTruthy();
    expect(screen.getByText('本地上传')).toBeTruthy();
    expect(screen.getByText('WPS 云文档上传')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /本地上传/ }));

    // 对话框关闭后，隐藏 input 触发解析（jsdom 中直接派发 change）
    const file = new File(['简历内容'], 'resume.txt', { type: 'text/plain' });
    const input = document.getElementById('resume-file-input') as HTMLInputElement;
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText('resume.txt')).toBeTruthy();
    });
  });

  it('选择题库：打开弹窗按题库整组选择，卡片显示计数', async () => {
    renderPage();
    openCardModal('选择题库');
    expect(screen.getByRole('dialog', { name: '从题库管理选择' })).toBeTruthy();
    expect(screen.getByText('从已有的题库里选择或新建导入题库')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('2 道题目')).toBeTruthy();
    });
    // 选择题库（未命名题库：mock 题目无 job_tag）
    fireEvent.click(screen.getByText('未命名题库'));
    // 弹窗关闭，卡片显示已选计数与题目列表
    expect(screen.queryByRole('dialog', { name: '从题库管理选择' })).toBeNull();
    expect(screen.getByText('共 2 题')).toBeTruthy();
    expect(screen.getByText('请介绍一个你主导的项目')).toBeTruthy();
    expect(screen.getByText('如何处理需求冲突？')).toBeTruthy();
  });

  it('选择题库：空题库时显示新建题库空态', async () => {
    vi.mocked(listQuestions).mockResolvedValueOnce([]);
    renderPage();
    openCardModal('选择题库');
    await waitFor(() => {
      expect(screen.getByText('还没有上传题库')).toBeTruthy();
    });
    expect(screen.getByText('新建题库后可用于开始模拟面试')).toBeTruthy();
    // 仅头部右上角保留「新建题库」按钮（空态底部按钮已按需求移除）
    expect(screen.getAllByRole('button', { name: '新建题库' }).length).toBe(1);
  });

  it('未选择岗位时开始面试被拦截并提示', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /开始模拟面试/ }));
    expect(screen.getByText('请选择面试岗位')).toBeTruthy();
  });
});
