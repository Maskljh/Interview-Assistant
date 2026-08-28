export type EntryStatus = 'completed' | 'in_progress' | 'ready' | 'draft' | 'other';

export interface EntryLink {
  label: string;
  to: string;
}

export function entryLinksFor(status: EntryStatus): EntryLink[] {
  if (status === 'completed') {
    return [
      { label: '看报告', to: 'report' },
      { label: '面试详情', to: '' },
    ];
  }
  if (status === 'in_progress') {
    return [
      { label: '进入面试', to: 'room' },
      { label: '面试详情', to: '' },
    ];
  }
  if (status === 'ready') {
    // 题目已生成，可直接进面试室
    return [
      { label: '开始面试', to: 'room' },
      { label: '面试详情', to: '' },
    ];
  }
  // draft：题目未生成，不能直接进面试室，"开始面试"作为按钮在列表项单独渲染
  if (status === 'draft') {
    return [{ label: '面试详情', to: '' }];
  }
  return [{ label: '面试详情', to: '' }];
}
