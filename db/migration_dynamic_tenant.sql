CREATE TABLE IF NOT EXISTS tenant_mappings (
  mapping_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- 'JIRA', 'HUBSPOT', 'SALESFORCE', 'ASANA', 'SERVICENOW'
  provider_org_key TEXT NOT NULL, -- e.g. HubSpot Portal ID or Jira Instance URL
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_org_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_mapping_lookup ON tenant_mappings(provider, provider_org_key);
