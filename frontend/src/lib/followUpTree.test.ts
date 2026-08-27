import { describe, expect, it } from 'vitest';
import type { InterviewTurn } from '../api/interviews';
import { buildFollowUpTree } from './followUpTree';

function turn(
  id: number,
  seq: number,
  role: string,
  kind: string,
  content: string,
): InterviewTurn {
  return {
    id,
    seq,
    role,
    kind,
    content,
    created_at: '2026-08-26T10:00:00Z',
  };
}

describe('buildFollowUpTree', () => {
  it('空输入返回空树', () => {
    expect(buildFollowUpTree([])).toEqual([]);
  });

  it('主问题 → 回答 → 追问 → 回答 → 下一主问题 构建两级树', () => {
    const tree = buildFollowUpTree([
      turn(1, 1, 'interviewer', 'question', 'Q1'),
      turn(2, 2, 'candidate', 'answer', 'A1'),
      turn(3, 3, 'interviewer', 'follow_up', 'F1'),
      turn(4, 4, 'candidate', 'answer', 'A2'),
      turn(5, 5, 'interviewer', 'question', 'Q2'),
      turn(6, 6, 'candidate', 'answer', 'A3'),
    ]);

    expect(tree).toHaveLength(2);
    expect(tree[0].type).toBe('main');
    expect(tree[0].content).toBe('Q1');
    // Q1 下：A1(回答) + F1(追问) + F1 下的 A2
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].type).toBe('answer');
    expect(tree[0].children[0].content).toBe('A1');
    expect(tree[0].children[1].type).toBe('follow');
    expect(tree[0].children[1].content).toBe('F1');
    expect(tree[0].children[1].children).toHaveLength(1);
    expect(tree[0].children[1].children[0].type).toBe('answer');
    expect(tree[0].children[1].children[0].content).toBe('A2');

    expect(tree[1].type).toBe('main');
    expect(tree[1].content).toBe('Q2');
    expect(tree[1].children).toHaveLength(1);
    expect(tree[1].children[0].content).toBe('A3');
  });

  it('无追问时退化为 主问题→回答 列表', () => {
    const tree = buildFollowUpTree([
      turn(1, 1, 'interviewer', 'question', 'Q1'),
      turn(2, 2, 'candidate', 'answer', 'A1'),
      turn(3, 3, 'interviewer', 'question', 'Q2'),
      turn(4, 4, 'candidate', 'answer', 'A2'),
    ]);

    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].type).toBe('answer');
    expect(tree[1].children).toHaveLength(1);
  });

  it('连续追问挂在同一主问题下', () => {
    const tree = buildFollowUpTree([
      turn(1, 1, 'interviewer', 'question', 'Q1'),
      turn(2, 2, 'candidate', 'answer', 'A1'),
      turn(3, 3, 'interviewer', 'follow_up', 'F1'),
      turn(4, 4, 'candidate', 'answer', 'A2'),
      turn(5, 5, 'interviewer', 'follow_up', 'F2'),
      turn(6, 6, 'candidate', 'answer', 'A3'),
    ]);

    expect(tree).toHaveLength(1);
    const q1 = tree[0];
    expect(q1.children).toHaveLength(3); // A1, F1, F2
    expect(q1.children[1].content).toBe('F1');
    expect(q1.children[2].content).toBe('F2');
    expect(q1.children[1].children[0].content).toBe('A2');
    expect(q1.children[2].children[0].content).toBe('A3');
  });

  it('乱序输入按 seq 排序后构建', () => {
    const tree = buildFollowUpTree([
      turn(2, 2, 'candidate', 'answer', 'A1'),
      turn(1, 1, 'interviewer', 'question', 'Q1'),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].content).toBe('Q1');
    expect(tree[0].children[0].content).toBe('A1');
  });

  it('追问出现在主问题之前时容错挂根', () => {
    const tree = buildFollowUpTree([
      turn(1, 1, 'interviewer', 'follow_up', '孤儿追问'),
      turn(2, 2, 'candidate', 'answer', '孤儿回答'),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('follow');
    expect(tree[0].content).toBe('孤儿追问');
    // 孤儿回答挂在最近的提问（孤儿追问）下
    expect(tree[0].children[0].type).toBe('answer');
    expect(tree[0].children[0].content).toBe('孤儿回答');
  });

  it('系统类 turn 被忽略', () => {
    const tree = buildFollowUpTree([
      turn(1, 1, 'system', 'status', 'session started'),
      turn(2, 2, 'interviewer', 'question', 'Q1'),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].content).toBe('Q1');
  });
});
