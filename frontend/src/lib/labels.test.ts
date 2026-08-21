import { describe, expect, it } from 'vitest';
import { SOURCE_LABELS } from './labels';

describe('SOURCE_LABELS', () => {
  it('maps interview and import sources', () => {
    expect(SOURCE_LABELS.interview).toBe('面试');
    expect(SOURCE_LABELS.import).toBe('导入');
  });
});
