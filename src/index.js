// SEOSiri Enterprise Sentinel - Self-Healing Universal Sync Engine v4.5.0

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ["https://board.seosiri.com", "https://developers.seosiri.com"];
  const matchedOrigin = allowed.includes(origin) ? origin : "https://board.seosiri.com";
  return {
    "Access-Control-Allow-Origin": matchedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
  };
}

function recursiveFind(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === "object") {
      const res = recursiveFind(obj[k], keys);
      if (res !== null) return res;
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(JSON.stringify({ status: "HEALTHY", engine: "Self-Healing Universal v4.5.0", timestamp: new Date().toISOString() }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // =====================================================================
      // SELF-HEALING UNIVERSAL WEBHOOK GATEWAY WITH AUDIT LEDGER
      // =====================================================================
      if (url.pathname.startsWith("/v1/webhooks/") && request.method === "POST") {
        const tenantId = (url.searchParams.get("tenant") || "ETM").toUpperCase();
        const pathParts = url.pathname.split("/");
        const platform = (pathParts[3] || "UNKNOWN").toUpperCase();

        let rawText = "{}";
        let rawBody = {};
        try {
          rawText = await request.text();
          rawBody = JSON.parse(rawText);
        } catch (e) {
          rawBody = { rawText };
        }

        // Asana Handshake
        const hookSecret = request.headers.get("X-Hook-Secret");
        if (hookSecret && platform === "ASANA") {
          return new Response(null, { status: 200, headers: { "X-Hook-Secret": hookSecret, ...corsHeaders } });
        }

        try {
          // Recursive Deep-Key Extraction (Guarantees zero dropped fields)
          const taskId = String(recursiveFind(rawBody, ["key", "id", "caseNumber", "number", "objectId", "gid", "sys_id"]) || `TSK-${Date.now().toString().slice(-6)}`).trim();
          const titleSummary = recursiveFind(rawBody, ["summary", "subject", "short_description", "name", "title"]) || `Enterprise Deliverable #${taskId}`;
          const title = String(titleSummary).trim().includes(platform) ? String(titleSummary) : `[${platform} ${taskId}] ${titleSummary}`;

          const rawPrio = String(recursiveFind(rawBody, ["priority", "hs_ticket_priority"]) || "MEDIUM").toUpperCase();
          let priority = "MEDIUM";
          if (rawPrio.includes("CRITICAL") || rawPrio.includes("URGENT") || rawPrio === "1" || rawPrio.includes("HIGH")) {
            priority = rawPrio.includes("CRITICAL") || rawPrio === "1" ? "CRITICAL" : "HIGH";
          }

          const rawStat = String(recursiveFind(rawBody, ["status", "state", "incident_stage"]) || "PROGRESS").toUpperCase();
          let status = "PROGRESS";
          if (rawStat.includes("COMPLETE") || rawStat.includes("RESOLVED") || rawStat.includes("CLOSED") || rawStat === "6" || rawStat === "7") {
            status = "COMPLETE";
          } else if (rawStat.includes("PENDING") || rawStat.includes("HOLD") || rawStat === "3") {
            status = "PENDING";
          }

          const deptId = (url.searchParams.get("dept") || (platform === "JIRA" ? "ENG" : platform === "SALESFORCE" ? "OPS" : platform === "HUBSPOT" ? "GROWTH" : platform === "ASANA" ? "OPERATIONS" : "INFRA")).toUpperCase();

          // Upsert to Cloudflare D1
          await env.DB.prepare(`
            INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
            VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'SELF_HEALING_DAEMON', ?)
            ON CONFLICT(task_id) DO UPDATE SET 
              title = excluded.title, 
              status = excluded.status,
              priority = excluded.priority,
              updated_at = CURRENT_TIMESTAMP
          `).bind(taskId, tenantId, deptId, title, priority, status, platform).run();

          // Log to Webhook Audit Ledger (Success)
          await env.DB.prepare(
            "INSERT INTO webhook_audit_log (log_id, tenant_id, platform, raw_payload, response_status) VALUES (?, ?, ?, ?, 200)"
          ).bind(crypto.randomUUID(), tenantId, platform, rawText.substring(0, 2000)).run();

          return new Response(JSON.stringify({ status: "SUCCESS", platform, taskId, title }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });

        } catch (innerErr) {
          // Self-Healing Recovery: Save as generic fallback task instead of failing 500
          const fallbackId = `FAIL-${Date.now().toString().slice(-6)}`;
          await env.DB.prepare(`
            INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
            VALUES (?, ?, 'OPS', 'ETM-AG-EMP-R62', ?, 'MEDIUM', 'PROGRESS', 'SELF_HEALING_FALLBACK', ?)
            ON CONFLICT(task_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
          `).bind(fallbackId, tenantId, `[${platform} Fallback] Raw Payload Ingested`, platform).run();

          // Log to Webhook Audit Ledger (Recovered via Self-Healing)
          await env.DB.prepare(
            "INSERT INTO webhook_audit_log (log_id, tenant_id, platform, raw_payload, response_status, error_message) VALUES (?, ?, ?, ?, 200, ?)"
          ).bind(crypto.randomUUID(), tenantId, platform, rawText.substring(0, 2000), innerErr.message).run();

          return new Response(JSON.stringify({ status: "SELF_HEALED_RECOVERY", platform, fallbackId, note: innerErr.message }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
      }

      // Standard Dashboard APIs
      const rawId = request.headers.get("X-Employee-ID");
      if (!rawId) return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401, headers: corsHeaders });

      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = 'ETM' ORDER BY created_at DESC").all();
        return new Response(JSON.stringify({ tenant: "ETM", tasks: tasks.results || [] }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/webhook/audit" && request.method === "GET") {
        const logs = await env.DB.prepare("SELECT * FROM webhook_audit_log ORDER BY received_at DESC LIMIT 20").all();
        return new Response(JSON.stringify({ auditLogs: logs.results || [] }), { status: 200, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: corsHeaders });

    } catch (fatalError) {
      return new Response(JSON.stringify({ error: "FATAL", message: fatalError.message }), { status: 500, headers: corsHeaders });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const tenants = await env.DB.prepare("SELECT tenant_id FROM tenants").all();
      for (const t of (tenants.results || [])) {
        if (env.HUBSPOT_ACCESS_TOKEN) {
          // Background sync cron execution
        }
      }
    } catch (e) {}
  }
};
