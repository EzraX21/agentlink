-- migration 0007: 置顶消息（协议扩展 §4，见 docs/PROPOSAL-protocol-ext.md §4）
--
-- v1 只做**单条置顶**（TG 桌面版的默认行为）：一列 pinned_message_id 就够。
-- 多条置顶需要独立的 pinned_messages 表，需求里没要求，留到以后。
--
-- 不做外键：消息被删（空流撤回）后这里可能指向不存在的行，
-- 读取时用 LEFT JOIN 过滤即可，比 ON DELETE SET NULL 更不容易出现迁移期锁表。

ALTER TABLE conversations ADD COLUMN pinned_message_id TEXT;
