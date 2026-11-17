/**
 * 消息正文的轻量富文本解析（URL、行内代码、代码块、粗体）。
 *
 * ## 为什么不用 `dangerouslySetInnerHTML`
 *
 * 消息正文是任意用户输入。哪怕只在客户端"渲染一下"，一旦走 innerHTML，
 * `<img src=x onerror=...>` 就能执行脚本（搜索结果那边已经踩过这个坑，
 * 见 docs/DECISIONS.md）。所以这里**只产出结构化片段**，由 React 逐段渲染文本节点，
 * 链接用 `<a>`、代码用 `<code>`，不拼接任何 HTML 字符串。
 *
 * ## 支持什么
 *
 * | 写法 | 渲染 |
 * |---|---|
 * | `https://example.com` | 可点击链接（`target=_blank` + `rel=noopener`） |
 * | `` `inline` `` | 等宽行内代码 |
 * | ``` 三反引号 ``` | 代码块（保留换行） |
 * | `**粗体**` | 加粗 |
 *
 * 刻意**不做**斜体：单个 `*` 在日常文本里太常见（`2*3*4`、文件名），
 * 误判比收益大。需求确认书也把富文本编辑器列在"明确不做"里 ——
 * 这里只做"渲染"，不做编辑。
 */

export type RichSegment =
  | { kind: 'text'; text: string }
  | { kind: 'url'; text: string; href: string }
  | { kind: 'code'; text: string }
  | { kind: 'codeblock'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'mention'; text: string };

/** URL 到这些前缀才认为是链接，避免把 `javascript:` 变成可点链接。 */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** 一段可能含 URL 的纯文本 → 文本/链接片段。 */
function splitUrls(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  // 粗匹配：http(s):// 或 www. 开头，到空白或常见收尾标点为止
  const re = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const raw = m[1] ?? '';
    // 去掉尾部的句读，避免把 "看这个 https://a.com。" 里的句号算进链接
    const trimmed = raw.replace(/[.,;:!?)\]}，。；：！？）】」』]+$/u, '');
    if (trimmed === '') continue;
    const start = m.index;
    if (start > last) {
      for (const seg of splitMentions(text.slice(last, start))) out.push(seg);
    }
    const href = SAFE_URL.test(trimmed)
      ? trimmed
      : `https://${trimmed.replace(/^www\./i, 'www.')}`;
    out.push({ kind: 'url', text: trimmed, href });
    last = start + trimmed.length;
    // 被裁掉的尾部标点回到后续文本
    re.lastIndex = last;
  }
  if (last < text.length) {
    for (const seg of splitMentions(text.slice(last))) out.push(seg);
  }
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/**
 * 提及：`@echo`、`@小明`、`@u_01J...`。
 *
 * 前面不能是邮箱那么紧的字符（`a@b.com` 里的 `@b` 不算提及），
 * 所以用"前面是行首或非字母数字"来限定。长度限制避免把整段话吞掉。
 */
const MENTION = /(^|[^A-Za-z0-9._%+-])@([A-Za-z0-9_\-.\u4e00-\u9fa5]{1,32})/gu;

function splitMentions(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  let last = 0;
  for (let m = MENTION.exec(text); m !== null; m = MENTION.exec(text)) {
    const prefix = m[1] ?? '';
    const name = m[2] ?? '';
    const at = m.index + prefix.length;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'mention', text: `@${name}` });
    last = at + name.length + 1;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/** 行内：`code` 与 **bold**。 */
function splitInline(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    if (start > last) {
      for (const seg of splitUrls(text.slice(last, start))) out.push(seg);
    }
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else out.push({ kind: 'bold', text: m[2] ?? '' });
    last = start + m[0].length;
  }
  if (last < text.length) {
    for (const seg of splitUrls(text.slice(last))) out.push(seg);
  }
  return out;
}

/** 整段文本 → 片段序列（含代码块）。 */
export function tokenizeRichText(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  // 代码块：```lang\n...\n``` 或 ```...```
  const re = /```[^\n`]*\n?([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(...splitInline(text.slice(last, m.index)));
    out.push({ kind: 'codeblock', text: (m[1] ?? '').replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...splitInline(text.slice(last)));
  return out;
}

/** 纯文本化（复制到剪贴板时用，去掉标记但保留内容）。 */
export function richTextToPlain(segments: RichSegment[]): string {
  return segments.map((s) => s.text).join('');
}