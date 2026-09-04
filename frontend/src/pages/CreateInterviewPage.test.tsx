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
// 岗位库 API mock：列表返回一条已保存岗位；手动录入创建后返回带真实 id 的记录
vi.mock('../api/jobinfo', () => ({
  listJobInfo: vi.fn(async () => [
    {
      id: 1,
      name: '项目管理专员/主管',
      content: '负责公司各类项目全流程管理',
      created_at: '2026-08-27 10:00',
    },
  ]),
  createJobInfo: vi.fn(async (name: string, content: string) => ({
    id: 99,
    name,
    content,
    created_at: '2026-09-04 10:00',
  })),
  updateJobInfo: vi.fn(async () => undefined),
  deleteJobInfo: vi.fn(async () => undefined),
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

/** 打开「选择面试岗位」弹窗并输入岗位名确定（对话流第一轮）。 */
function chooseJobByInput(job: string) {
  fireEvent.click(screen.getByRole('button', { name: /面试岗位/ }));
  fireEvent.change(screen.getByLabelText('输入面试岗位'), { target: { value: job } });
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
}

/** 走完对话流前两步：选岗位 → 选择「需要上传」。 */
function proceedToUpload(job = '高级产品经理') {
  chooseJobByInput(job);
  fireEvent.click(screen.getByRole('button', { name: '需要上传' }));
}

/** 资料板内的「开始面试」按钮（避开顶栏同名导航按钮）。 */
function getStartButton() {
  const prepRight = document.querySelector('.prep-right') as HTMLElement;
  return within(prepRight).getByRole('button', { name: /开始面试/ });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateInterviewPage 开始面试页（v2.0 对话引导式）', () => {
  it('渲染顶栏、问询对话、资料板与开始按钮', () => {
    renderPage();
    // 顶栏品牌与导航
    expect(screen.getAllByText('面知').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '开始面试' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '面试信息管理' })).toBeTruthy();
    // 对话区标题
    expect(screen.getByText('PRE-INTERVIEW')).toBeTruthy();
    expect(screen.getByText('面试材料准备')).toBeTruthy();
    // 第一轮问询：请选择岗位
    expect(screen.getByText('请选择本次面试岗位')).toBeTruthy();
    expect(screen.getByRole('button', { name: /面试岗位/ })).toBeTruthy();
    // 右侧资料板
    expect(screen.getByText('INTERVIEW MATERIALS')).toBeTruthy();
    expect(screen.getByText(/文件板等待资料归档/)).toBeTruthy();
    expect(getStartButton()).toBeTruthy();
  });

  it('初始展示岗位占位与资料板空态', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /选择本次面试岗位/ })).toBeTruthy();
    expect(screen.getByText(/文件板等待资料归档/)).toBeTruthy();
  });

  it('岗位：输入岗位名并确定后显示用户回复与第二轮', () => {
    renderPage();
    chooseJobByInput('高级产品经理');
    // 岗位弹窗关闭
    expect(screen.queryByRole('dialog', { name: '选择面试岗位' })).toBeNull();
    // 用户回复 + 第二轮问询（是否需要上传）
    expect(screen.getByText('本次面试岗位为“高级产品经理”')).toBeTruthy();
    expect(screen.getByText(/是否需要上传个人简历、面试岗位信息或面试题集/)).toBeTruthy();
    // 岗位选择框回显
    expect(screen.getByRole('button', { name: /高级产品经理/ })).toBeTruthy();
  });

  it('岗位：点击常用岗位标签直接选中', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /面试岗位/ }));
    fireEvent.click(screen.getByRole('button', { name: '产品经理' }));
    expect(screen.queryByRole('dialog', { name: '选择面试岗位' })).toBeNull();
    expect(screen.getByText('本次面试岗位为“产品经理”')).toBeTruthy();
  });

  it('岗位信息：打开导入弹窗默认显示手动录入表单与双 tab', () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
    expect(screen.getByRole('dialog', { name: '导入岗位信息' })).toBeTruthy();
    expect(screen.getByText('录入岗位情报，或从系统保存的岗位中选择')).toBeTruthy();
    expect(screen.getByRole('button', { name: '上传图片识别' })).toBeTruthy();
    // 双 tab：手动录入（默认选中）/ 已保存岗位
    expect(screen.getByRole('button', { name: '手动录入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '已保存岗位' })).toBeTruthy();
    // 手动录入表单（岗位名称 + 岗位内容 + 确认录入）
    expect(screen.getByLabelText('岗位名称')).toBeTruthy();
    expect(screen.getByLabelText('岗位内容')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认录入' })).toBeTruthy();
  });

  it('岗位信息：手动录入岗位名称与内容后归档到资料板并关闭弹窗', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
    fireEvent.change(screen.getByLabelText('岗位名称'), {
      target: { value: '测试工程师' },
    });
    fireEvent.change(screen.getByLabelText('岗位内容'), {
      target: { value: '负责测试用例设计与执行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认录入' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导入岗位信息' })).toBeNull();
    });
    // 资料板归档显示岗位信息名称与内容（导入选项回显 + 资料板归档两处）
    expect(screen.getAllByText('测试工程师').length).toBeGreaterThan(0);
    expect(screen.getByText(/负责测试用例设计与执行/)).toBeTruthy();
  });

  it('岗位信息：手动录入缺岗位名称或内容时不归档', () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认录入' }));
    // 空表单不关闭弹窗
    expect(screen.getByRole('dialog', { name: '导入岗位信息' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('岗位内容'), {
      target: { value: '只有内容没有名称' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认录入' }));
    expect(screen.getByRole('dialog', { name: '导入岗位信息' })).toBeTruthy();
  });

  it('岗位信息：切到已保存岗位 tab 选择已有岗位后归档并关闭弹窗', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
    fireEvent.click(screen.getByRole('button', { name: '已保存岗位' }));
    // 已保存岗位列表从岗位库异步加载
    await waitFor(() => {
      expect(screen.getByText('项目管理专员/主管')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('项目管理专员/主管'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '导入岗位信息' })).toBeNull();
    });
    // 资料板归档显示岗位信息名称与内容（导入选项回显 + 资料板归档两处）
    expect(screen.getAllByText('项目管理专员/主管').length).toBeGreaterThan(0);
    expect(screen.getByText(/负责公司各类项目全流程管理/)).toBeTruthy();
  });

  it('岗位信息：上传图片后 OCR 文本归档到资料板', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
    const input = document.getElementById('job-info-file-input') as HTMLInputElement;
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText('识别出的 JD 文本')).toBeTruthy();
    });
    expect(recognizeImage).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/图片识别失败|未识别到文字/)).toBeNull();
  });

  it('岗位信息：超过 10MB 的图片被拒绝且不调用 OCR', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /岗位信息/ }));
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

  it('简历：本地上传成功后关闭弹窗，资料板显示文件名', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /个人简历/ }));
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
      // 导入选项回显 + 资料板归档两处
      expect(screen.getAllByText('resume.txt').length).toBeGreaterThan(0);
    });
  });

  it('选择题库：走完对话流后整组选择，资料板显示题目列表', async () => {
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /面试题集/ }));
    expect(screen.getByRole('dialog', { name: '从题库管理选择' })).toBeTruthy();
    expect(screen.getByText('从已有的题库里选择或新建导入题库')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('2 道题目')).toBeTruthy();
    });
    // 选择题库（未命名题库：mock 题目无 job_tag）
    fireEvent.click(screen.getByText('未命名题库'));
    // 弹窗关闭，资料板归档题目列表
    expect(screen.queryByRole('dialog', { name: '从题库管理选择' })).toBeNull();
    expect(screen.getByText('请介绍一个你主导的项目')).toBeTruthy();
    expect(screen.getByText('如何处理需求冲突？')).toBeTruthy();
  });

  it('选择题库：空题库时显示新建题库空态', async () => {
    vi.mocked(listQuestions).mockResolvedValueOnce([]);
    renderPage();
    proceedToUpload();
    fireEvent.click(screen.getByRole('button', { name: /面试题集/ }));
    await waitFor(() => {
      expect(screen.getByText('还没有上传题库')).toBeTruthy();
    });
    expect(screen.getByText('新建题库后可用于开始模拟面试')).toBeTruthy();
    // 仅头部右上角保留「新建题库」按钮（空态底部按钮已按需求移除）
    expect(screen.getAllByRole('button', { name: '新建题库' }).length).toBe(1);
  });

  it('未选择岗位时开始面试被拦截并提示', () => {
    renderPage();
    fireEvent.click(getStartButton());
    expect(screen.getByText('请先在左侧选择面试岗位')).toBeTruthy();
  });

  it('重置对话：清除岗位与全部归档回到初始状态', () => {
    renderPage();
    chooseJobByInput('高级产品经理');
    fireEvent.click(screen.getByRole('button', { name: '需要上传' }));
    fireEvent.click(screen.getByRole('button', { name: /个人简历/ }));
    awaitDialogClose();
    fireEvent.click(screen.getByRole('button', { name: /重置对话/ }));
    // 回到初始：无用户回复、无上传选项、资料板空态
    expect(screen.queryByText(/本次面试岗位为/)).toBeNull();
    expect(screen.queryByRole('button', { name: '需要上传' })).toBeNull();
    expect(screen.getByText(/文件板等待资料归档/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /选择本次面试岗位/ })).toBeTruthy();
  });
});

/** 等待当前所有对话框关闭（简历选择弹窗上传流程共用）。 */
async function awaitDialogClose() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
}
