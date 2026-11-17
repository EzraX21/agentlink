import type {
  Conversation,
  EvtFrame,
  Member,
  Message,
  ReactionSummary,
  Self,
} from '@agentlink/protocol';

/**
 * 聊天状态（Zustand）。
 *
 * 只放 UI 状态与实时消息；服务端状态的拉取走 TanStack Query（见 api.ts）。
 * 流式消息在这里按 rev 增量拼接。
 */

export interface StreamingState {
  messageId: string;
  convId: string;
  text: string;
  rev: number;
}

export interface ChatState {
  self: Self | null;
  convs: Conversation[];
  activeConvId: string | null;
  members: Record<string, Member[]>;
  /** conv_id → 消息列表（按 seq 升序）。 */
  messages: Record<string, Message[]>;
  /** message_id → 流式累积状态。 */
  streaming: Record<string, StreamingState>;
  typing: Record<string, number>;
  theme: 'light' | 'dark';
  connected: boolean;
  lastError: string | null;

  setSelf(self: Self | null): void;
  setConvs(convs: Conversation[]): void;
  upsertConv(conv: Conversation): void;
  setActiveConv(id: string | null): void;
  setMembers(convId: string, members: Member[]): void;
  removeMember(convId: string, userId: string): void;
  upsertMember(convId: string, member: Member): void;
  setMessages(convId: string, messages: Message[]): void;
  prependMessages(convId: string, messages: Message[]): void;
  addMessage(msg: Message): void;
  replaceMessage(convId: string, msg: Message): void;
  removeMessage(convId: string, messageId: string): void;
  markRevoked(convId: string, messageId: string): void;
  applyDelta(convId: string, messageId: string, rev: number, delta: string): void;
  /** 表情回应变化（协议扩展 §2）：整体替换该消息的汇总。 */
  setReactions(convId: string, messageId: string, reactions: ReactionSummary[]): void;
  /** 已读水位变化（协议扩展 §5）：只增不减。 */
  setMemberReadSeq(convId: string, userId: string, lastSeq: number): void;
  setStreamingText(convId: string, messageId: string, text: string, rev: number): void;
  clearStreaming(messageId: string): void;
  handleEvent(evt: EvtFrame): void;
  setTheme(theme: 'light' | 'dark'): void;
  setConnected(v: boolean): void;
  setError(msg: string | null): void;
}

/** 消息对象至少要能安全渲染（id / conv_id / sender.id / content 数组）。 */
function isRenderableMessage(m: unknown): m is Message {
  if (m === null || typeof m !== 'object') return false;
  const x = m as Partial<Message>;
  return (
    typeof x.id === 'string' &&
    typeof x.conv_id === 'string' &&
    Array.isArray(x.content) &&
    x.sender !== undefined &&
    typeof x.sender === 'object' &&
    typeof (x.sender as { id?: unknown }).id === 'string'
  );
}

