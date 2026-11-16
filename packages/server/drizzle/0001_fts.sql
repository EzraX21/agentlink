-- 迁移 0001：全文检索（数据模型 §2）
--
-- 为什么手写而不是 drizzle-kit 生成：FTS5 虚表、外部内容表与三个触发器
-- drizzle 的 schema builder 表达不了，硬塞会生成错误 DDL。迁移文件只增不改，
-- 所以作为独立迁移加进来，并在 meta/_journal.json 登记。
PRAGMA foreign_keys = ON;--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text_plain,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61'
);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages
WHEN new.state = 'final' AND new.revoked_at IS NULL
BEGIN
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, new.text_plain);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain)
  VALUES('delete', old.rowid, old.text_plain);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages
WHEN old.state = 'final' OR new.state = 'final'
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain)
  VALUES('delete', old.rowid, old.text_plain);
  INSERT INTO messages_fts(rowid, text_plain)
  SELECT new.rowid, new.text_plain WHERE new.state = 'final' AND new.revoked_at IS NULL;
END;--> statement-breakpoint
INSERT INTO messages_fts(rowid, text_plain)
SELECT m.rowid, m.text_plain FROM messages m
WHERE m.state = 'final' AND m.revoked_at IS NULL
  AND m.rowid NOT IN (SELECT rowid FROM messages_fts);
