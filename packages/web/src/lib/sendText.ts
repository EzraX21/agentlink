import type { Message, Self } from '@agentlink/protocol';

/**
 * 发文本消息（含"乐观插入"）。
 *
 * ## 为什么需要这个模块
 *
 * 服务端会把 `message.new` **也推给发送者自己**（协议没禁止，而且多端/多标签页
 * 同步需要它：你在手机发的消息要在网页上出现）。于是客户端有两条到达路径：
 *
 *   1. 自己插入的**乐观消息**（本地 id `local_xxx`，为了即时反馈）
 *   2. 服务端推回来的 **message.new**（真实 id `m_xxx`）
 *
 * 两条 id 不同，按 id 去重去不掉 —— 用户就会看到同一条消息出现两次，
 * 刷新后（只走 history.fetch）又变回一条。这就是"发一条显示两次"的根因。
 *
 * ## 约定
 *
 * 服务端的 `message.send` 结果与 `message.new` 到达顺序**不确定**：
 *   - 事件先到：列表里已有 `m_xxx`，此时只需把 `local_xxx` 删掉
 *   - 结果先到：列表里只有 `local_xxx`，此时把它换成 `m_xxx`
 *
 * 两种顺序都收敛到"恰好一条 `m_xxx`"：
 *   先 `removeMessage(localId)`，再 `replaceMessage(真实消息)`（后者按 id 幂等）。
 */

export interface SendTextDeps {
  call<T>(op: string, data: unknown): Promise<T>;
  replaceMessage(convId: string, msg: Message): void;
  removeMessage(convId: string, messageId: string): void;
  setError(message: string | null): void;
  /** 生成 UUID（作为 client_msg_id，协议 §5.3 的幂等键）。 */
  uuid(): string;
  now(): number;
}

export interface SendTextInput {
  readonly convId: string;
  readonly self: Self | null;
  readonly text: string;
}

export interface SendTextResult {
  readonly messageId: string;
  readonly seq: number;
  readonly localId: string;
}

export async function sendText(
  deps: SendTextDeps,
  input: SendTextInput,
): Promise<SendTextResult | null> {
  const text = input.text.trim();
  if (text === '') return null;

  const localId = `local_${deps.uuid()}`;
  const createdAt = deps.now();
  const content = [{ type: 'text' as const, text }];

  // 1. 先本地显示，点击"发送"立刻有反馈
  deps.replaceMessage(input.convId, {
    id: localId,
    conv_id: input.convId,
    seq: null,
    sender: input.self ?? { id: '', kind: 'human', display_name: '我' },
    content,
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: createdAt,
    revoked_at: null,
  });

  try {
    // 2. 服务端确认（真实 id / seq）
    const res = await deps.call<{ message_id: string; seq: number; created_at: number }>(
      'message.send',
      { conv_id: input.convId, client_msg_id: deps.uuid(), content },
    );

    // 3. 让两条路径收敛成一条：先删掉占位，再放入权威消息
    deps.removeMessage(input.convId, localId);
    deps.replaceMessage(input.convId, {
      id: res.message_id,
      conv_id: input.convId,
      seq: res.seq,
      sender: input.self ?? { id: '', kind: 'human', display_name: '我' },
      content,
      reply_to: null,
      state: 'final',
      interrupted: false,
      created_at: res.created_at,
      revoked_at: null,
    });

    return { messageId: res.message_id, seq: res.seq, localId };
  } catch (err) {
    // 发送失败：把占位删掉，别让它假装发出去了
    deps.removeMessage(input.convId, localId);
    deps.setError(err instanceof Error ? err.message : '发送失败');
    return null;
  }
}