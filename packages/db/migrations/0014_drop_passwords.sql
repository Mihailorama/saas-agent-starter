-- contract: since ADR 0033 (passwordless sign-in) no release reads or writes passwords. Removes
-- every stored password hash: credential accounts only held one; any other row loses its hash.
-- A rollback to a password release finds no password, and those users sign in by email code.
DELETE FROM "account" WHERE "provider_id" = 'credential';--> statement-breakpoint
UPDATE "account" SET "password" = NULL WHERE "password" IS NOT NULL;
