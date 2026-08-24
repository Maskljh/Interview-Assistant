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

vi.mock('../api/profile', () => ({
  fetchProfile: vi.fn(async () => ({ weak_dimensions: [], based_on_sessions: 0 })),
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateInterviewPage JD image OCR', () => {
  it('shows JD image upload option', async () => {
    renderPage();
    expect(screen.getByText('或上传 JD 图片')).toBeTruthy();
    // await the async fetchProfile resolution so its state update is wrapped in act
    await waitFor(() => {
      expect(screen.getByText('暂无历史画像，将按通用方式出题')).toBeTruthy();
    });
  });

  it('fills JD textarea with OCR text after selecting image', async () => {
    renderPage();
    const fileInput = screen.getByLabelText('或上传 JD 图片') as HTMLInputElement;
    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect((screen.getByLabelText('职位描述') as HTMLTextAreaElement).value).toBe('识别出的 JD 文本');
    });
    expect(recognizeImage).toHaveBeenCalledWith(file);
  });
});
