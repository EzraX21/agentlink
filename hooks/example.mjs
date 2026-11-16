/**
 * 示例钩子（M11 验收用）。
 *
 * 验收要求（实现计划 M11）：
 *   1. 钩子把消息里的 `foo` 改写成 `bar`，客户端收到的是 `bar`
 *   2. 钩子返回 null，消息不入库、不推送
 *
 * 这里用两个环境变量控制，方便验收脚本直接驱动：
 *   - 固定行为：onMessageOut 把 text 块里的 foo → bar
 *   - onMessageIn 里丢弃包含 `[[DROP]]` 的消息
 *
 * 真实插件可以在这里做敏感词过滤、命令解析、消息转发等。
 */

/** @type {import('../../packages/server/src/hooks.js').HookModule} */
export const onMessageIn = (msg) => {
  const text = msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
  if (text.includes('[[DROP]]')) {
    // 返回 null：服务端不入库、不推送
    return null;
  }
  return msg;
};

export const onMessageOut = (msg) => {
  return {
    ...msg,
    content: msg.content.map((block) =>
      block.type === 'text'
        ? { ...block, text: block.text.replaceAll('foo', 'bar') }
        : block,
    ),
  };
};