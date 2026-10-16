CREATE TABLE IF NOT EXISTS webhook_audit_log (
  log_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  raw_payload TEXT,
  response_status INTEGER,
  error_message TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON webhook_audit_log(tenant_id, platform);
