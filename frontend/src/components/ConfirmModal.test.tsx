import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  it('open=false 时不渲染', () => {
    const { container } = render(
      <ConfirmModal
        open={false}
        title="t"
        description="d"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('open=true 渲染标题、说明与按钮', () => {
    render(
      <ConfirmModal
        open
        title="删除题目"
        description="确定删除吗？"
        confirmLabel="删除"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('删除题目')).toBeTruthy();
    expect(screen.getByText('确定删除吗？')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('点击确认触发 onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        open
        title="t"
        description="d"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // 重写后默认危险态确认键文案为设计稿的「确认删除」
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('点击取消触发 onCancel', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        open
        title="t"
        description="d"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('loading 时按钮禁用并显示处理中', () => {
    render(
      <ConfirmModal
        open
        title="t"
        description="d"
        loading
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const confirm = screen.getByRole('button', { name: '处理中…' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
