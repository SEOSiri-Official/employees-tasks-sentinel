CREATE TABLE IF NOT EXISTS archived_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT,
  source TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_archived_tenant ON archived_tasks(tenant_id);
