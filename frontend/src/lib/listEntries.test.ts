import { describe, expect, it } from 'vitest';
import { entryLinksFor } from './listEntries';

describe('entryLinksFor', () => {
  it('completed 显示看报告与面试详情', () => {
    expect(entryLinksFor('completed')).toEqual([
      { label: '看报告', to: 'report' },
      { label: '面试详情', to: '' },
    ]);
  });

  it('in_progress 显示进入面试与面试详情', () => {
    expect(entryLinksFor('in_progress')).toEqual([
      { label: '进入面试', to: 'room' },
      { label: '面试详情', to: '' },
    ]);
  });

  it('other 仅显示面试详情', () => {
    expect(entryLinksFor('other')).toEqual([{ label: '面试详情', to: '' }]);
  });
});
