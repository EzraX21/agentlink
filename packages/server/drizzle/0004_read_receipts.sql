-- migration 0004: 已读水位（协议扩展 §5，见 docs/PROPOSAL-protocol-ext.md §5）
--
-- 只按"人会话"记一个水位 last_read_seq，够支撑双勾（✓✓）这种常见表达。
-- 不做"每条消息谁读过"——那需要另一张表，而且写入量会随消息数线性增长；
-- 需求确认书也没要求逐条回执。
--
-- 只增不减：客户端上报的 last_seq 小于当前值时忽略（见 services/members.ts），
-- 否则翻历史会让已读状态倒退。

ALTER TABLE memberships ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint

CREATE INDEX ix_memberships_conv_read ON memberships(conv_id, last_read_seq);
