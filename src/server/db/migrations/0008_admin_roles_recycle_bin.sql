-- ============================================================================
-- Two-role administrator model, Super Admin cap and 30-day recycle bin.
--
-- Application roles are exposed as SUPER_ADMIN / ADMIN while the legacy
-- storage CHECK constraint on admin_user.role is deliberately left untouched:
-- every account is stored with role = 'ADMIN' and is_super_admin distinguishes
-- the two application roles. Legacy STAFF rows are migrated to ADMIN.
--
-- At most MAX_SUPER_ADMINS (3) active, non-deleted accounts may carry
-- is_super_admin = 1. The service layer enforces the cap inside a write
-- transaction; these indexes keep the guarded counts cheap.
-- ============================================================================

ALTER TABLE admin_user
  ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_super_admin IN (0,1));

ALTER TABLE admin_user
  ADD COLUMN deleted_at INTEGER;

ALTER TABLE admin_user
  ADD COLUMN deleted_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL;

ALTER TABLE admin_user
  ADD COLUMN purge_after INTEGER;

ALTER TABLE admin_user
  ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1));

-- Legacy staff accounts become ordinary administrators. Existing ADMIN rows
-- become Super Admins, oldest active accounts first, never more than three.
UPDATE admin_user SET role = 'ADMIN' WHERE role = 'STAFF';

UPDATE admin_user
   SET is_super_admin = 1
 WHERE id IN (
   SELECT id
     FROM admin_user
    WHERE role = 'ADMIN'
      AND COALESCE(is_system, 0) = 0
    ORDER BY is_active DESC, created_at ASC, id ASC
    LIMIT 3
 );

CREATE INDEX ix_admin_user_active_super
  ON admin_user(is_super_admin, is_active, deleted_at);

CREATE INDEX ix_admin_user_deleted
  ON admin_user(deleted_at, purge_after);
