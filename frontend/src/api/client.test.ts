import { describe, expect, it } from 'vitest';

// client.ts 顶层引用 window.location / localStorage / import.meta.env；

import { toUserMessage } from './client';

describe('toUserMessage', () => {
  it('maps known backend error strings to Chinese', () => {
    expect(toUserMessage(502, 'question generation failed')).toBe(
      '题目生成失败，请检查服务器 AI 配置后重试',
    );
    expect(toUserMessage(404, 'not found')).toBe('未找到相关内容');
    expect(toUserMessage(409, 'report not available')).toBe('报告尚未生成');
    expect(toUserMessage(503, 'speech service unavailable')).toBe('语音服务暂不可用');
    expect(toUserMessage(400, 'invalid email')).toBe('邮箱格式不正确');
  });

  it('normalizes whitespace and case before mapping', () => {
    expect(toUserMessage(400, '  Question Generation Failed ')).toBe(
      '题目生成失败，请检查服务器 AI 配置后重试',
    );
  });

  it('falls back to status-based Chinese messages', () => {
    expect(toUserMessage(401, 'anything')).toBe('登录已过期，请重新登录');
    expect(toUserMessage(403, 'anything')).toBe('没有权限执行此操作');
    expect(toUserMessage(429, 'anything')).toBe('操作过于频繁，请稍后再试');
    expect(toUserMessage(500, 'anything')).toBe('服务器开小差了，请稍后重试');
    expect(toUserMessage(503, 'anything')).toBe('服务器开小差了，请稍后重试');
    expect(toUserMessage(0, '')).toBe('网络异常或请求超时，请检查连接后重试');
  });

  it('keeps the original message when nothing matches', () => {
    expect(toUserMessage(422, 'weird custom error')).toBe('weird custom error');
  });
});
