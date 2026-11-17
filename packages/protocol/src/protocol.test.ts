import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  EVENTS,
  EVT_TYPES,
  MAX_FRAME_BYTES,
  OPS,
  OP_NAMES,
  PERSISTED_EVT_TYPES,
  PROTOCOL_VERSION,
  RATE_LIMITS,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_INTERVAL_MS,
  STREAM_IDLE_TIMEOUT_MS,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  WS_SUBPROTOCOL,
  isKnownEvtType,
  isKnownOp,
  isPersistedEvtType,
  makeEvt,
  makeResErr,
  makeResOk,
  parseEvtData,
  parseOpData,
  parseReqFrame,
} from '../src/index.js';

/**
 * 协议包的自测。它是最重要的一个包，错了整个项目就没有一致的事实来源（需求确认书 §8.3）。
 */

describe('帧信封', () => {
  it('接受合法的 req 帧', () => {
    const r = parseReqFrame({ v: 1, kind: 'req', id: 'r1', op: 'ping', data: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frame.op).toBe('ping');
      expect(r.frame.id).toBe('r1');
    }
  });

  it('data 可以省略（协议 §3.1 缺省为 {}）', () => {
    const r = parseReqFrame({ v: 1, kind: 'req', id: 'r1', op: 'conv.list' });
    expect(r.ok).toBe(true);
  });

  it('版本不是 1 → reason=version', () => {
    const r = parseReqFrame({ v: 2, kind: 'req', id: 'r1', op: 'ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('version');
      expect(r.got).toBe(2);
    }
  });

  it('kind=evt 不是客户端该发的 → reason=shape', () => {
    const r = parseReqFrame({ v: 1, kind: 'evt', type: 'x', seq: null, ts: 1, data: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('shape');
  });

  it('缺 op 或 id → reason=shape，且尽量把 id 带回去', () => {
    expect(parseReqFrame({ v: 1, kind: 'req', id: 'r9' }).ok).toBe(false);
    const r = parseReqFrame({ v: 1, kind: 'req', id: 'r9' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.id).toBe('r9');
  });

  it('res/evt 构造函数带正确信封字段', () => {
    const ok = makeResOk('r1', { x: 1 });
    expect(ok.kind).toBe('res');
    expect(ok.v).toBe(PROTOCOL_VERSION);
    expect(ok.ok).toBe(true);

    const err = makeResErr('r1', { code: 'NOT_FOUND', message: '没有' });
    expect(err.ok).toBe(false);

    const evt = makeEvt('typing', null, 123, { conv_id: 'c' });
    expect(evt.kind).toBe('evt');
    expect(evt.seq).toBeNull();
    expect(evt.ts).toBe(123);
  });

  it('单帧上限是 1 MiB（协议 §1）', () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  it('WS 子协议标识是 agentlink.v1（施工守则 §7）', () => {
    expect(WS_SUBPROTOCOL).toBe('agentlink.v1');
  });
});

describe('op 注册表', () => {
  it('覆盖协议 §5 列出的全部 op（含已批准的扩展 op）', () => {
    const expected = [
      'auth',
      'resume',
      'subscribe.set',
      'ping',
      'conv.list',
      'conv.create',
      'conv.get',
      'group.update',
      'message.send',
      'message.get',
      'message.revoke',
      'history.fetch',
      'context.fetch',
      'stream.begin',
      'stream.delta',
      'stream.commit',
      'stream.abort',
      'stream.interrupt',
      'member.invite',
      'member.kick',
      'member.mute',
      'member.role.set',
      'poke.send',
      'search.messages',
      // 协议扩展（施工守则 §6.3：经用户批准后新增）
      // 见 docs/PROPOSAL-protocol-ext.md
      'typing.send',
      'read.set',
      'reaction.add',
      'reaction.remove',
    ];
    expect([...OP_NAMES].sort()).toEqual([...expected].sort());
    expect(OP_NAMES.length).toBe(28);
  });

  it('typing.send 只需要 conv_id，且常量与事件对齐', () => {
    const ok = parseOpData('typing.send', { conv_id: 'c_01M7JD0000000000000000000A' });
    expect(ok.success).toBe(true);
    expect(parseOpData('typing.send', {}).success).toBe(false);
    // 事件侧：typing 是瞬时事件（seq=false），不落库不补发
    expect(EVENTS.typing.seq).toBe(false);
    expect(TYPING_TTL_MS).toBeGreaterThan(TYPING_THROTTLE_MS);
  });

  it('message.send 要求 content 是块数组且 client_msg_id 必填', () => {
    const ok = parseOpData('message.send', {
      conv_id: 'c_01M7JD0000000000000000000A',
      client_msg_id: 'abc',
      content: [{ type: 'text', text: '你好' }],
    });
    expect(ok.success).toBe(true);

    const missingId = parseOpData('message.send', {
      conv_id: 'c_01M7JD0000000000000000000A',
      content: [{ type: 'text', text: '你好' }],
    });
    expect(missingId.success).toBe(false);
  });

  it('text 块上限 8000 字符、单条最多 20 块（协议 §5.3）', () => {
    const long = parseOpData('message.send', {
      conv_id: 'c_01M7JD0000000000000000000A',
      client_msg_id: 'a',
      content: [{ type: 'text', text: 'x'.repeat(8001) }],
    });
    expect(long.success).toBe(false);

    const many = parseOpData('message.send', {
      conv_id: 'c_01M7JD0000000000000000000A',
      client_msg_id: 'a',
      content: Array.from({ length: 21 }, () => ({ type: 'text', text: 'x' })),
    });
    expect(many.success).toBe(false);
  });

  it('history.fetch 的 limit 上限 100（协议 §5.3）', () => {
    const ok = parseOpData('history.fetch', {
      conv_id: 'c_01M7JD0000000000000000000A',
      limit: 100,
    });
    expect(ok.success).toBe(true);
    const tooBig = parseOpData('history.fetch', {
      conv_id: 'c_01M7JD0000000000000000000A',
      limit: 101,
    });
    expect(tooBig.success).toBe(false);
  });

  it('context.fetch 的 before/after 上限 100（协议 §7）', () => {
    expect(
      parseOpData('context.fetch', {
        conv_id: 'c_01M7JD0000000000000000000A',
        before: 100,
        after: 100,
      }).success,
    ).toBe(true);
    expect(
      parseOpData('context.fetch', {
        conv_id: 'c_01M7JD0000000000000000000A',
        before: 101,
      }).success,
    ).toBe(false);
  });

  it('subscribe.set 的三个过滤字段都可省略（协议 §5.6）', () => {
    expect(parseOpData('subscribe.set', { filters: {} }).success).toBe(true);
    expect(
      parseOpData('subscribe.set', { filters: { only_mentions: true } }).success,
    ).toBe(true);
  });

  it('agent token 与 conv_id 走 ID 格式校验', () => {
    expect(parseOpData('auth', { token: 'ag_u_xx_secret' }).success).toBe(true);
    expect(parseOpData('conv.get', { conv_id: 'not-an-id' }).success).toBe(false);
  });

  it('所有 op 都同时定义了入参与出参 schema', () => {
    for (const op of OP_NAMES) {
      expect(OPS[op].req).toBeDefined();
      expect(OPS[op].res).toBeDefined();
    }
  });

  it('isKnownOp 对未知 op 返回 false（协议 §12 → UNSUPPORTED_OP）', () => {
    expect(isKnownOp('ping')).toBe(true);
    expect(isKnownOp('nope')).toBe(false);
  });
});

describe('事件注册表', () => {
  it('覆盖协议 §6 列出的全部 evt', () => {
    expect([...EVT_TYPES].sort()).toEqual(
      [
        'message.new',
        'message.update',
        'message.final',
        'message.revoke',
        'member.join',
        'member.leave',
        'member.update',
        'group.update',
        'typing',
        'poke',
        // 协议扩展 §5（经批准）：已读水位是瞬时事件
        'read.update',
        // 协议扩展 §2：表情回应是**状态**，带 seq 可补发
        'message.reaction',
      ].sort(),
    );
  });

  it('typing / poke / read.update 是瞬时事件（seq=null，不落库）', () => {
    expect([...PERSISTED_EVT_TYPES].sort()).toEqual(
      [
        'message.new',
        'message.final',
        'message.revoke',
        'member.join',
        'member.leave',
        'member.update',
        'group.update',
        // 协议扩展 §2：回应是状态，必须能补发
        'message.reaction',
      ].sort(),
    );
    expect(EVENTS.typing.seq).toBe(false);
    expect(EVENTS.poke.seq).toBe(false);
    expect(EVENTS['message.update'].seq).toBe(false);
    expect(EVENTS['read.update'].seq).toBe(false);
    expect(EVENTS['message.new'].seq).toBe(true);
    expect(EVENTS['message.reaction'].seq).toBe(true);
  });

  it('isPersistedEvtType 拒绝瞬时事件', () => {
    expect(isPersistedEvtType('message.new')).toBe(true);
    expect(isPersistedEvtType('typing')).toBe(false);
    expect(isPersistedEvtType('unknown')).toBe(false);
  });

  it('isKnownEvtType 用于前向兼容（未知 type 忽略）', () => {
    expect(isKnownEvtType('message.new')).toBe(true);
    expect(isKnownEvtType('some.future.event')).toBe(false);
  });

  it('message.update 的 payload 必须带 rev 与 delta', () => {
    const ok = parseEvtData('message.update', {
      conv_id: 'c_01M7JD0000000000000000000A',
      message_id: 'm_01M7JD0000000000000000000A',
      rev: 1,
      delta: '你',
    });
    expect(ok.success).toBe(true);

    const missingRev = parseEvtData('message.update', {
      conv_id: 'c_01M7JD0000000000000000000A',
      message_id: 'm_01M7JD0000000000000000000A',
      delta: '你',
    });
    expect(missingRev.success).toBe(false);
  });
});

describe('错误码与配额（协议 §9 / §11）', () => {
  it('12 个错误码齐全', () => {
    expect(ERROR_CODES.length).toBe(12);
    expect(ERROR_CODES).toContain('STREAM_CLOSED');
    expect(ERROR_CODES).toContain('PAYLOAD_TOO_LARGE');
    expect(ERROR_CODES).toContain('RATE_LIMITED');
  });

  it('限流配额与协议 §11 的字面值一致', () => {
    expect(RATE_LIMITS.message_send).toEqual({ limit: 30, window_ms: 60_000 });
    expect(RATE_LIMITS.stream_delta).toEqual({ limit: 200, window_ms: 60_000 });
    expect(RATE_LIMITS.search).toEqual({ limit: 20, window_ms: 60_000 });
    expect(RATE_LIMITS.stream_begin).toEqual({ limit: 5, window_ms: 60_000 });
  });

  it('流式常量与协议 §8.3 / §8.5 一致', () => {
    expect(STREAM_FLUSH_INTERVAL_MS).toBe(500);
    expect(STREAM_FLUSH_CHARS).toBe(512);
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(60_000);
  });
});

describe('表情回应（协议扩展 §2）', () => {
  it('emoji 只接受单个表情，拒绝任意字符串', () => {
    const okData = {
      conv_id: 'c_01M7JD0000000000000000000A',
      message_id: 'm_01M7JD0000000000000000000A',
      emoji: '👍',
    };
    expect(parseOpData('reaction.add', okData).success).toBe(true);
    expect(parseOpData('reaction.add', { ...okData, emoji: '点赞' }).success).toBe(false);
    expect(parseOpData('reaction.add', { ...okData, emoji: '👍👍👍' }).success).toBe(false);
    // 带 ZWJ / 肤色的组合表情应当接受
    expect(parseOpData('reaction.add', { ...okData, emoji: '👨‍👩‍👧' }).success).toBe(true);
    expect(parseOpData('reaction.add', { ...okData, emoji: '👍🏽' }).success).toBe(true);
  });
});