function sortBySeq(list: Message[]): Message[] {
  return [...list].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

function dedupe(list: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

const MAX_MESSAGES_PER_CONV = 2000;

export function createChatStore(set: (partial: Partial<ChatState>) => void, get: () => ChatState): ChatState {
  return {
    self: null,
    convs: [],
    activeConvId: null,
    members: {},
    messages: {},
    streaming: {},
    typing: {},
    theme: (localStorage.getItem('agentlink.theme') as 'light' | 'dark') ?? 'light',
    connected: false,
    lastError: null,

    setSelf: (self) => set({ self }),
    setConvs: (convs) => set({ convs }),
    upsertConv: (conv) => {
      const rest = get().convs.filter((c) => c.id !== conv.id);
      set({ convs: [conv, ...rest] });
    },
    setActiveConv: (id) => set({ activeConvId: id }),
    setMembers: (convId, members) => set({ members: { ...get().members, [convId]: members } }),
    removeMember: (convId, userId) => {
      const list = get().members[convId] ?? [];
      set({ members: { ...get().members, [convId]: list.filter((m) => m.user_id !== userId) } });
    },
    setReactions: (convId, messageId, reactions) => {
      const list = get().messages[convId] ?? [];
      let changed = false;
      const next = list.map((m) => {
        if (m.id !== messageId) return m;
        changed = true;
        return { ...m, reactions };
      });
      if (!changed) return;
      set({ messages: { ...get().messages, [convId]: next } });
    },

    setMemberReadSeq: (convId, userId, lastSeq) => {
      const list = get().members[convId] ?? [];
      let changed = false;
      const next = list.map((m) => {
        if (m.user_id !== userId) return m;
        const current = m.last_read_seq ?? 0;
        if (lastSeq <= current) return m; // 只增不减
        changed = true;
        return { ...m, last_read_seq: lastSeq };
      });
      if (!changed) return;
      set({ members: { ...get().members, [convId]: next } });
    },

    upsertMember: (convId, member) => {
      const list = get().members[convId] ?? [];
      const rest = list.filter((m) => m.user_id !== member.user_id);
      set({ members: { ...get().members, [convId]: [...rest, member] } });
    },
    setMessages: (convId, messages) => {
      set({
        messages: {
          ...get().messages,
          [convId]: sortBySeq(dedupe(messages)).slice(-MAX_MESSAGES_PER_CONV),
        },
      });
    },
    prependMessages: (convId, messages) => {
      const existing = get().messages[convId] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const fresh = messages.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return;

      // 上翻加载的都是在更前面的消息：如果新块的 seq 都比现有最小的小，直接拼接，
      // 省掉对 1000+ 条的整体重排（这是"滚到顶触发加载"时的主要卡顿来源）。
      const headSeq = existing[0]?.seq ?? Number.MAX_SAFE_INTEGER;
      const freshMaxSeq = fresh[fresh.length - 1]?.seq ?? 0;
      const inOrder = fresh.every(
        (m, i) => i === 0 || (m.seq ?? 0) > (fresh[i - 1]?.seq ?? 0),
      );
      const merged =
        inOrder && freshMaxSeq < headSeq
          ? [...fresh, ...existing]
          : sortBySeq(dedupe([...fresh, ...existing]));
      set({ messages: { ...get().messages, [convId]: merged.slice(-MAX_MESSAGES_PER_CONV) } });
    },
    addMessage: (msg) => {
      const existing = get().messages[msg.conv_id] ?? [];
      // 常见情况：新消息的 seq 比现有都大 → 直接追加，省掉一次 O(n log n) 排序。
      // 1000 条消息时"每条消息都排一次序"是滚动卡顿的主要来源之一。
      const last = existing[existing.length - 1];
      const tailSeq = last?.seq ?? 0;
      const msgSeq = msg.seq ?? Number.MAX_SAFE_INTEGER;

      let next: Message[];
      if (existing.length === 0 || msgSeq > tailSeq) {
        if (existing.some((m) => m.id === msg.id)) return;
        next = [...existing, msg];
      } else {
        if (existing.some((m) => m.id === msg.id)) return;
        next = sortBySeq([...existing, msg]);
      }
      set({
        messages: {
          ...get().messages,
          [msg.conv_id]: next.slice(-MAX_MESSAGES_PER_CONV),
        },
      });
    },
    replaceMessage: (convId, msg) => {
      const existing = get().messages[convId] ?? [];
      if (existing.some((m) => m.id === msg.id)) {
        // 原地替换：seq 不变，位置也不变，不需要重新排序
        set({
          messages: {
            ...get().messages,
            [convId]: existing.map((m) => (m.id === msg.id ? msg : m)),
          },
        });
        return;
      }
      const last = existing[existing.length - 1];
      const next =
        last === undefined || (msg.seq ?? Number.MAX_SAFE_INTEGER) > (last.seq ?? 0)
          ? [...existing, msg]
          : sortBySeq([...existing, msg]);
      set({ messages: { ...get().messages, [convId]: next.slice(-MAX_MESSAGES_PER_CONV) } });
    },
    removeMessage: (convId, messageId) => {
      const existing = get().messages[convId] ?? [];
      const next = existing.filter((m) => m.id !== messageId);
      if (next.length !== existing.length) {
        set({ messages: { ...get().messages, [convId]: next } });
      }
    },
    markRevoked: (convId, messageId) => {
      const existing = get().messages[convId] ?? [];
      set({
        messages: {
          ...get().messages,
          [convId]: existing.map((m) =>
            m.id === messageId ? { ...m, state: 'revoked' as const, revoked_at: Date.now() } : m,
          ),
        },
      });
    },
    applyDelta: (convId, messageId, rev, delta) => {
      const cur = get().streaming[messageId];
      if (cur === undefined) return;
      set({
        streaming: {
          ...get().streaming,
          [messageId]: { ...cur, text: cur.text + delta, rev },
        },
      });
    },
    setStreamingText: (convId, messageId, text, rev) => {
      set({
        streaming: {
          ...get().streaming,
          [messageId]: { messageId, convId, text, rev },
        },
      });
    },
    clearStreaming: (messageId) => {
      const next = { ...get().streaming };
      delete next[messageId];
      set({ streaming: next });
    },
    setTheme: (theme) => {
      localStorage.setItem('agentlink.theme', theme);
      set({ theme });
    },
    setConnected: (connected) => set({ connected }),
    setError: (lastError) => set({ lastError }),

    /**
     * 所有实时事件的唯一入口（未知 type 静默忽略，协议 §6）。
     *
     * 额外做一层形状防御：`resume` 回放的是历史事件，只要有一条 payload 不符合
     * 预期（旧版本写入、外部工具灌的数据、将来加字段前的旧行），
     * 直接读 `data.message.sender.id` 会让整个聊天页白屏。
     * 宁可丢一条事件，也不能让 UI 崩。
     */
    handleEvent: (evt) => {
      if (evt === null || typeof evt !== 'object' || typeof evt.type !== 'string') return;
      if (evt.data === null || typeof evt.data !== 'object') return;
      const store = get();
      switch (evt.type) {
        case 'message.new': {
          const data = evt.data as { conv_id: string; message: Message };
          if (!isRenderableMessage(data.message)) return;
          store.addMessage(data.message);
          if (data.message.state === 'streaming') {
            store.setStreamingText(data.conv_id, data.message.id, '', 0);
          }
          break;
        }
        case 'message.update': {
          const data = evt.data as {
            conv_id: string;
            message_id: string;
            rev: number;
            delta: string;
          };
          store.applyDelta(data.conv_id, data.message_id, data.rev, data.delta);
          break;
        }
        case 'message.final': {
          const data = evt.data as { conv_id: string; message: Message };
          if (!isRenderableMessage(data.message)) return;
          store.replaceMessage(data.conv_id, data.message);
          store.clearStreaming(data.message.id);
          break;
        }
        case 'message.revoke': {
          const data = evt.data as { conv_id: string; message_id: string };
          store.markRevoked(data.conv_id, data.message_id);
          store.clearStreaming(data.message_id);
          break;
        }
        case 'member.join': {
          const data = evt.data as { conv_id: string; member: Member };
          if (data.member === undefined || typeof data.member.user_id !== 'string') return;
          store.upsertMember(data.conv_id, data.member);
          break;
        }
        case 'member.leave': {
          const data = evt.data as { conv_id: string; user_id: string };
          store.removeMember(data.conv_id, data.user_id);
          break;
        }
        case 'message.edit': {
          const data = evt.data as { conv_id: string; message: Message };
          if (!isRenderableMessage(data.message)) return;
          store.replaceMessage(data.conv_id, data.message);
          break;
        }
        case 'message.reaction': {
          const data = evt.data as {
            conv_id: string;
            message_id: string;
            reactions: ReactionSummary[];
          };
          if (typeof data.message_id !== 'string' || !Array.isArray(data.reactions)) return;
          store.setReactions(data.conv_id, data.message_id, data.reactions);
          break;
        }
        case 'read.update': {
          const data = evt.data as { conv_id: string; user_id: string; last_seq: number };
          if (typeof data.user_id !== 'string' || typeof data.last_seq !== 'number') return;
          store.setMemberReadSeq(data.conv_id, data.user_id, data.last_seq);
          break;
        }
        case 'member.update': {
          const data = evt.data as { conv_id: string; member: Member };
          if (data.member === undefined || typeof data.member.user_id !== 'string') return;
          store.upsertMember(data.conv_id, data.member);
          break;
        }
        case 'group.update': {
          const data = evt.data as { conv: Conversation };
          store.upsertConv(data.conv);
          break;
        }
        case 'typing': {
          const data = evt.data as { conv_id: string; user_id: string };
          set({ typing: { ...get().typing, [`${data.conv_id}:${data.user_id}`]: Date.now() } });
          break;
        }
        case 'poke': {
          // 瞬时提示，M6 只记录最后错误位以便 UI 弹一下
          break;
        }
        default:
          // 未知 evt.type 必须忽略（协议 §6：前向兼容硬要求）
          break;
      }
    },
  };
}
