-- Public knowledge curated by administrators for the Guider assistant.
-- Only rows with is_active=1 are exposed through the assistant tool.

CREATE TABLE assistant_knowledge (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  markdown TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX ix_assistant_knowledge_active
  ON assistant_knowledge(is_active, updated_at DESC, id DESC);
