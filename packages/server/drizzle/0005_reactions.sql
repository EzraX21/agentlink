-- migration 0005: 表情回应（协议扩展 §2，见 docs/PROPOSAL-protocol-ext.md §2）
--
-- 主键是 (message_id, user_id, emoji)：同一个人对同一条消息的同一个表情只算一次，
-- 重复点是"取消"而不是"加两次"。不同人可以加同一个表情（靠 user_ids 汇总）。
--
-- 不做软删除：回应没有历史价值，取消就删行；事件里回的是**全量汇总**，
-- 客户端整体替换即可，不会因为丢一帧就不一致。

CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);--> statement-breakpoint

CREATE INDEX ix_reactions_message ON message_reactions(message_id);
