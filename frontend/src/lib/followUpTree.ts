import type { InterviewTurn } from '../api/interviews';

export type FollowUpNodeType = 'main' | 'follow' | 'answer';

export interface FollowUpNode {
  type: FollowUpNodeType;
  seq: number;
  content: string;
  createdAt: string;
  children: FollowUpNode[];
}

const INTERVIEWER = 'interviewer';
const CANDIDATE = 'candidate';

/**
 * 把一场面试的平铺 turns（含 kind 标记）构建为「主问题 → 追问 → 回答」的
 * 两级树。规则：
 *   - interviewer + question   → main 节点（根）
 *   - interviewer + follow_up  → follow 节点（挂到当前 main 下）
 *   - candidate   + answer     → answer 节点（挂到最近一次提问之下）
 * 异常容错：追问/回答出现在任何主问题之前时挂到根，保证不丢内容。
 */
export function buildFollowUpTree(turns: InterviewTurn[]): FollowUpNode[] {
  const sorted = [...turns].sort((a, b) => a.seq - b.seq);
  const roots: FollowUpNode[] = [];
  let currentMain: FollowUpNode | null = null;
  let lastQuestion: FollowUpNode | null = null;

  for (const t of sorted) {
    if (t.role === INTERVIEWER && t.kind === 'question') {
      const node = makeNode('main', t);
      roots.push(node);
      currentMain = node;
      lastQuestion = node;
    } else if (t.role === INTERVIEWER && t.kind === 'follow_up') {
      const node = makeNode('follow', t);
      if (currentMain) {
        currentMain.children.push(node);
      } else {
        roots.push(node);
      }
      lastQuestion = node;
    } else if (t.role === CANDIDATE && t.kind === 'answer') {
      const node = makeNode('answer', t);
      const target = lastQuestion ?? roots[roots.length - 1] ?? null;
      if (target) {
        target.children.push(node);
      } else {
        roots.push(node);
      }
    }
    // 其他类型（系统消息等）忽略
  }
  return roots;
}

function makeNode(type: FollowUpNodeType, t: InterviewTurn): FollowUpNode {
  return {
    type,
    seq: t.seq,
    content: t.content,
    createdAt: t.created_at,
    children: [],
  };
}
