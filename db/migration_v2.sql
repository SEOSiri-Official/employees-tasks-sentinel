-- Threaded Managerial & Peer Task Comments
CREATE TABLE IF NOT EXISTS task_comments (
  comment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, tenant_id);

-- Add availability flag to employees
ALTER TABLE employees ADD COLUMN auto_dispatch INTEGER DEFAULT 1;
