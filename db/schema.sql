-- 1. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  tier TEXT DEFAULT 'FREE_SME',
  license_token TEXT NULL,
  max_seats INTEGER DEFAULT 10,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Departments Table
CREATE TABLE IF NOT EXISTS departments (
  dept_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dept_name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, dept_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

-- 3. Employees Table
CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('ADMIN', 'DEPT_HEAD', 'EMPLOYEE')) DEFAULT 'EMPLOYEE',
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

-- 4. Tasks Table (The Core 4-State Pipeline)
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT CHECK(status IN ('URGENT', 'PROGRESS', 'PENDING', 'COMPLETE')) DEFAULT 'PENDING',
  priority TEXT CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'MEDIUM',
  source TEXT DEFAULT 'MANUAL',
  external_ref TEXT NULL,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

-- 5. Tasks Data Collector (Telemetry & Audit Log)
CREATE TABLE IF NOT EXISTS task_telemetry (
  log_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  blocker_reason TEXT NULL,
  transition_seconds INTEGER DEFAULT 0,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

-- 6. Autonomous Ping Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  dept_id TEXT NULL,
  type TEXT CHECK(type IN ('URGENT_TASK', 'DEADLINE_ALERT', 'BLOCKER_ESCALATION', 'SUMMARY_DIGEST')) NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_emp ON tasks(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_telemetry_task ON task_telemetry(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_notif_target ON notifications(tenant_id, target_id, is_read);
