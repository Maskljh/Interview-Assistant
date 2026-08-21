import { describe, expect, it } from 'vitest';
import { detailSourceFrom, isFromQuestions } from './detailSource';

describe('detailSourceFrom', () => {
  it('from=questions 判定为 questions', () => {
    expect(detailSourceFrom('questions')).toBe('questions');
  });

  it('from 缺失或其他值判定为 list', () => {
    expect(detailSourceFrom(null)).toBe('list');
    expect(detailSourceFrom('report')).toBe('list');
    expect(detailSourceFrom('')).toBe('list');
  });
});

describe('isFromQuestions', () => {
  it('from=questions 返回 true', () => {
    expect(isFromQuestions('questions')).toBe(true);
  });

  it('其他值返回 false', () => {
    expect(isFromQuestions(null)).toBe(false);
    expect(isFromQuestions('')).toBe(false);
    expect(isFromQuestions('list')).toBe(false);
  });
});
