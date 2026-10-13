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
      // Extract task GID from Asana resource object or root data
      const asanaGid = ev.resource?.gid || ev.data?.gid || ev.gid || `ASANA-${Date.now().toString().slice(-6)}`;
      let taskName = ev.name || ev.data?.name || "Asana Task Activity";
      let completed = ev.completed || ev.data?.completed || false;
      let assigneeEmail = "";

      // If token is available and we have a task GID, fetch task details from Asana
      const asanaToken = env.ASANA_API_TOKEN || "";
      if (asanaToken && asanaGid && !asanaGid.startsWith("ASANA-")) {
        try {
          const asanaRes = await fetch(`https://app.asana.com/api/1.0/tasks/${asanaGid}?opt_fields=name,completed,assignee.email`, {
            headers: { "Authorization": `Bearer ${asanaToken}`, "Accept": "application/json" }
          });
          if (asanaRes.ok) {
            const asanaJson = await asanaRes.json();
            if (asanaJson.data) {
              taskName = asanaJson.data.name || taskName;
              completed = asanaJson.data.completed || false;
              assigneeEmail = asanaJson.data.assignee?.email || "";
            }
          }
        } catch (fetchErr) {
          // Graceful fallback to default title
        }
      }

      let targetAssignee = "ETM-AG-EMP-R62";
      if (assigneeEmail) {
        const emp = await env.DB.prepare(
          "SELECT employee_id FROM employees WHERE tenant_id = ? AND LOWER(email) = LOWER(?)"
        ).bind(tenantId, assigneeEmail).first();
        if (emp) targetAssignee = emp.employee_id;
      }

      let sentinelStatus = completed ? "COMPLETE" : "PROGRESS";
      const taskTitle = `[Asana] ${taskName}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, ?, ?, 'MEDIUM', ?, 'ASANA_GATEWAY', 'ASANA')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(asanaGid), tenantId, defaultDept, targetAssignee, taskTitle, sentinelStatus).run();
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
