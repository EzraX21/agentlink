CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`uploader_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_attachments_sha` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_audit_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`announcement` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_conversations_kind" CHECK("conversations"."kind" IN ('group','dm'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`conv_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_events_conv_seq` ON `events` (`conv_id`,`seq`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`conv_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`is_agent` integer DEFAULT 0 NOT NULL,
	`muted_until` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`conv_id`, `user_id`),
	FOREIGN KEY (`conv_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_memberships_role" CHECK("memberships"."role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE INDEX `ix_memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`conv_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`seq` integer,
	`client_msg_id` text,
	`content_json` text NOT NULL,
	`text_plain` text DEFAULT '' NOT NULL,
	`reply_to` text,
	`state` text NOT NULL,
	`interrupted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`conv_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_messages_state" CHECK("messages"."state" IN ('streaming','final','revoked'))
);
--> statement-breakpoint
CREATE INDEX `ix_messages_conv_seq` ON `messages` (`conv_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_messages_idem` ON `messages` (`sender_id`,`client_msg_id`) WHERE client_msg_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_messages_streaming` ON `messages` (`state`) WHERE state = 'streaming';--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`replaced_by` text,
	`revoked_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_refresh_user` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`kind` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`password_hash` text,
	`token_hash` text,
	`model` text,
	`owner_user_id` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_users_kind" CHECK("users"."kind" IN ('human','agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_users_username` ON `users` (`tenant_id`,`username`);