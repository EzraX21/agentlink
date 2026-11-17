/**
 * 渲染服务端给的检索片段（协议 §5.7：命中词用 `<mark>` 包裹）。
 *
 * **不用 dangerouslySetInnerHTML**：excerpt 是"消息原文 + <mark> 标签"，
 * 而消息原文是任意用户输入。直接当 HTML 插进去就是 XSS —— 有人发一条
 * `<img src=x onerror=...>` 就能在别人的浏览器里执行脚本。
 *
 * 这里按 `<mark>` 切成片段、逐段用 React 文本节点渲染：标签以外的字符
 * 一律当纯文本，不存在注入面。
 *
 * 单独成文件的另一个原因：SearchPanel 与 AdminPage 都需要它，
 * 放在 SearchPanel 里会让 Rollup 把整个 SearchPanel 提升回主 bundle，
 * 按需加载就失效了。
 */
export function Excerpt({ text }: { text: string }): React.JSX.Element {
  const parts: Array<{ text: string; hit: boolean }> = [];
  const re = /<mark>(.*?)<\/mark>/gs;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[1] ?? '', hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });

  return (
    <div>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="al-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}
