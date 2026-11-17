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
  /**
   * 当前连接是否可用。不可用时**不尝试发送**，直接进离线发件箱，
   * 避免"点了发送先等 10 秒超时再失败"。
   */
  isOnline?(): boolean;
  /**
   * 断线时的兜底：把消息放进发件箱，等连接恢复后按同一个 client_msg_id 重发。
   * 提供它就等于启用离线队列；不提供则断线发送直接失败（旧行为）。
   */
  onOffline?: (entry: {
    localId: string;
    convId: string;
    clientMsgId: string;
    content: unknown;
    replyTo: string | null;
    createdAt: number;
  }) => void;
}

export interface SendTextInput {
  readonly convId: string;
  readonly self: Self | null;
  readonly text: string;
  /** 引用回复：被引用消息 id（协议 §5.3 的 reply_to）。 */
  readonly replyTo?: string | undefined;
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
  // 幂等键只生成一次：断线重发必须原样复用（协议 §5.3）
  const clientMsgId = deps.uuid();
  const createdAt = deps.now();
  const content = [{ type: 'text' as const, text }];

  /** 断线：保留本地气泡（标"待发送"），进发件箱，不等超时。 */
  const goOffline = (): SendTextResult | null => {
    if (deps.onOffline === undefined) {
      deps.removeMessage(input.convId, localId);
      deps.setError('连接已断开，消息未发出');
      return null;
    }
    deps.onOffline({
      localId,
      convId: input.convId,
      clientMsgId,
      content,
      replyTo: input.replyTo ?? null,
      createdAt,
    });
    deps.setError(null);
    return { messageId: localId, seq: -1, localId };
  };

  // 1. 先本地显示，点击"发送"立刻有反馈
  deps.replaceMessage(input.convId, {
    id: localId,
    conv_id: input.convId,
    seq: null,
    sender: input.self ?? { id: '', kind: 'human', display_name: '我' },
    content,
    reply_to: input.replyTo ?? null,
    state: 'final',
    interrupted: false,
    created_at: createdAt,
    revoked_at: null,
  });

  // 2. 断线就不必去撞 10 秒超时：直接进发件箱，气泡保留并标记"待发送"
  if (deps.isOnline !== undefined && !deps.isOnline()) {
    return goOffline();
  }

  try {
    // 3. 服务端确认（真实 id / seq）
    const res = await deps.call<{ message_id: string; seq: number; created_at: number }>(
      'message.send',
      {
        conv_id: input.convId,
        client_msg_id: clientMsgId,
        content,
        ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
      },
    );

    // 4. 让两条路径收敛成一条：先删掉占位，再放入权威消息
    deps.removeMessage(input.convId, localId);
    deps.replaceMessage(input.convId, {
      id: res.message_id,
      conv_id: input.convId,
      seq: res.seq,
      sender: input.self ?? { id: '', kind: 'human', display_name: '我' },
      content,
      reply_to: input.replyTo ?? null,
      state: 'final',
      interrupted: false,
      created_at: res.created_at,
      revoked_at: null,
    });

    return { messageId: res.message_id, seq: res.seq, localId };
  } catch (err) {
    // 连接断了导致的失败 → 进离线队列（而不是把用户刚写的字丢掉）
    const message = err instanceof Error ? err.message : '发送失败';
    if (deps.onOffline !== undefined && /连接未建立|连接已关闭|超时|网络|WebSocket/i.test(message)) {
      return goOffline();
    }
    // 其它失败（权限、校验）确实发不出去：删占位，别让它假装发出去了
    deps.removeMessage(input.convId, localId);
    deps.setError(message);
    return null;
  }
}