import type {
  Conversation,
  EvtFrame,
  Member,
  Message,
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
  setStreamingText(convId: string, messageId: string, text: string, rev: number): void;
  clearStreaming(messageId: string): void;
  handleEvent(evt: EvtFrame): void;
  setTheme(theme: 'light' | 'dark'): void;
  setConnected(v: boolean): void;
  setError(msg: string | null): void;
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
      const merged = sortBySeq(dedupe([...messages, ...existing]));
      set({ messages: { ...get().messages, [convId]: merged.slice(-MAX_MESSAGES_PER_CONV) } });
    },
    addMessage: (msg) => {
      const existing = get().messages[msg.conv_id] ?? [];
      if (existing.some((m) => m.id === msg.id)) return;
      set({
        messages: {
          ...get().messages,
          [msg.conv_id]: sortBySeq([...existing, msg]).slice(-MAX_MESSAGES_PER_CONV),
        },
      });
    },
    replaceMessage: (convId, msg) => {
      const existing = get().messages[convId] ?? [];
      const next = existing.some((m) => m.id === msg.id)
        ? existing.map((m) => (m.id === msg.id ? msg : m))
        : [...existing, msg];
      set({ messages: { ...get().messages, [convId]: sortBySeq(next) } });
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

    /** 所有实时事件的唯一入口（未知 type 静默忽略，协议 §6）。 */
    handleEvent: (evt) => {
      const store = get();
      switch (evt.type) {
        case 'message.new': {
          const data = evt.data as { conv_id: string; message: Message };
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
          store.upsertMember(data.conv_id, data.member);
          break;
        }
        case 'member.leave': {
          const data = evt.data as { conv_id: string; user_id: string };
          store.removeMember(data.conv_id, data.user_id);
          break;
        }
        case 'member.update': {
          const data = evt.data as { conv_id: string; member: Member };
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
