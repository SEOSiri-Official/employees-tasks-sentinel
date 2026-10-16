// SEOSiri Enterprise Sentinel - Bulletproof Real-Time Ingestion Engine

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [
    "https://board.seosiri.com",
    "https://http://tasks.seosiri.com/"
  ];
  const matchedOrigin = allowed.includes(origin) ? origin : "https://board.seosiri.com";

  return {
    "Access-Control-Allow-Origin": matchedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
  };
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "HEALTHY", version: "4.0.0" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // =========================================================================
    // UNIVERSAL BULLETPROOF WEBHOOK GATE (ACCEPTS ANY PLATFORM PAYLOAD)
    // =========================================================================
    if (url.pathname.startsWith("/v1/webhooks/") && request.method === "POST") {
      try {
        const tenantId = (url.searchParams.get("tenant") || "ETM").toUpperCase();
        const pathParts = url.pathname.split("/");
        const platform = (pathParts[3] || "UNKNOWN").toUpperCase(); // JIRA, HUBSPOT, SALESFORCE, ASANA, SERVICENOW

        let rawBody = {};
        try {
          rawBody = await request.json();
        } catch (e) {
          rawBody = {};
        }

        // Asana Handshake check
        const hookSecret = request.headers.get("X-Hook-Secret");
        if (hookSecret && platform === "ASANA") {
          return new Response(null, { status: 200, headers: { "X-Hook-Secret": hookSecret, ...corsHeaders } });
        }

        // Universal Extraction Fallbacks (Handles ANY real-world platform payload)
        let taskId = rawBody.key || rawBody.id || rawBody.caseNumber || rawBody.number || rawBody.objectId || rawBody.gid || rawBody.issue?.key || `TSK-${Date.now().toString().slice(-6)}`;
        taskId = String(taskId).trim();

        let title = rawBody.summary || rawBody.subject || rawBody.short_description || rawBody.name || rawBody.title || rawBody.issue?.fields?.summary || `[${platform}] Enterprise Task #${taskId}`;
        title = String(title).trim();
        if (!title.includes(`[${platform}`)) {
          title = `[${platform} ${taskId}] ${title}`;
        }

        let rawPriority = String(rawBody.priority || rawBody.issue?.fields?.priority?.name || "MEDIUM").toUpperCase();
        let priority = "MEDIUM";
        if (rawPriority.includes("CRITICAL") || rawPriority.includes("URGENT") || rawPriority === "1" || rawPriority.includes("HIGH")) {
          priority = rawPriority.includes("CRITICAL") || rawPriority === "1" ? "CRITICAL" : "HIGH";
        }

        let rawStatus = String(rawBody.status || rawBody.state || rawBody.issue?.fields?.status?.name || "PROGRESS").toUpperCase();
        let status = "PROGRESS";
        if (rawStatus.includes("COMPLETE") || rawStatus.includes("RESOLVED") || rawStatus.includes("CLOSED") || rawStatus === "6" || rawStatus === "7") {
          status = "COMPLETE";
        } else if (rawStatus.includes("PENDING") || rawStatus.includes("HOLD") || rawStatus === "3") {
          status = "PENDING";
        }

        const deptId = (url.searchParams.get("dept") || (platform === "JIRA" ? "ENG" : platform === "SALESFORCE" ? "OPS" : platform === "HUBSPOT" ? "GROWTH" : platform === "ASANA" ? "OPERATIONS" : "INFRA")).toUpperCase();

        // Save immediately to Cloudflare D1 with zero constraint rejections
        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, created_by, source)
          VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, ?, 'WEBHOOK_DAEMON', ?)
          ON CONFLICT(task_id) DO UPDATE SET 
            title = excluded.title, 
            status = excluded.status,
            priority = excluded.priority,
            updated_at = CURRENT_TIMESTAMP
        `).bind(taskId, tenantId, deptId, title, JSON.stringify(rawBody), priority, status, platform).run();

        return new Response(JSON.stringify({ status: "SUCCESS", platform, taskId, title }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (webhookErr) {
        // Fallback catch ensures webhook NEVER returns 500
        return new Response(JSON.stringify({ status: "FALLBACK_ACCEPTED", error: webhookErr.message }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // Standard Dashboard APIs (Authentication Required)
    const rawId = request.headers.get("X-Employee-ID");
    if (!rawId) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401, headers: corsHeaders });
    }

    if (url.pathname === "/v1/tasks" && request.method === "GET") {
      const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = 'ETM' ORDER BY created_at DESC").all();
      return new Response(JSON.stringify({ tenant: "ETM", tasks: tasks.results || [] }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: corsHeaders });
  }
};
