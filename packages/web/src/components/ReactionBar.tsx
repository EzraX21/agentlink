import { useState } from 'react';
import type { ReactionSummary } from '@agentlink/protocol';

/**
 * 表情回应（协议扩展 §2）。
 *
 * 交互与 Telegram 一致：
 *   - 气泡下方显示 chip（emoji + 人数），自己点过的用主色描边
 *   - 点 chip = 切换自己的回应（服务端按 (消息, 人, emoji) 去重，重复点就是取消）
 *   - 点「＋」展开一个小面板选表情
 *
 * 只做"常用一组"而不是全量 emoji 选择器：这是聊天工具，不是表情键盘。
 * 服务端只校验"是单个 emoji"，所以以后想放开成任意 emoji 也不用改协议。
 */

/** 常用表情（与 TG 的快捷回应接近）。 */
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '🙏'] as const;

export function ReactionBar({
  reactions,
  selfId,
  onToggle,
}: {
  reactions: readonly ReactionSummary[] | undefined;
  selfId: string;
  onToggle: (emoji: string) => void;
}): React.JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  const list = reactions ?? [];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {list.map((r) => {
        const mine = r.user_ids.includes(selfId);
        return (
          <button
            key={r.emoji}
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]"
            style={{
              background: mine
                ? 'color-mix(in srgb, var(--al-primary) 18%, transparent)'
                : 'var(--al-bg-hover)',
              border: `1px solid ${mine ? 'var(--al-primary)' : 'var(--al-border)'}`,
            }}
            onClick={() => onToggle(r.emoji)}
            title={mine ? '取消回应' : '回应'}
            aria-label={`${r.emoji} ${r.user_ids.length} 人${mine ? '（含我）' : ''}`}
            aria-pressed={mine}
          >
            <span>{r.emoji}</span>
            <span className="al-muted">{r.user_ids.length}</span>
          </button>
        );
      })}

      {/* 「＋」默认隐藏，鼠标移到气泡上才出现 —— 否则每条消息下面都挂一个按钮，太吵 */}
      <div className="relative opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          className="rounded-full px-1.5 py-0.5 text-[11px]"
          style={{ background: 'var(--al-bg-hover)', border: '1px solid var(--al-border)' }}
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="添加表情回应"
          title="添加表情回应"
        >
          ＋
        </button>

        {pickerOpen && (
          <div
            className="absolute bottom-full left-0 z-10 mb-1 flex gap-1 rounded-lg p-1"
            style={{
              background: 'var(--al-bg-sidebar)',
              border: '1px solid var(--al-border)',
              boxShadow: '0 6px 18px rgb(0 0 0 / 18%)',
            }}
            role="menu"
            aria-label="选择表情"
          >
            {QUICK_EMOJI.map((emoji) => (
              <button
                key={emoji}
                className="rounded px-1 py-0.5 text-base hover:bg-[var(--al-bg-hover)]"
                onClick={() => {
                  onToggle(emoji);
                  setPickerOpen(false);
                }}
                aria-label={`回应 ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}