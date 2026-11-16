/**
 * M6 探针：在 Node 里直接驱动 Web 客户端的真实 store 逻辑。
 *
 * 为什么要探针而不是浏览器自动化：验收要能无人值守重跑，而且这里要验证的是
 * **状态逻辑**（流式 rev 拼接、撤回、成员增删、1000 条的规模），不是像素。
 * store.ts 不依赖 React，可以独立跑。
 *
 * 输出一行 JSON，由 m6.mjs 断言。
 */
import { createChatStore, type ChatState } from '../../packages/web/src/lib/store.js';
import type { EvtFrame, Message } from '@agentlink/protocol';

// 最小 localStorage 桩（store 只用它记主题）
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

let state: ChatState;
const set = (partial: Partial<ChatState>): void => {
  state = { ...state, ...partial };
};
const get = (): ChatState => state;
state = createChatStore(set, get);

function evt(type: string, seq: number | null, data: unknown): EvtFrame {
  return { v: 1, kind: 'evt', type, seq, ts: Date.now(), data };
}

function msg(id: string, convId: string, seq: number | null, text: string, senderId = 'u_a', state_ = 'final'): Message {
  return {
    id,
    conv_id: convId,
    seq,
    sender: { id: senderId, kind: senderId === 'u_a' ? 'human' : 'agent', display_name: senderId },
    content: [{ type: 'text', text }],
    reply_to: null,
    state: state_ as Message['state'],
    interrupted: false,
    created_at: Date.now(),
    revoked_at: null,
  };
}

const results: Record<string, unknown> = {};

// --- 1. 普通消息与去重 ---
state.handleEvent(evt('message.new', 1, { conv_id: 'c1', message: msg('m1', 'c1', 1, '你好') }));
state.handleEvent(evt('message.new', 1, { conv_id: 'c1', message: msg('m1', 'c1', 1, '你好') }));
results.afterNew = (state.messages['c1'] ?? []).length;

// --- 2. 流式：message.new(streaming) → 3 个 update → final ---
state.handleEvent(
  evt('message.new', null, { conv_id: 'c1', message: msg('m2', 'c1', null, '', 'u_agent', 'streaming') }),
);
results.streamingStarted = state.streaming['m2']?.text ?? null;
state.handleEvent(evt('message.update', null, { conv_id: 'c1', message_id: 'm2', rev: 1, delta: '你' }));
state.handleEvent(evt('message.update', null, { conv_id: 'c1', message_id: 'm2', rev: 2, delta: '好' }));
state.handleEvent(evt('message.update', null, { conv_id: 'c1', message_id: 'm2', rev: 3, delta: '呀' }));
results.streamedText = state.streaming['m2']?.text ?? null;
results.streamedRev = state.streaming['m2']?.rev ?? null;

// 逐字增长的中间态（客户端渲染依赖它）
const growth: number[] = [];
for (const delta of ['A', 'B', 'C']) {
  state.handleEvent(evt('message.update', null, { conv_id: 'c1', message_id: 'm2', rev: (state.streaming['m2']?.rev ?? 0) + 1, delta }));
  growth.push((state.streaming['m2']?.text ?? '').length);
}
results.growth = growth;

state.handleEvent(
  evt('message.final', 3, { conv_id: 'c1', message: msg('m2', 'c1', 3, '你好呀ABC', 'u_agent') }),
);
results.streamingCleared = state.streaming['m2'] === undefined;
results.finalText = (state.messages['c1'] ?? []).find((m) => m.id === 'm2')?.content[0]?.text ?? null;

// --- 3. rev 跳变后的重置（客户端收到 message.get 结果后调 setStreamingText） ---
state.handleEvent(
  evt('message.new', null, { conv_id: 'c1', message: msg('m3', 'c1', null, '', 'u_agent', 'streaming') }),
);
state.handleEvent(evt('message.update', null, { conv_id: 'c1', message_id: 'm3', rev: 1, delta: 'A' }));
// 模拟客户端发现 rev 跳变后拿到完整文本
state.setStreamingText('c1', 'm3', 'ABC', 3);
results.afterResync = state.streaming['m3']?.text ?? null;
results.afterResyncRev = state.streaming['m3']?.rev ?? null;

// --- 4. 撤回 ---
state.handleEvent(evt('message.revoke', 4, { conv_id: 'c1', message_id: 'm1', by: 'u_a' }));
results.revokedState = (state.messages['c1'] ?? []).find((m) => m.id === 'm1')?.state ?? null;

// --- 5. 未知 evt.type 必须忽略且不报错 ---
let threw = false;
try {
  state.handleEvent(evt('some.future.event', null, { whatever: true }));
} catch {
  threw = true;
}
results.unknownIgnored = !threw;

// --- 6. 成员增删（成员面板"踢人后立即消失"） ---
const member = (userId: string): unknown => ({
  conv_id: 'c1',
  user_id: userId,
  role: 'member',
  is_agent: false,
  muted_until: 0,
  joined_at: Date.now(),
  user: { id: userId, kind: 'human', display_name: userId },
});
state.setMembers('c1', [member('u_a'), member('u_b')] as never);
state.handleEvent(evt('member.leave', 5, { conv_id: 'c1', user_id: 'u_b', reason: 'kicked' }));
results.membersAfterKick = (state.members['c1'] ?? []).map((m) => m.user_id);

// --- 7. 1000 条消息的规模 ---
const bulk: Message[] = [];
for (let i = 0; i < 1000; i += 1) {
  bulk.push(msg(`bulk${i}`, 'c2', i + 1, `消息 ${i}`));
}
const t0 = performance.now();
state.setMessages('c2', bulk);
const insertMs = performance.now() - t0;
results.bulkCount = (state.messages['c2'] ?? []).length;
results.bulkInsertMs = Math.round(insertMs * 100) / 100;
results.bulkOrdered =
  (state.messages['c2'] ?? []).every((m, i, arr) => i === 0 || (m.seq ?? 0) > (arr[i - 1]?.seq ?? 0));

// --- 8. 会话 upsert 与主题 ---
state.setConvs([
  { id: 'c1', kind: 'group', title: 'A', announcement: '', created_by: 'u_a', created_at: Date.now() },
]);
state.upsertConv({
  id: 'c2',
  kind: 'group',
  title: 'B',
  announcement: '',
  created_by: 'u_a',
  created_at: Date.now(),
});
results.convOrder = state.convs.map((c) => c.id);
state.setTheme('dark');
results.theme = state.theme;

process.stdout.write(`${JSON.stringify(results)}\n`);