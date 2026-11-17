import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Member, Message } from '@agentlink/protocol';
import { CreateGroupDialog } from './components/CreateGroupDialog.js';
import { AdminPage } from './pages/AdminPage.js';
import { adminPath, navigate, useRoute } from './lib/router.js';
import { ChatWindow } from './components/ChatWindow.js';
import { ConversationList } from './components/ConversationList.js';
import { LoginView } from './components/LoginView.js';
import { MemberPanel } from './components/MemberPanel.js';
import { ProtocolClient, clearTokens, loadTokens } from './lib/client.js';
import { useChat } from './lib/useChat.js';
import { uuid } from './lib/format.js';

const PAGE_SIZE = 50;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // token 只在帧体内，URL 里不带任何凭证（协议 §2.4）
  return `${proto}//${location.host}/ws`;
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(loadTokens().access !== null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showMembers, setShowMembers] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const route = useRoute();
  const clientRef = useRef<ProtocolClient | null>(null);

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
    handleEvent,
    streaming,
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
      onEvent: (evt) => handleEvent(evt),
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
        } catch {
          /* 忽略 */
        }
      })();
    }
  }, [connected, self, setSelf]);

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
    (text: string) => {
      const client = clientRef.current;
      if (client === null || activeConvId === null) return;
      const content = [{ type: 'text' as const, text }];
      // 乐观插入：先本地显示，服务端回 res 后换成真实消息
      const optimistic: Message = {
        id: `local_${uuid()}`,
        conv_id: activeConvId,
        seq: null,
        sender: self ?? { id: '', kind: 'human', display_name: '我' },
        content,
        reply_to: null,
        state: 'final',
        interrupted: false,
        created_at: Date.now(),
        revoked_at: null,
      };
      replaceMessage(activeConvId, optimistic);
      void (async () => {
        try {
          const res = await client.call<{ message_id: string; seq: number; created_at: number }>(
            'message.send',
            {
              conv_id: activeConvId,
              client_msg_id: uuid(),
              content,
            },
          );
          replaceMessage(activeConvId, {
            ...optimistic,
            id: res.message_id,
            seq: res.seq,
            created_at: res.created_at,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : '发送失败');
        }
      })();
    },
    [activeConvId, self, replaceMessage, setError],
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
      <AdminPage
        selfId={self?.id ?? ''}
        isAdmin={isAdmin}
        section={route.section}
        onBack={() => navigate('/')}
        onCreateGroup={(title) => createGroup(title, [])}
      />
    );
  }

  return (
    <div className="flex h-full">
      <ConversationList
        convs={convs}
        activeConvId={activeConvId}
        messages={messages}
        onSelect={setActiveConv}
        onNewGroup={() => setShowCreateDialog(true)}
        selfName={self?.display_name ?? '…'}
        onLogout={logout}
      />

      {activeConv === null ? (
        <div className="al-chat-bg grid flex-1 place-items-center">
          <div className="al-muted text-sm">选择左侧一个会话开始聊天</div>
        </div>
      ) : (
        <ChatWindow
          convTitle={activeConv.title || '(无标题)'}
          messages={messages[activeConv.id] ?? []}
          streaming={streaming}
          selfId={self?.id ?? ''}
          members={activeMembers}
          onSend={send}
          onRevoke={revoke}
          onInterrupt={interrupt}
          onLoadMore={loadMore}
          hasMore={hasMore[activeConv.id] ?? false}
          loadingMore={loadingMore}
          onToggleMembers={() => setShowMembers((v) => !v)}
          canRevokeOthers={myRole === 'owner' || myRole === 'admin'}
        />
      )}

      {activeConv !== null && showMembers && (
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

      {showCreateDialog && (
        <CreateGroupDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={createGroup}
        />
      )}
    </div>
  );
}
