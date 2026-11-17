import { useEffect, useState } from 'react';
import {
  acquireAttachmentUrl,
  formatBytes,
  releaseAttachmentUrl,
} from '../lib/attachments.js';

/**
 * 图片块：带鉴权取字节 → blob URL → <img>（原因见 lib/attachments.ts 顶部注释）。
 * 点击放大（简单灯箱）。
 */
export function ImageBlockView({
  attachmentId,
  filename,
  width,
  height,
  zoomed = false,
  onZoom,
  onCloseZoom,
  onPrev,
  onNext,
  position,
}: {
  attachmentId: string;
  filename?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** 灯箱是否打开（由父组件控制，这样才能在同一消息的多张图之间翻页）。 */
  zoomed?: boolean;
  onZoom?: () => void;
  onCloseZoom?: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  /** 多图时显示 "2/3"。 */
  position?: { index: number; total: number } | null;
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    acquireAttachmentUrl(attachmentId, filename ?? 'image')
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      releaseAttachmentUrl(attachmentId);
    };
  }, [attachmentId, filename]);

  if (error !== null) {
    return (
      <div className="al-muted text-[11px]">
        [图片加载失败：{error}]
      </div>
    );
  }
  if (url === null) {
    // 占位，避免加载完成时气泡跳变
    return (
      <div
        className="grid place-items-center text-[11px]"
        style={{
          width: width ?? 220,
          height: height ?? 140,
          background: 'var(--al-bg-hover)',
          borderRadius: 8,
          color: 'var(--al-text-muted)',
        }}
      >
        图片加载中…
      </div>
    );
  }

  return (
    <>
      <img
        src={url}
        alt={filename ?? '图片'}
        onClick={() => onZoom?.()}
        style={{
          display: 'block',
          maxWidth: 'min(420px, 100%)',
          maxHeight: 320,
          borderRadius: 8,
          cursor: 'zoom-in',
        }}
      />
      {zoomed && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center"
          style={{ background: 'rgb(0 0 0 / 82%)' }}
          onClick={() => onCloseZoom?.()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') onPrev?.();
            if (e.key === 'ArrowRight') onNext?.();
            if (e.key === 'Escape') onCloseZoom?.();
          }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <img
            src={url}
            alt={filename ?? '图片'}
            style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8 }}
            onClick={(e) => e.stopPropagation()}
          />

          {position !== null && position !== undefined && (
            <div
              className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs text-white"
              style={{ background: 'rgb(0 0 0 / 60%)' }}
            >
              {position.index}/{position.total}
            </div>
          )}

          {onPrev !== undefined && (
            <button
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full px-3 py-2 text-lg text-white"
              style={{ background: 'rgb(0 0 0 / 55%)' }}
              title="上一张（←）"
              onClick={(e) => {
                e.stopPropagation();
                onPrev();
              }}
            >
              ‹
            </button>
          )}
          {onNext !== undefined && (
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full px-3 py-2 text-lg text-white"
              style={{ background: 'rgb(0 0 0 / 55%)' }}
              title="下一张（→）"
              onClick={(e) => {
                e.stopPropagation();
                onNext();
              }}
            >
              ›
            </button>
          )}
          <button
            className="absolute top-4 right-4 rounded-full px-2.5 py-1 text-white"
            style={{ background: 'rgb(0 0 0 / 55%)' }}
            title="关闭（Esc）"
            onClick={(e) => {
              e.stopPropagation();
              onCloseZoom?.();
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/** 文件块：名称 + 大小 + 下载（同样走带鉴权的 fetch）。 */
export function FileBlockView({
  attachmentId,
  filename,
  size,
}: {
  attachmentId: string;
  filename?: string | undefined;
  size?: number | undefined;
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    acquireAttachmentUrl(attachmentId, filename ?? 'file')
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      releaseAttachmentUrl(attachmentId);
    };
  }, [attachmentId, filename]);

  const name = filename ?? '文件';

  return (
    <div
      className="flex items-center gap-2"
      style={{
        background: 'var(--al-bg-hover)',
        borderRadius: 8,
        padding: '6px 8px',
        minWidth: 200,
      }}
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px]"
        style={{ background: 'var(--al-primary)', color: '#fff' }}
        aria-hidden
      >
        ⤓
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{name}</div>
        <div className="al-muted text-[11px]">
          {size !== undefined ? formatBytes(size) : error !== null ? error : '文件'}
        </div>
      </div>
      {url !== null ? (
        <a
          className="al-btn-ghost shrink-0 !px-2 !py-0.5 text-[11px]"
          href={url}
          download={name}
        >
          下载
        </a>
      ) : (
        <span className="al-muted shrink-0 text-[11px]">…</span>
      )}
    </div>
  );
}