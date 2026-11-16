-- migration 0002: fix FTS triggers (avoid SQLITE_CORRUPT_VTAB)
--
-- Migration 0001's trg_messages_au fired when `old.state='final' OR new.state='final'`
-- and always ran the FTS5 'delete' insert first. But a streaming message row is INSERTed
-- with state='streaming' -- it was never added to the index. When it is later UPDATEd to
-- state='final', old.state is NOT 'final', yet the trigger still emitted 'delete' for a
-- rowid that was never in the index. FTS5 marks the virtual table corrupt in that case
-- (SQLITE_CORRUPT_VTAB), and every later UPDATE on messages fails.
--
-- Fix: decide the two actions independently -- delete only when the OLD row was actually
-- indexed, insert only when the NEW row should be indexed. Never OR the two conditions.
--
-- Note: the FTS5 'rebuild' special command must not live here (the drizzle migrator runs
-- each statement through prepare(), and special commands cannot be prepared). It runs at
-- startup instead -- see rebuildFts() in src/db/index.ts.

DROP TRIGGER IF EXISTS trg_messages_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_messages_ad;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_messages_au;--> statement-breakpoint
CREATE TRIGGER trg_messages_ai AFTER INSERT ON messages
WHEN new.state = 'final' AND new.revoked_at IS NULL
BEGIN
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, new.text_plain);
END;--> statement-breakpoint
CREATE TRIGGER trg_messages_ad AFTER DELETE ON messages
WHEN old.state = 'final' AND old.revoked_at IS NULL
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain)
  VALUES('delete', old.rowid, old.text_plain);
END;--> statement-breakpoint
CREATE TRIGGER trg_messages_au AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain)
  SELECT 'delete', old.rowid, old.text_plain
  WHERE old.state = 'final' AND old.revoked_at IS NULL;
  INSERT INTO messages_fts(rowid, text_plain)
  SELECT new.rowid, new.text_plain
  WHERE new.state = 'final' AND new.revoked_at IS NULL;
END;
