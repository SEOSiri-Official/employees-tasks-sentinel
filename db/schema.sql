-- 1. Tenant / Organization Registry (Supports Conglomerates & SMEs)
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,          -- e.g. 'ALPHA', 'BETA', 'ETM'
  company_name TEXT NOT NULL,
  tier TEXT DEFAULT 'FREE_SME',        -- 'FREE_SME' (1-10), 'PRO', 'ENTERPRISE'
  license_token TEXT NULL,             -- Active HMAC-SHA256 Token
  max_seats INTEGER DEFAULT 10,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Departments
CREATE TABLE IF NOT EXISTS departments (
  dept_id TEXT NOT NULL,               -- e.g. 'ENG', 'BIOPHARMA', 'OPS'
  tenant_id TEXT NOT NULL,
  dept_name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, dept_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

-- 3. Employees Table (Zero-Trust RBAC)
CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,        -- e.g. 'ALPHA-ENG-EMP-8821'
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('ADMIN', 'DEPT_HEAD', 'EMPLOYEE')) DEFAULT 'EMPLOYEE',
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

-- 4. Tasks Table (The Core Pipeline)
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,           -- employee_id
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT CHECK(status IN ('URGENT', 'PROGRESS', 'PENDING', 'COMPLETE')) DEFAULT 'PENDING',
  priority TEXT CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'MEDIUM',
  source TEXT DEFAULT 'MANUAL',        -- 'MANUAL', 'CSV_IMPORT', 'JIRA_SYNC'
  external_ref TEXT NULL,              -- e.g. Jira Issue Key 'CX-104'
  created_by TEXT NOT NULL,            -- Admin or System employee_id
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES employees(employee_id) ON DELETE CASCADE
);

-- 5. Tasks Data Collector (Telemetry & Blocker Audit Log)
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

-- Indexes for sub-10ms edge queries
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_emp ON tasks(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_telemetry_task ON task_telemetry(tenant_id, task_id);
