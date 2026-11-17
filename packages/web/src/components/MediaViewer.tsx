import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * 媒体预览弹窗（图片 / 视频共用）。
 *
 * 为什么单独做一个而不是复用 `Modal`：`Modal` 是"卡片式对话框"（白底、内边距、
 * 适合表单），而媒体预览要是**全屏暗色舞台**（图片/视频自己占据视野，周围只是遮罩）。
 * 但可访问性要求是同一套：`role="dialog"` + `aria-modal` + 焦点进入 + Esc 关闭 +
 * Tab 不逃逸 + 关闭后焦点归位。
 *
 * 额外支持：
 *   - ← → 在同一条消息的多张图/多个视频间切换
 *   - 顶部显示序号 `2/5`，右上角关闭按钮
 *   - 底部一行说明（文件名 / 大小），方便确认自己点开的是哪个文件
 */
export function MediaViewer({
  title,
  caption,
  position,
  onClose,
  onPrev,
  onNext,
  children,
}: {
  title: string;
  caption?: string | undefined;
  /** 多图/多视频时的 `n/m`。 */
  position?: { index: number; total: number } | null;
  onClose: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPrev?.();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNext?.();
        return;
      }
      if (e.key !== 'Tab' || panelRef.current === null) return;
      // 焦点留在弹窗内（媒体弹窗里可聚焦的只有关闭/上/下几个按钮）
      const f = [
        ...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href]'),
      ];
      const first = f[0];
      const last = f[f.length - 1];
      if (first === undefined || last === undefined) {
        e.preventDefault();
        return;
      }
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
  }, [onClose, onPrev, onNext]);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col"
      style={{ background: 'rgb(0 0 0 / 88%)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="flex items-center justify-between px-4 py-2 text-xs text-white">
          <span id={titleId} className="truncate">
            {title}
            {position !== null && position !== undefined && (
              <span style={{ opacity: 0.65 }}>
                {' '}
                {position.index}/{position.total}
              </span>
            )}
          </span>
          <button
            className="shrink-0 rounded-full px-2.5 py-1"
            style={{ background: 'rgb(255 255 255 / 18%)' }}
            onClick={onClose}
            aria-label="关闭预览（Esc）"
          >
            ✕
          </button>
        </div>

        <div
          className="relative grid min-h-0 flex-1 place-items-center px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {onPrev !== undefined && (
            <button
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full px-3 py-2 text-2xl text-white"
              style={{ background: 'rgb(255 255 255 / 16%)' }}
              onClick={onPrev}
              aria-label="上一个（←）"
            >
              ‹
            </button>
          )}
          {children}
          {onNext !== undefined && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-3 py-2 text-2xl text-white"
              style={{ background: 'rgb(255 255 255 / 16%)' }}
              onClick={onNext}
              aria-label="下一个（→）"
            >
              ›
            </button>
          )}
        </div>

        {caption !== undefined && caption !== '' && (
          <div className="px-4 py-2 text-center text-[11px] text-white" style={{ opacity: 0.7 }}>
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}