import { describe, expect, it } from 'vitest';
import { detailSourceFrom, isFromQuestions, isFromTrends } from './detailSource';

describe('detailSourceFrom', () => {
  it('from=questions 判定为 questions', () => {
    expect(detailSourceFrom('questions')).toBe('questions');
  });

  it('from 缺失或其他值判定为 list', () => {
    expect(detailSourceFrom(null)).toBe('list');
    expect(detailSourceFrom('report')).toBe('list');
    expect(detailSourceFrom('')).toBe('list');
  });

  it('from=trends 判定为 trends', () => {
    expect(detailSourceFrom('trends')).toBe('trends');
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

describe('isFromTrends', () => {
  it('from=trends 返回 true', () => {
    expect(isFromTrends('trends')).toBe(true);
  });

  it('其他值返回 false', () => {
    expect(isFromTrends(null)).toBe(false);
    expect(isFromTrends('')).toBe(false);
    expect(isFromTrends('questions')).toBe(false);
    expect(isFromTrends('list')).toBe(false);
  });
});
