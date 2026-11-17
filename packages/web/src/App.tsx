import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Member, Message } from '@agentlink/protocol';
import { CreateGroupDialog } from './components/CreateGroupDialog.js';
// 搜索面板按需加载：不进首屏 bundle
const SearchPanel = lazy(() =>
  import('./components/SearchPanel.js').then((m) => ({ default: m.SearchPanel })),
);
import { GroupInfoDialog } from './components/GroupInfoDialog.js';
// 管理页按需加载：只有管理员会进，没必要压进首屏 bundle
const AdminPage = lazy(() =>
  import('./pages/AdminPage.js').then((m) => ({ default: m.AdminPage })),
);
import { adminPath, navigate, useRoute } from './lib/router.js';
import { ChatWindow } from './components/ChatWindow.js';
import { ConversationList } from './components/ConversationList.js';
import { LoginView } from './components/LoginView.js';
import { MemberPanel } from './components/MemberPanel.js';
import { ProtocolClient, clearTokens, loadTokens } from './lib/client.js';
import { useChat } from './lib/useChat.js';
import { uuid } from './lib/format.js';
import { sendText } from './lib/sendText.js';
import { guessMimeFromName, isImageMime, uploadAttachment } from './lib/attachments.js';
import {
  loadPinned,
  loadSidebarWidth,
  loadUnread,
  savePinned,
  saveSidebarWidth,
  saveUnread,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from './lib/localState.js';
import { NARROW_QUERY, useMediaQuery } from './lib/useMediaQuery.js';
import { reportTyping } from './lib/typing.js';
import {
  bumpAttempts,
  enqueueOutbox,
  loadOutbox,
  removeFromOutbox,
} from './lib/outbox.js';

const PAGE_SIZE = 50;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // token 只在帧体内，URL 里不带任何凭证（协议 §2.4）
  return `${proto}//${location.host}/ws`;
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(loadTokens().access !== null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>(() => loadUnread());
  // 打开会话那一刻的未读数：用来插"以下为新消息"分隔线
  const [unreadOnOpen, setUnreadOnOpen] = useState<Record<string, number>>({});
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  // 待发送（离线排队）的本地消息 id：用于在气泡上标"待发送"
  const [pendingIds, setPendingIds] = useState<Set<string>>(
    () => new Set(loadOutbox().map((e) => e.localId)),
  );
  const draggingSidebar = useRef(false);
  const [pinned, setPinned] = useState<string[]>(() => loadPinned());
  const [showMembers, setShowMembers] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const route = useRoute();
  const clientRef = useRef<ProtocolClient | null>(null);
  // 用 ref 读最新值：连接 effect 不能因为"当前打开的会话/自己 id"变化而重连
  const selfIdRef = useRef<string | null>(null);
  const activeConvRef = useRef<string | null>(null);

  const {
    self,
    setSelf,
    convs,
    setConvs,
    upsertConv,
    activeConvId,
    setActiveConv,
    members,
    setMembers,
    removeMember,
    messages,
    setMessages,
    prependMessages,
    replaceMessage,
    removeMessage,
    handleEvent,
    streaming,
    typing,
    setStreamingText,
    theme,
    setTheme,
    connected,
    setConnected,
    lastError,
    setError,
  } = useChat();

  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [loadingMore, setLoadingMore] = useState(false);

  // 主题切换（CSS 变量）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const loadConv = useCallback(
    async (client: ProtocolClient, convId: string) => {
      const page = await client.call<{ messages: Message[]; has_more: boolean }>('history.fetch', {
        conv_id: convId,
        limit: PAGE_SIZE,
      });
      // history.fetch 返回 seq 降序，展示要升序
      setMessages(convId, [...page.messages].reverse());
      setHasMore((prev) => ({ ...prev, [convId]: page.has_more }));
    },
    [setMessages],
  );

  const loadMembers = useCallback(
    async (client: ProtocolClient, convId: string) => {
      const data = await client.call<{ conv: Conversation; members: Member[] }>('conv.get', {
        conv_id: convId,
      });
      setMembers(convId, data.members);
      upsertConv(data.conv);
    },
    [setMembers, upsertConv],
  );

  /** gap:true 时的全量重同步（协议 §4.2）。 */
  const resync = useCallback(
    async (client: ProtocolClient) => {
      const list = await client.call<{ items: Conversation[] }>('conv.list', { limit: 100 });
      setConvs(list.items);
      for (const conv of list.items) {
        await loadConv(client, conv.id);
      }
    },
    [setConvs, loadConv],
  );

  // 连接与事件订阅
  useEffect(() => {
    if (!authed) return;
    const tokens = loadTokens();
    if (tokens.access === null || tokens.refresh === null) {
      setAuthed(false);
      return;
    }

    const client = new ProtocolClient(wsUrl(), {
      onState: (state) => setConnected(state === 'ready'),
      onEvent: (evt) => {
        handleEvent(evt);
        if (evt.type === 'message.new') {
          const data = evt.data as { conv_id?: string; message?: { sender?: { id?: string } } };
          const senderId = data.message?.sender?.id;
          const convId = data.conv_id;
          // 形状不对就跳过（回放的历史事件可能来自旧版本/外部工具）
          if (senderId === undefined || convId === undefined) return;
          // 自己发的不算未读；当前打开的会话也不算
          if (senderId !== selfIdRef.current && convId !== activeConvRef.current) {
            setUnread((prev) => {
              const next = { ...prev, [convId]: (prev[convId] ?? 0) + 1 };
              saveUnread(next);
              return next;
            });
          }
        }
      },
      onResync: () => {
        void resync(client);
      },
      onRevGap: (convId, messageId, _expected, gotRev) => {
        // 协议 §8.2：rev 跳变必须调 message.get 拉当前完整文本并重置
        void (async () => {
          try {
            const data = await client.call<{ message: Message }>('message.get', {
              conv_id: convId,
              message_id: messageId,
            });
            setStreamingText(
              convId,
              messageId,
              data.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
              gotRev,
            );
          } catch (err) {
            setError(err instanceof Error ? err.message : '重同步失败');
          }
        })();
      },
      onError: (msg) => setError(msg),
    });
    client.setTokens(tokens.access, tokens.refresh);
    clientRef.current = client;

    void (async () => {
      // connect() 内部已完成 auth + resume（含 gap 判定）
      await client.connect();
      const list = await client.call<{ items: Conversation[] }>('conv.list', { limit: 100 });
      setConvs(list.items);
      const me = await client.call<{
        protocol: number;
        self: { id: string; kind: 'human' | 'agent'; display_name: string; tenant_id: string };
      }>('auth', { token: tokens.access }).catch(() => null);
      void me;
    })().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '连接失败');
    });

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [authed, handleEvent, resync, setConvs, setConnected, setError, setStreamingText]);

  // 取 self 与当前会话内容
  useEffect(() => {
    const client = clientRef.current;
    if (client === null || !connected) return;
    if (self === null) {
      void (async () => {
        try {
          const me = await fetch('/api/auth/me', {
            headers: { authorization: `Bearer ${loadTokens().access ?? ''}` },
          });
          if (!me.ok) return;
          const data = (await me.json()) as {
            user: { id: string; display_name: string };
            kind: 'human' | 'agent';
            is_admin?: boolean;
          };
          setSelf({
            id: data.user.id,
            kind: data.kind,
            display_name: data.user.display_name,
            tenant_id: 'default',
          });
          setIsAdmin(data.is_admin === true);
          selfIdRef.current = data.user.id;
        } catch {
          /* 忽略 */
        }
      })();
    }
  }, [connected, self, setSelf]);

  // 打开某个会话 → 清它的未读；同时把当前会话记进 ref 供事件回调判断
  useEffect(() => {
    activeConvRef.current = activeConvId;
    if (activeConvId === null) return;
    // 先记下这一刻的未读数，再清零（分隔线要用它）
    setUnreadOnOpen((prev) => ({ ...prev, [activeConvId]: unread[activeConvId] ?? 0 }));
    setUnread((prev) => {
      if ((prev[activeConvId] ?? 0) === 0) return prev;
      const next = { ...prev };
      delete next[activeConvId];
      saveUnread(next);
      return next;
    });
    // unread 故意不进依赖：这里只在切换会话时读一次快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  useEffect(() => {
    const client = clientRef.current;
    if (client === null || !connected || activeConvId === null) return;
    void (async () => {
      if ((messages[activeConvId] ?? []).length === 0) await loadConv(client, activeConvId);
      await loadMembers(client, activeConvId);
    })();
    // 只在切换会话时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, connected]);

  const activeConv = useMemo(
    () => convs.find((c) => c.id === activeConvId) ?? null,
    [convs, activeConvId],
  );
  const activeMembers = activeConvId === null ? [] : (members[activeConvId] ?? []);
  const myRole = useMemo(() => {
    if (self === null || activeConvId === null) return 'member' as const;
    const me = (members[activeConvId] ?? []).find((m) => m.user_id === self.id);
    return me?.role ?? ('member' as const);
  }, [self, members, activeConvId]);

  const send = useCallback(
    (text: string, replyTo?: string) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;
      // 乐观插入 + 与服务端推送收敛，细节见 lib/sendText.ts 的注释
      void sendText(
        {
          call: (op, data) => client.call(op, data),
          replaceMessage,
          removeMessage,
          setError,
          uuid,
          now: () => Date.now(),
          isOnline: () => client.connected,
          onOffline: (entry) => {
            // 断线：进发件箱，等恢复后按同一个 client_msg_id 重发（幂等）
            enqueueOutbox({ ...entry, attempts: 0 });
            setPendingIds((prev) => new Set(prev).add(entry.localId));
          },
        },
        { convId: activeConvId, self, text, replyTo },
      );
    },
    [activeConvId, self, replaceMessage, removeMessage, setError],
  );

  /**
   * 上传一个文件并发成消息。
   *
   * 协议 §5.3 的 content 是块数组：图片用 image 块（带 attachment_id），
   * 其余用 file 块（带 filename/size 便于客户端直接展示，不用再查元信息）。
   */
  const sendAttachment = useCallback(
    async (file: File, replyTo?: string, onProgress?: (percent: number | null) => void) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;

      // XHR 上传：fetch 拿不到上传进度
      const uploaded = await uploadAttachment(file, {
        ...(onProgress === undefined
          ? {}
          : { onProgress: (p) => onProgress(p.percent) }),
      });
      const mime = uploaded.mime || guessMimeFromName(file.name);
      const content = isImageMime(mime)
        ? [{ type: 'image' as const, attachment_id: uploaded.attachment_id }]
        : [
            {
              type: 'file' as const,
              attachment_id: uploaded.attachment_id,
              filename: uploaded.filename,
              size: uploaded.size,
            },
          ];

      const res = await client.call<{ message_id: string; seq: number; created_at: number }>(
        'message.send',
        {
          conv_id: activeConvId,
          client_msg_id: uuid(),
          content,
          ...(replyTo === undefined ? {} : { reply_to: replyTo }),
        },
      );
      // 服务端也会推 message.new；这里按 id 幂等放入，避免等待推送造成的延迟感
      replaceMessage(activeConvId, {
        id: res.message_id,
        conv_id: activeConvId,
        seq: res.seq,
        sender: self ?? { id: '', kind: 'human', display_name: '我' },
        content,
        reply_to: replyTo ?? null,
        state: 'final',
        interrupted: false,
        created_at: res.created_at,
        revoked_at: null,
      });
    },
    [activeConvId, self, replaceMessage],
  );

  /**
   * 跳到某条搜索结果：切会话，并把历史拉到那条消息（含）为止。
   * 协议 §5.3 的 history.fetch 用 before_seq 分页，所以取 seq+1 作为游标即可覆盖。
   */
  const jumpToMessage = useCallback(
    (convId: string, messageId: string, seq: number) => {
      setShowSearch(false);
      setActiveConv(convId);
      const client = clientRef.current;
      if (client === null) return;
      void (async () => {
        try {
          const page = await client.call<{ messages: Message[]; has_more: boolean }>(
            'history.fetch',
            { conv_id: convId, before_seq: seq + 1, limit: PAGE_SIZE },
          );
          setMessages(convId, [...page.messages].reverse());
          setHasMore((prev) => ({ ...prev, [convId]: page.has_more }));
          setHighlightId(messageId);
        } catch (err) {
          setError(err instanceof Error ? err.message : '跳转失败');
        }
      })();
    },
    [setActiveConv, setMessages, setError],
  );

  const revoke = useCallback(
    (messageId: string) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;
      void client
        .call('message.revoke', { conv_id: activeConvId, message_id: messageId })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : '撤回失败'));
    },
    [activeConvId, setError],
  );

  const interrupt = useCallback(
    (messageId: string) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;
      void client
        .call('stream.interrupt', { conv_id: activeConvId, message_id: messageId })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : '打断失败'));
    },
    [activeConvId, setError],
  );

  const loadMore = useCallback(() => {
    const client = clientRef.current;
    if (client === null || activeConvId === null) return;
    const list = messages[activeConvId] ?? [];
    const oldest = list.find((m) => m.seq !== null);
    if (oldest?.seq === null || oldest?.seq === undefined) return;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await client.call<{ messages: Message[]; has_more: boolean }>('history.fetch', {
          conv_id: activeConvId,
          before_seq: oldest.seq,
          limit: PAGE_SIZE,
        });
        prependMessages(activeConvId, [...page.messages].reverse());
        setHasMore((prev) => ({ ...prev, [activeConvId]: page.has_more }));
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载历史失败');
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [activeConvId, messages, prependMessages, setError]);

  /** 保存群名/公告（协议 §5.2 group.update）。服务端会推 group.update 事件。 */
  const saveGroupInfo = useCallback(
    async (patch: { title?: string; announcement?: string }) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;
      const data = await client.call<{ conv: Conversation }>('group.update', {
        conv_id: activeConvId,
        ...patch,
      });
      upsertConv(data.conv);
    },
    [activeConvId, upsertConv],
  );

  /** 标记某个会话已读（清本地未读计数）。 */
  const markRead = useCallback((convId: string) => {
    setUnread((prev) => {
      if ((prev[convId] ?? 0) === 0) return prev;
      const next = { ...prev };
      delete next[convId];
      saveUnread(next);
      return next;
    });
  }, []);

  const togglePin = useCallback((convId: string) => {
    setPinned((prev) => {
      const next = prev.includes(convId)
        ? prev.filter((x) => x !== convId)
        : [...prev, convId];
      savePinned(next);
      return next;
    });
  }, []);

  const createGroup = useCallback(async (title: string, memberIds: string[]): Promise<string> => {
    const client = clientRef.current;
    if (client === null) throw new Error('未连接');
    const data = await client.call<{ conv: Conversation }>('conv.create', {
      kind: 'group',
      title,
      member_ids: memberIds,
    });
    upsertConv(data.conv);
    setActiveConv(data.conv.id);
    return data.conv.id;
  }, [upsertConv, setActiveConv]);

  // 侧栏宽度拖拽：按下手柄后跟踪全局鼠标，松开时持久化
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingSidebar.current) return;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
      setSidebarWidth(next);
    };
    const onUp = (): void => {
      if (!draggingSidebar.current) return;
      draggingSidebar.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth((w) => {
        saveSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /**
   * 连接可用时把发件箱里的消息重发出去。
   *
   * 关键点：重发用的是**原来的 client_msg_id**，所以即使上次其实已经到达
   * （只是响应丢了），服务端也会按幂等键返回同一条消息，不会产生重复。
   */
  const flushOutbox = useCallback(async () => {
    const client = clientRef.current;
    if (client === null || !client.connected) return;
    const entries = loadOutbox();
    if (entries.length === 0) {
      setPendingIds(new Set());
      return;
    }

    for (const entry of entries) {
      bumpAttempts(entry.clientMsgId);
      try {
        const res = await client.call<{ message_id: string; seq: number; created_at: number }>(
          'message.send',
          {
            conv_id: entry.convId,
            client_msg_id: entry.clientMsgId,
            content: entry.content as never,
            ...(entry.replyTo === null ? {} : { reply_to: entry.replyTo }),
          },
        );
        // 用真实消息替换本地占位（服务端也会推 message.new，按 id 去重）
        removeMessage(entry.convId, entry.localId);
        removeFromOutbox(entry.clientMsgId);
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.localId);
          return next;
        });
        void res;
      } catch {
        // 仍然失败：保留在队列里，下次再试
        break;
      }
    }
  }, [removeMessage]);

  // 连接恢复时：清掉"已连接"提示 + 冲发件箱
  useEffect(() => {
    if (connected) void flushOutbox();
  }, [connected, flushOutbox]);

  // 连接恢复时给一个短暂的"已连接"提示（断线时用户已经受惊了）
  const [reconnectedFlash, setReconnectedFlash] = useState(false);
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (!connected) {
      wasDisconnected.current = true;
      return;
    }
    if (wasDisconnected.current) {
      wasDisconnected.current = false;
      setReconnectedFlash(true);
      const t = window.setTimeout(() => setReconnectedFlash(false), 2500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [connected]);

  // 快捷键：Ctrl/Cmd+K 搜索，Esc 关闭面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === 'Escape') {
        setShowSearch(false);
        setShowCreateDialog(false);
        setShowGroupInfo(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function logout(): void {
    clientRef.current?.disconnect();
    clearTokens();
    setAuthed(false);
    setSelf(null);
    setConvs([]);
    setActiveConv(null);
    setIsAdmin(false);
    navigate('/');
  }

  if (!authed) {
    return (
      <LoginView
        onDone={() => {
          setAuthed(true);
        }}
      />
    );
  }

  // 管理页是独立视图（需求确认书 §5：WebUI 管理面板），走 hash 路由
  if (route.name === 'admin') {
    return (
      <Suspense
        fallback={
          <div className="grid h-full place-items-center">
            <span className="al-muted text-sm">管理页加载中…</span>
          </div>
        }
      >
        <AdminPage
          selfId={self?.id ?? ''}
          isAdmin={isAdmin}
          section={route.section}
          onBack={() => navigate('/')}
          onCreateGroup={(title) => createGroup(title, [])}
        />
      </Suspense>
    );
  }

  // 窄屏单栏：没选会话看列表，选了会话看聊天（TG 移动端行为）
  const narrowShowChat = narrow && activeConv !== null;
  const narrowShowList = narrow && activeConv === null;

  return (
    <div className="flex h-full flex-col">
      {!connected && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-1.5 text-xs text-white"
          style={{ background: '#b3261e' }}
          role="alert"
        >
          <span>
            与服务器的实时连接已断开 —— 正在自动重连。期间收不到新消息，
            你发出的消息会等连接恢复后重试。
          </span>
          <button
            className="shrink-0 rounded px-2 py-0.5"
            style={{ background: 'rgb(255 255 255 / 22%)' }}
            onClick={() => clientRef.current?.retryNow()}
          >
            立即重试
          </button>
        </div>
      )}

      {reconnectedFlash && (
        <div
          className="px-4 py-1.5 text-center text-xs text-white"
          style={{ background: '#2e7d32' }}
          role="status"
        >
          连接已恢复
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      {!narrowShowChat && (showSearch ? (
        <div className="shrink-0" style={{ width: sidebarWidth }}>
          <Suspense fallback={<div className="al-muted p-3 text-xs">搜索面板加载中…</div>}>
            <SearchPanel onPick={jumpToMessage} onClose={() => setShowSearch(false)} />
          </Suspense>
        </div>
      ) : (
        <ConversationList
          convs={convs}
          activeConvId={activeConvId}
          messages={messages}
          onSelect={setActiveConv}
          onNewGroup={() => setShowCreateDialog(true)}
          selfName={self?.display_name ?? '…'}
          onLogout={logout}
          onOpenSearch={() => setShowSearch(true)}
          unread={unread}
          pinned={pinned}
          onTogglePin={togglePin}
          onMarkRead={markRead}
          width={sidebarWidth}
        />
      ))}

      {!narrow && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整侧栏宽度"
          onMouseDown={() => {
            draggingSidebar.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          onDoubleClick={() => {
            setSidebarWidth(300);
            saveSidebarWidth(300);
          }}
          style={{
            width: 5,
            cursor: 'col-resize',
            background: 'var(--al-border)',
            flex: '0 0 auto',
          }}
        />
      )}

      {activeConv === null ? (
        narrowShowList ? null : (
          <div className="al-chat-bg grid flex-1 place-items-center">
            <div className="al-muted text-sm">选择左侧一个会话开始聊天</div>
          </div>
        )
      ) : (
        <ChatWindow
          convId={activeConv.id}
          convTitle={activeConv.title || '(无标题)'}
          announcement={activeConv.announcement}
          messages={messages[activeConv.id] ?? []}
          streaming={streaming}
          selfId={self?.id ?? ''}
          members={activeMembers}
          onSend={send}
          onSendAttachment={sendAttachment}
          onRevoke={revoke}
          onInterrupt={interrupt}
          onLoadMore={loadMore}
          hasMore={hasMore[activeConv.id] ?? false}
          loadingMore={loadingMore}
          onToggleMembers={() => setShowMembers((v) => !v)}
          canRevokeOthers={myRole === 'owner' || myRole === 'admin'}
          highlightMessageId={highlightId}
          onJumpToMessage={jumpToMessage}
          pendingLocalIds={pendingIds}
          typing={typing}
          online={connected}
          onTyping={() => {
            const client = clientRef.current;
            if (client === null || activeConvId === null) return;
            void reportTyping(client, activeConvId);
          }}
          unreadOnOpen={unreadOnOpen[activeConv.id] ?? 0}
          {...(narrow ? { onBack: () => setActiveConv(null) } : {})}
          onOpenGroupInfo={() => setShowGroupInfo(true)}
          canEditGroup={myRole === 'owner' || myRole === 'admin'}
        />
      )}

      {activeConv !== null && showMembers && !narrow && (
        <MemberPanel
          members={activeMembers}
          selfId={self?.id ?? ''}
          myRole={myRole}
          onKick={(userId) => {
            const client = clientRef.current;
            if (client === null || activeConvId === null) return;
            void client
              .call('member.kick', { conv_id: activeConvId, user_id: userId })
              .then(() => removeMember(activeConvId, userId))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '踢人失败'));
          }}
          onMute={(userId, minutes) => {
            const client = clientRef.current;
            if (client === null || activeConvId === null) return;
            const until = minutes === 0 ? 0 : Date.now() + minutes * 60_000;
            void client
              .call('member.mute', { conv_id: activeConvId, user_id: userId, until_ms: until })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '禁言失败'));
          }}
          onSetRole={(userId, role) => {
            const client = clientRef.current;
            if (client === null || activeConvId === null) return;
            void client
              .call('member.role.set', { conv_id: activeConvId, user_id: userId, role })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '改角色失败'));
          }}
          onInvite={() => {
            const ids = window.prompt('要邀请的用户 ID（逗号分隔）');
            if (ids === null || ids.trim() === '') return;
            const client = clientRef.current;
            if (client === null || activeConvId === null) return;
            void client
              .call('member.invite', {
                conv_id: activeConvId,
                user_ids: ids
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s !== ''),
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : '邀请失败'));
          }}
          onClose={() => setShowMembers(false)}
        />
      )}

      <div className="fixed bottom-3 right-3 z-40 flex items-center gap-2 text-xs">
        <span
          className="rounded-full px-2 py-1"
          style={{
            background: connected ? '#2e7d32' : '#c62828',
            color: '#fff',
          }}
          title={connected ? '实时连接正常' : '已断开，正在重连'}
        >
          {connected ? '● 已连接' : '○ 重连中'}
        </span>
        <button className="al-btn-ghost" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        {isAdmin && (
          <button className="al-btn-ghost" onClick={() => navigate(adminPath('overview'))}>
            管理
          </button>
        )}
      </div>

      {lastError !== null && (
        <div
          className="fixed bottom-14 right-3 z-40 max-w-[320px] rounded-lg px-3 py-2 text-xs text-white"
          style={{ background: 'var(--al-danger)' }}
          onClick={() => setError(null)}
          role="alert"
        >
          {lastError}
        </div>
      )}

      {showGroupInfo && activeConv !== null && (
        <GroupInfoDialog
          initialTitle={activeConv.title}
          initialAnnouncement={activeConv.announcement}
          canEdit={myRole === 'owner' || myRole === 'admin'}
          onClose={() => setShowGroupInfo(false)}
          onSave={saveGroupInfo}
        />
      )}

      {showCreateDialog && (
        <CreateGroupDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={createGroup}
        />
      )}
      </div>
    </div>
  );
}
