-- migration 0003: add users.is_admin (global admin flag for the web admin console)
--
-- The data model (docs/03) has no global "admin" concept: its permission matrix is
-- per-conversation (owner/admin/member). But the web admin console manages accounts,
-- agents and the audit log across ALL conversations, so it needs an admission concept.
-- Without it, every human account could create/disable agents and read the audit log.
--
-- docs/03 states the DDL is a baseline and implementations may ADD fields, so this is
-- an additive change. Bootstrap rule: the earliest human account becomes the admin, so
-- an existing database (and a fresh one) always has exactly one usable admin.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE users
SET is_admin = 1
WHERE id = (
  SELECT id FROM users
  WHERE kind = 'human'
  ORDER BY created_at ASC, id ASC
  LIMIT 1
);
