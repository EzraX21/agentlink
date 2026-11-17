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
}: {
  attachmentId: string;
  filename?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

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
        onClick={() => setZoomed(true)}
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
          style={{ background: 'rgb(0 0 0 / 78%)' }}
          onClick={() => setZoomed(false)}
        >
          <img
            src={url}
            alt={filename ?? '图片'}
            style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8 }}
          />
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