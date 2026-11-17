import { tokenizeRichText, type RichSegment } from '../lib/richtext.js';

/**
 * 消息正文渲染：URL / 行内代码 / 代码块 / 粗体。
 *
 * 只产出 React 文本节点与 `<a>`/`<code>` 元素，不拼 HTML 字符串 —— 见
 * lib/richtext.ts 顶部关于 XSS 的说明。
 */
export function RichText({ text }: { text: string }): React.JSX.Element {
  const segments = tokenizeRichText(text);
  return (
    <>
      {segments.map((seg, i) => (
        <Segment key={i} seg={seg} />
      ))}
    </>
  );
}

function Segment({ seg }: { seg: RichSegment }): React.JSX.Element {
  switch (seg.kind) {
    case 'url':
      return (
        <a
          href={seg.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--al-primary)', textDecoration: 'underline' }}
          onClick={(e) => {
            // 气泡本身有点击行为时不要冒泡（未来可能加"点开消息"）
            e.stopPropagation();
          }}
        >
          {seg.text}
        </a>
      );
    case 'code':
      return (
        <code
          style={{
            background: 'var(--al-bg-hover)',
            borderRadius: 4,
            padding: '0 4px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.92em',
          }}
        >
          {seg.text}
        </code>
      );
    case 'codeblock':
      return (
        <pre
          style={{
            background: 'var(--al-bg-hover)',
            borderRadius: 6,
            padding: '6px 8px',
            margin: '2px 0',
            overflowX: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.92em',
            whiteSpace: 'pre',
          }}
        >
          <code>{seg.text}</code>
        </pre>
      );
    case 'bold':
      return <strong>{seg.text}</strong>;
    case 'mention':
      // @提及：与主题色一致的高亮（TG 也会把 @ 提到的人标出来）
      return (
        <span
          className="al-mention"
          title="提及"
          style={{
            color: 'var(--al-primary)',
            background: 'color-mix(in srgb, var(--al-primary) 14%, transparent)',
            borderRadius: 4,
            padding: '0 3px',
            fontWeight: 500,
          }}
        >
          {seg.text}
        </span>
      );
    default:
      return <>{seg.text}</>;
  }
}