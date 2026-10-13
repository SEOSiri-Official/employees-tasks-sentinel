export async function handleAsanaWebhook(request, env, tenantId, defaultDept = "OPERATIONS", corsHeaders = {}) {
  // 1. Asana Webhook Handshake Verification (X-Hook-Secret)
  const hookSecret = request.headers.get("X-Hook-Secret");
  if (hookSecret) {
    return new Response(null, {
      status: 200,
      headers: {
        "X-Hook-Secret": hookSecret,
        ...corsHeaders
      }
    });
  }

  // 2. Real Inbound Asana Event Processing
  try {
    const payload = await request.json();
    const events = payload.events || [payload];
    
    for (const ev of events) {
      // In real Asana webhooks, task data is inside ev.resource
      const resource = ev.resource || ev.data || ev;
      const asanaGid = resource.gid || `ASANA-${Date.now().toString().slice(-6)}`;
      const action = ev.action || "created";
      const taskName = resource.name || `Asana Task #${asanaGid.slice(-6)}`;
      const completed = action === "completed" || resource.completed || false;

      let sentinelStatus = completed ? "COMPLETE" : "PROGRESS";
      const taskTitle = `[Asana] ${taskName}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, 'MEDIUM', ?, 'ASANA_GATEWAY', 'ASANA')
        ON CONFLICT(task_id) DO UPDATE SET 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(asanaGid), tenantId, defaultDept, taskTitle, sentinelStatus).run();
    }

    return new Response(JSON.stringify({ status: "ASANA_SYNCED", count: events.length }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
