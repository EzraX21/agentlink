/**
 * 「正在输入」的发送侧。
 *
 * ## 为什么客户端先发一个可能不存在的 op
 *
 * 协议 §6 早就定义了 `typing` 事件，但 §5 的 op 清单里**没有**触发它的 op
 * （这是规格的空白，属于需要审批的协议变更，见 docs/PROPOSAL-protocol-ext.md）。
 *
 * 协议 §12 规定：未知 op → `UNSUPPORTED_OP` 且**不断开连接**，
 * 客户端应"视为服务端版本较旧，降级"。这正是这里用的机制：
 *
 *   - 服务端将来支持 `typing.send` → 打字提示立刻生效，客户端零改动；
 *   - 现在不支持 → 收到 `UNSUPPORTED_OP`，**永久停用**发送（不再打扰服务端），
 *     用户看到的只是"没有打字提示"，不影响任何其它功能。
 *
 * 这样既不新增协议，也不做无用的重复请求。
 */

const THROTTLE_MS = 2000;

/** 服务端是否支持 typing.send：null=未知，false=已确认不支持。 */
let supported: boolean | null = null;
/** 每个会话上次发送时间。 */
const lastSentAt = new Map<string, number>();

/**
 * 只需要"能发一个 op"的能力。
 * 返回值不用，所以刻意收窄成 `Promise<unknown>`：这样测试里的简单 mock 也能满足，
 * 不需要为了类型去伪造泛型。
 */
export interface TypingSender {
  call(op: string, data: unknown): Promise<unknown>;
}

/** 是否已确认服务端不支持（供 UI/测试断言）。 */
export function typingSupported(): boolean | null {
  return supported;
}

export function resetTypingCapability(): void {
  supported = null;
  lastSentAt.clear();
}

/**
 * 上报"我在这个会话里打字"。内部节流，可以安全地在每次按键时调用。
 * 永不抛错：打字指示是尽力而为的信号。
 */
export async function reportTyping(
  client: TypingSender,
  convId: string,
  now: number = Date.now(),
): Promise<void> {
  if (supported === false) return;
  const last = lastSentAt.get(convId);
  // 注意：没有"上次发送时间"时（第一次）必须立刻发。
  // 早先写成 `?? 0` 会让 now - 0 < 2000 恒成立，第一次打字永远被吞掉。
  if (last !== undefined && now - last < THROTTLE_MS) return;
  lastSentAt.set(convId, now);

  try {
    await client.call('typing.send', { conv_id: convId });
    supported = true;
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
    if (code === 'UNSUPPORTED_OP') {
      // 服务端还不支持：停掉，别每 2 秒撞一次
      supported = false;
    }
    // 其它错误（断线等）也只影响这一次，下次再试
  }
}

/** 从 store 的 typing 记录里算出"谁正在输入"（3 秒内有效，排除自己）。 */
export function whoIsTyping(
  typing: Record<string, number>,
  convId: string,
  selfId: string,
  names: Map<string, string>,
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  for (const [key, ts] of Object.entries(typing)) {
    const [cid, userId] = key.split(':');
    if (cid !== convId || userId === undefined || userId === selfId) continue;
    if (now - ts > 3000) continue;
    out.push(names.get(userId) ?? userId);
  }
  return out;
}
