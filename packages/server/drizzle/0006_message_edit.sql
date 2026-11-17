-- migration 0006: 编辑消息（协议扩展 §3，见 docs/PROPOSAL-protocol-ext.md §3）
--
-- 只记"什么时候被编辑过"，**不做编辑历史** —— 需求确认书 §5 明确把
-- "消息编辑历史"列在不做清单里。所以一列 edited_at 就够。
--
-- 编辑会更新 messages.text_plain，而 0002 的 trg_messages_au 触发器在 UPDATE 时
-- 会先删旧词条再插新词 —— 全文索引自动重建，不需要额外处理（但必须验：
-- 旧关键词要搜不到、新关键词要搜得到）。

ALTER TABLE messages ADD COLUMN edited_at INTEGER;
