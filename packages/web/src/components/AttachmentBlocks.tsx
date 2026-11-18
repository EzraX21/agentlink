import { useEffect, useState } from 'react';
import {
  acquireAttachmentUrl,
  downloadAttachment,
  fetchAttachmentThumbnail,
  formatBytes,
  releaseAttachmentUrl,
} from '../lib/attachments.js';
import { MediaViewer } from './MediaViewer.js';

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
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [attachmentId, filename, reloadKey]);

  if (error !== null) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="al-muted">[图片加载失败：{error}]</span>
        <button
          className="al-btn-ghost !px-2 !py-0.5"
          onClick={() => {
            setError(null);
            // 重新挂载 effect：模块级缓存里可能留着失败态，重试前先释放
            releaseAttachmentUrl(attachmentId);
            setReloadKey((k) => k + 1);
          }}
        >
          重试
        </button>
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
      {zoomed && url !== null && (
        <MediaViewer
          title={filename ?? '图片'}
          position={position ?? null}
          onClose={() => onCloseZoom?.()}
          onPrev={onPrev}
          onNext={onNext}
        >
          <img
            src={url}
            alt={filename ?? '图片'}
            style={{ maxWidth: '100%', maxHeight: '68vh', borderRadius: 6 }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </MediaViewer>
      )}
    </>
  );
}

/** 文件块：名称 + 大小 + 下载（同样走带鉴权的 fetch）。 */
/**
 * 视频块：缩略图 + 「播放」，点开才取字节并在弹窗里播放。
 *
 * 不预载**视频本体**的原因和文件一样：群里贴 20 段视频，进群就把 20 个视频全拉一遍，
 * 流量和内存都白费（而且浏览器还会去解析元数据）。
 *
 * 但**缩略图**要预载：那是一张几十 KB 的 JPEG，服务端在上传时就抽好了。
 * 没有缩略图（服务端没装 ffmpeg / 不是视频）就退回纯文字卡片。
 */
export function VideoBlockView({
  attachmentId,
  filename,
  size,
}: {
  attachmentId: string;
  filename?: string | undefined;
  size?: number | undefined;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ url: string; kind: 'video' } | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const name = filename ?? '视频';

  // 缩略图单独取：失败（404 / 无 ffmpeg）不影响卡片本身
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    fetchAttachmentThumbnail(attachmentId)
      .then((u) => {
        if (!alive) {
          if (u !== null) URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setThumb(u);
      })
      .catch(() => {
        // 没有缩略图：退回纯文字卡片
      });
    return () => {
      alive = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  async function open(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    setPercent(0);
    try {
      const url = await acquireAttachmentUrl(attachmentId, name, (p) => setPercent(p));
      setPreview({ url, kind: 'video' });
      setPercent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '视频加载失败');
      setPercent(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div
        className="mt-1 flex max-w-[340px] items-center gap-2 rounded-lg px-2 py-2"
        style={{ background: 'var(--al-bg-hover)' }}
      >
        {thumb !== null ? (
          <img
            src={thumb}
            alt=""
            style={{
              width: 72,
              height: 48,
              objectFit: 'cover',
              borderRadius: 6,
              flexShrink: 0,
              cursor: 'pointer',
            }}
            onClick={() => void open()}
          />
        ) : (
          <span aria-hidden style={{ fontSize: 18 }}>
            🎬
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{name}</div>
          <div className="al-muted text-[11px]">
            {error !== null
              ? error
              : loading
                ? percent === null
                  ? '加载中…'
                  : `加载中 ${percent}%`
                : size !== undefined
                  ? formatBytes(size)
                  : '视频'}
          </div>
        </div>
        <button
          className="al-btn-ghost shrink-0 !px-2 !py-0.5 text-[11px]"
          onClick={() => void open()}
          disabled={loading}
          aria-label={`播放 ${name}`}
        >
          {loading ? '…' : '播放'}
        </button>
      </div>

      {preview !== null && (
        <MediaViewer
          title={name}
          caption={size !== undefined ? formatBytes(size) : undefined}
          onClose={() => {
            releaseAttachmentUrl(attachmentId);
            setPreview(null);
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={preview.url}
            controls
            autoPlay
            style={{ maxWidth: '100%', maxHeight: '68vh', borderRadius: 6 }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </MediaViewer>
      )}
    </>
  );
}

export function FileBlockView({
  attachmentId,
  filename,
  size,
}: {
  attachmentId: string;
  filename?: string | undefined;
  size?: number | undefined;
}): React.JSX.Element {
  // 文件不预载：点下载时才取字节，并显示进度（大文件没有反馈会让人以为卡死）
  const [percent, setPercent] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = filename ?? '文件';

  async function startDownload(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    setPercent(0);
    try {
      await downloadAttachment(attachmentId, name, { onProgress: (p) => setPercent(p) });
      setPercent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
      setPercent(null);
    } finally {
      setDownloading(false);
    }
  }

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
          {error !== null
            ? error
            : downloading
              ? percent === null
                ? '下载中…'
                : `下载中 ${percent}%`
              : size !== undefined
                ? formatBytes(size)
                : '文件'}
        </div>
        {downloading && (
          <div
            style={{ height: 3, background: 'var(--al-border)', borderRadius: 2, marginTop: 3 }}
            role="progressbar"
            aria-valuenow={percent ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              style={{
                width: percent === null ? '30%' : `${percent}%`,
                height: '100%',
                background: 'var(--al-primary)',
                transition: 'width 120ms linear',
              }}
            />
          </div>
        )}
      </div>
      <button
        className="al-btn-ghost shrink-0 !px-2 !py-0.5 text-[11px]"
        onClick={() => void startDownload()}
        disabled={downloading}
        aria-label={error !== null ? `重试下载 ${name}` : `下载 ${name}`}
      >
        {downloading ? '…' : error !== null ? '重试' : '下载'}
      </button>
    </div>
  );
}