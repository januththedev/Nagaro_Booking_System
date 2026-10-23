-- ============================================================================
-- Two-role administrator model, Super Admin cap and 30-day recycle bin.
--
-- Application roles are SUPER_ADMIN / ADMIN. The legacy storage CHECK on
-- admin_user.role is left untouched: accounts are stored as role = 'ADMIN'
-- with is_super_admin choosing the application role. Legacy STAFF rows are
-- migrated to ADMIN.
-- ============================================================================

ALTER TABLE admin_user
  ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0
  CHECK (is_super_admin IN (0,1));

ALTER TABLE admin_user
  ADD COLUMN deleted_at BIGINT;

ALTER TABLE admin_user
  ADD COLUMN deleted_by BIGINT REFERENCES admin_user(id) ON DELETE SET NULL;

ALTER TABLE admin_user
  ADD COLUMN purge_after BIGINT;

ALTER TABLE admin_user
  ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0,1));

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
