/**
 * 本地 UI 状态：草稿、未读、置顶。
 *
 * 为什么放 localStorage 而不是服务端：这三样都是**单设备的使用习惯**，
 * 协议里没有对应字段，加字段就得扩协议（施工守则 §6 要求先问）。
 * TG 桌面版也是本地存草稿与已读位置，所以这里保持纯客户端。
 * 键名带 `agentlink.` 前缀，清 token 时不动这些（换账号登录才会重置未读）。
 */

const DRAFT_PREFIX = 'agentlink.draft.';
const UNREAD_PREFIX = 'agentlink.unread.';
const PINNED_KEY = 'agentlink.pinned';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/配额满：静默失败，不影响聊天 */
  }
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

export function loadDraft(convId: string): string {
  return safeGet(`${DRAFT_PREFIX}${convId}`) ?? '';
}

export function saveDraft(convId: string, text: string): void {
  if (text === '') localStorage.removeItem(`${DRAFT_PREFIX}${convId}`);
  else safeSet(`${DRAFT_PREFIX}${convId}`, text);
}

export function clearDraft(convId: string): void {
  try {
    localStorage.removeItem(`${DRAFT_PREFIX}${convId}`);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 未读
// ---------------------------------------------------------------------------

export function loadUnread(): Record<string, number> {
  const raw = safeGet(UNREAD_PREFIX + 'all');
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveUnread(counts: Record<string, number>): void {
  safeSet(UNREAD_PREFIX + 'all', JSON.stringify(counts));
}

// ---------------------------------------------------------------------------
// 置顶（仅本地排序偏好）
// ---------------------------------------------------------------------------

export function loadPinned(): string[] {
  const raw = safeGet(PINNED_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function savePinned(ids: string[]): void {
  safeSet(PINNED_KEY, JSON.stringify(ids));
}

/** 置顶的排前面，其余保持原顺序（稳定排序）。 */
export function orderByPinned<T extends { id: string }>(items: T[], pinned: readonly string[]): T[] {
  if (pinned.length === 0) return items;
  const set = new Set(pinned);
  const top = items.filter((i) => set.has(i.id));
  const rest = items.filter((i) => !set.has(i.id));
  return [...top, ...rest];
}