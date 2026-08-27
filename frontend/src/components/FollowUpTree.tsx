import { useState } from 'react';
import type { InterviewTurn } from '../api/interviews';
import { buildFollowUpTree, type FollowUpNode } from '../lib/followUpTree';
import { formatDateZh } from '../lib/labels';

interface FollowUpTreeProps {
  turns: InterviewTurn[];
}

/**
 * 把面试问答渲染为「主问题 → 追问 → 回答」的两级树形（默认展开）。
 * 主问题/追问节点支持折叠；回答节点始终展开跟随其提问节点。
 */
export default function FollowUpTree({ turns }: FollowUpTreeProps) {
  const tree = buildFollowUpTree(turns);
  if (tree.length === 0) {
    return null;
  }
  return (
    <div className="followup-tree">
      {tree.map((node) => (
        <Branch key={node.seq} node={node} depth={0} />
      ))}
    </div>
  );
}

function Branch({ node, depth }: { node: FollowUpNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const isQuestion = node.type === 'main' || node.type === 'follow';
  const roleLabel =
    node.type === 'main'
      ? '面试官 · 主问题'
      : node.type === 'follow'
        ? '面试官 · 追问'
        : '我的回答';
  const hasChildren = node.children.length > 0;

  return (
    <article
      className={`followup-branch followup-branch--${node.type}${
        !open && isQuestion ? ' is-collapsed' : ''
      }`}
      style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
    >
      <div className="followup-branch-header">
        <span className="followup-role">{roleLabel}</span>
        <time className="followup-time" dateTime={node.createdAt}>
          {formatDateZh(node.createdAt)}
        </time>
        {isQuestion && hasChildren && (
          <button
            type="button"
            className="followup-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? '收起' : `展开追问（${node.children.length}）`}
          </button>
        )}
      </div>
      <p className="followup-content">{node.content}</p>
      {isQuestion && hasChildren && open && (
        <div className="followup-children">
          {node.children.map((child) => (
            <Branch key={child.seq} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </article>
  );
}
