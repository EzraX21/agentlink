import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 对话框的可访问性外壳（模态语义 + 焦点管理）。
 *
 * 只靠 `div + fixed` 做弹窗，对键盘和读屏用户等于"点不到、听不见"：
 *   - Tab 会跑到背后的页面里去（焦点逃逸）
 *   - 打开时焦点不进去，Esc 也不一定关得掉
 *   - 关闭后焦点不回来，用户丢失位置
 *
 * 这个壳补齐四件事：
 *   1. `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
 *   2. 打开时把焦点移到面板（或第一个可聚焦元素）
 *   3. Tab / Shift+Tab 在面板内循环
 *   4. 关闭时把焦点还给打开前的元素
 *
 * 点击遮罩关闭的行为保留（鼠标用户习惯），但键盘用户可以完全不依赖它。
 */
export function Modal({
  title,
  onClose,
  children,
  labelledBy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 优先用页面里已有的标题元素做 label（避免重复文案）。 */
  labelledBy?: string;
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel !== null) {
      const first = panel.querySelector<HTMLElement>(
        'input, textarea, button, [href], select, [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel).focus();
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || panel === null) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: 'rgb(0 0 0 / 45%)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(labelledBy === undefined
          ? { 'aria-labelledby': titleId.current }
          : { 'aria-labelledby': labelledBy })}
        tabIndex={-1}
        className="al-card"
        data-modal-title={title}
      >
        {children}
      </div>
    </div>
  );
}