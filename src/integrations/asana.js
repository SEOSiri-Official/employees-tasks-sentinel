export async function handleAsanaWebhook(request, env, tenantId, defaultDept = "OPERATIONS", corsHeaders = {}) {
  // 1. Asana Webhook Handshake Verification
  const hookSecret = request.headers.get("X-Hook-Secret") || request.headers.get("x-hook-secret");
  
  if (hookSecret) {
    return new Response(null, {
      status: 200,
      headers: {
        "X-Hook-Secret": hookSecret,
        "Access-Control-Expose-Headers": "X-Hook-Secret",
        ...corsHeaders
      }
    });
  }

  // 2. Process Incoming Asana Events
  try {
    const payload = await request.json();
    const events = payload.events || (Array.isArray(payload) ? payload : [payload]);

    for (const ev of events) {
      const taskData = ev.data || ev;
      const asanaGid = taskData.gid || `ASANA-${Date.now().toString().slice(-6)}`;
      const taskName = taskData.name || "Asana Task Activity";
      const completed = taskData.completed || false;

      let sentinelStatus = completed ? "COMPLETE" : "PROGRESS";
      const taskTitle = `[Asana] ${taskName}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, 'MEDIUM', ?, 'ASANA_GATEWAY', 'ASANA')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(asanaGid), tenantId, defaultDept, taskTitle, sentinelStatus).run();
    }

    return new Response(JSON.stringify({ status: "ASANA_SYNCED" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "EVENT_RECEIVED", note: err.message }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
