import { useEffect, useId, type ReactNode } from 'react';
import { Modal } from './Modal.js';

/**
 * 媒体预览弹窗（图片 / 视频共用）。
 *
 * **外观上与「群信息」等对话框保持一致**：同一个遮罩浓度、同一张卡片
 * （`al-card`：侧栏底色 + 边框 + 圆角）、同样位置的标题与 ✕。
 *
 * 之前这里写成了"全屏黑色影院舞台"，和应用里其他弹窗完全是两套语言 ——
 * 看起来像是从别的产品里嵌进来的。现在媒体只是卡片里的一块内容：
 * 媒体上方一行标题（文件名 + n/m），下方一行说明（大小），左右箭头浮在媒体两侧。
 *
 * 可访问性交给 `Modal` 外壳（role=dialog / aria-modal / 焦点进入与归还 / Tab 循环），
 * 这里只管 ←→ 切换与内容排布。
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
  const titleId = useId();

  // ← → 切换：Esc / 焦点陷阱 / 焦点归位由 Modal 外壳负责，这里只加左右键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPrev?.();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNext?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onPrev, onNext]);

  return (
    // labelledBy 指向下面那个标题元素：Modal 自己的 title 只放在 data 属性里，
    // 不传这个的话 aria-labelledby 会指向一个不存在的 id。
    <Modal title={title} onClose={onClose} labelledBy={titleId}>
      <div className="flex w-[min(88vw,960px)] flex-col">
        {/* 标题行：与群信息对话框同构（左标题、右关闭） */}
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div id={titleId} className="truncate text-sm font-semibold">
              {title}
            </div>
            {(position !== null && position !== undefined) || caption !== undefined ? (
              <div className="al-muted text-[11px]">
                {position !== null && position !== undefined && (
                  <span>
                    {position.index}/{position.total}
                  </span>
                )}
                {position !== null && position !== undefined && caption !== undefined ? ' · ' : ''}
                {caption}
              </div>
            ) : null}
          </div>
          <button
            className="al-muted shrink-0"
            onClick={onClose}
            title="关闭预览（Esc）"
            aria-label="关闭预览（Esc）"
          >
            ✕
          </button>
        </div>

        {/* 媒体区：卡片内部一块浅底，图片/视频居中 */}
        <div
          className="relative grid place-items-center overflow-hidden rounded-lg"
          style={{ background: 'var(--al-bg-hover)', minHeight: 120 }}
        >
          {onPrev !== undefined && (
            <button
              className="al-btn-ghost absolute left-2 top-1/2 -translate-y-1/2 !px-2.5 !py-1 text-lg"
              onClick={onPrev}
              aria-label="上一个（←）"
              title="上一个（←）"
            >
              ‹
            </button>
          )}

          <div className="flex max-h-[70vh] w-full items-center justify-center p-2">
            {children}
          </div>

          {onNext !== undefined && (
            <button
              className="al-btn-ghost absolute right-2 top-1/2 -translate-y-1/2 !px-2.5 !py-1 text-lg"
              onClick={onNext}
              aria-label="下一个（→）"
              title="下一个（→）"
            >
              ›
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}