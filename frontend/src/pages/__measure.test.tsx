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

describe('measure computed styles vs Figma (v2.0 prep 对话引导式)', () => {
  it('dump styles', () => {
    const { container } = renderPage();
    const selectors: Record<string, string[]> = {
      '顶栏': ['.topbar'],
      '顶栏品牌': ['.topbar>b'],
      '顶栏导航项': ['.topbar nav button'],
      '顶栏用户': ['.topbar-profile'],
      '对话容器': ['.prep-chat'],
      '对话标题': ['.room-case-head'],
      '对话区': ['.prep-dialogue'],
      '问询人气泡': ['.prep-turn:not(.prep-turn-user) .prep-bubble'],
      '问询头像': ['.prep-avatar'],
      '岗位选择条': ['.prep-choice'],
      '岗位标签': ['.prep-choice b'],
      '岗位占位': ['.prep-choice span'],
      '资料板': ['.prep-right'],
      '资料标题': ['.prep-materials-title'],
      '归档卡片': ['.prep-note'],
      '开始按钮': ['.prep-note-start'],
      '重置按钮': ['.prep-reset'],
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
