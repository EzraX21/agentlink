import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, SearchHit } from '@agentlink/protocol';
import { api } from '../lib/api.js';
import { Excerpt } from './Excerpt.js';

/**
 * 全局搜索（协议 §1：搜索走 HTTP 控制面；§5.7 定义 hit 结构与 `<mark>` 片段）。
 *
 * 行为对齐 TG 桌面版的基本预期：
 *   - 输入即搜（250ms 去抖），不用按回车
 *   - 结果按会话分组，显示命中片段（excerpt 里已带 `<mark>`）
 *   - 点结果跳到该会话
 *   - 搜索范围是"自己可见的会话"（服务端强制）
 */

export interface SearchPanelProps {
  onPick: (convId: string, messageId: string, seq: number) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 250;

export function SearchPanel({ onPick, onClose }: SearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 只采纳最后一次请求的结果，避免慢请求覆盖新结果
  const reqId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    void api
      .convs()
      .then((r) => setConvs(r.items as unknown as Conversation[]))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .search({ q, limit: 50 })
        .then((r) => {
          if (my !== reqId.current) return;
          setHits(r.hits);
          setError(null);
        })
        .catch((err: unknown) => {
          if (my !== reqId.current) return;
          setError(err instanceof Error ? err.message : '搜索失败');
        })
        .finally(() => {
          if (my === reqId.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const titleByConv = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of convs) map.set(c.id, c.title || '(无标题)');
    return map;
  }, [convs]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const list = map.get(h.conv_id) ?? [];
      list.push(h);
      map.set(h.conv_id, list);
    }
    return [...map.entries()];
  }, [hits]);

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--al-bg-sidebar)' }}>
      <header
        className="flex items-center gap-2 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--al-border)' }}
      >
        <button className="al-muted shrink-0" onClick={onClose} title="关闭搜索">
          ←
        </button>
        <input
          ref={inputRef}
          className="al-input"
          placeholder="搜索消息（关键词 / 中文子串都行）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
      </header>

      <div className="flex-1 overflow-y-auto p-2 text-xs">
        {loading && <div className="al-muted p-2">搜索中…</div>}
        {error !== null && (
          <div className="p-2" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}
        {!loading && query.trim() !== '' && hits.length === 0 && error === null && (
          <div className="al-muted p-2">没有匹配的消息</div>
        )}
        {query.trim() === '' && (
          <div className="al-muted p-2">
            输入关键词开始搜索。
            <br />
            只搜你在的会话；已撤回的消息不会出现。
          </div>
        )}

        {grouped.map(([convId, list]) => (
          <div key={convId} className="mb-2">
            <div className="al-muted px-1 py-1 font-medium">
              {titleByConv.get(convId) ?? convId}（{list.length}）
            </div>
            {list.map((h) => (
              <button
                key={h.message_id}
                className="al-conv-item w-full text-left"
                onClick={() => onPick(h.conv_id, h.message_id, h.seq)}
                title={`seq ${h.seq}`}
              >
                <div className="min-w-0 flex-1">
                  {/* excerpt 由服务端生成，含 <mark> 高亮（协议 §5.7） */}
                  <div className="al-muted mb-0.5 text-[11px]">
                    {new Date(h.created_at).toLocaleString()}
                  </div>
                  <Excerpt text={h.excerpt} />
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}