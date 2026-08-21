export type EntryStatus = 'completed' | 'in_progress' | 'other';

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
  return [{ label: '面试详情', to: '' }];
}
