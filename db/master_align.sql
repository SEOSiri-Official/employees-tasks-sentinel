-- Ensure tasks table has all platform columns
ALTER TABLE tasks ADD COLUMN deadline DATETIME;
ALTER TABLE tasks ADD COLUMN labels TEXT;
ALTER TABLE tasks ADD COLUMN external_url TEXT;

-- Ensure archived_tasks exists with identical schema
CREATE TABLE IF NOT EXISTS archived_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  created_by TEXT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT,
  status TEXT DEFAULT 'ARCHIVED',
  source TEXT,
  deadline DATETIME,
  labels TEXT,
  external_url TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_archived_tenant ON archived_tasks(tenant_id);
