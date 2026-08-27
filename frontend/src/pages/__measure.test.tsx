import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateInterviewPage from './CreateInterviewPage';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('../api/ocr', () => ({ recognizeImage: vi.fn(async () => ({ text: 'x' })) }));
vi.mock('../lib/resumeParse', () => ({ extractResumeText: vi.fn(async () => '') }));
vi.mock('../api/resumes', () => ({ listResumes: vi.fn(async () => []) }));
vi.mock('../api/questions', () => ({ listQuestions: vi.fn(async () => []) }));

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <CreateInterviewPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('measure computed styles vs Figma', () => {
  it('dump styles', () => {
    const { container } = renderPage();
    const selectors: Record<string, string[]> = {
      '品牌 slogan': ['.prep-new-slogan'],
      '品牌 sub': ['.prep-new-slogan-sub'],
      '面板标题': ['.prep-new-title'],
      '副标题': ['.prep-new-subtitle'],
      '卡片标题': ['.prep-new-card-title'],
      '岗位占位条': ['.prep-new-job-field'],
      '岗位文本': ['.prep-new-job-text'],
      '简历卡': ['.prep-new-card--resume'],
      '上传按钮': ['.prep-new-btn--upload'],
      '岗位信息卡': ['.prep-new-card--jd'],
      'JD 区': ['.prep-new-jd-area'],
      'JD 空文本': ['.prep-new-jd-empty'],
      '选择按钮': ['.prep-new-btn--select'],
      '保存按钮': ['.prep-new-btn--save'],
      '题库卡': ['.prep-new-card--bank'],
      '题库区': ['.prep-new-bank-area'],
      '导入按钮': ['.prep-new-card--bank .prep-new-btn--import'],
      '开始按钮': ['.prep-new-start'],
      '通用按钮': ['.prep-new-btn'],
      '侧边栏': ['.app-sidebar'],
      '侧边品牌': ['.app-sidebar-brand'],
      '侧边导航项': ['.app-sidebar-item'],
      '侧边用户名': ['.app-sidebar-username'],
      '侧边useid': ['.app-sidebar-useid'],
      '退出': ['.app-sidebar-logout'],
      '面板容器': ['.prep-new-panel'],
    };
    const out: string[] = [];
    for (const [label, sels] of Object.entries(selectors)) {
      const el = container.querySelector(sels[0]) as HTMLElement | null;
      if (!el) {
        out.push(`${label}: NOT FOUND`);
        continue;
      }
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      out.push(
        `${label} | css: font=${cs.fontSize} w=${cs.width} | rect: w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)}`,
      );
    }
    console.log('\n=====MEASURE=====\n' + out.join('\n') + '\n=====END=====');
    expect(true).toBe(true);
  });
});
