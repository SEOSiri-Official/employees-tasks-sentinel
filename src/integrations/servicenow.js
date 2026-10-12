export async function handleServiceNowWebhook(request, env, tenantId, defaultDept = "INFRA") {
  try {
    const payload = await request.json();
    const incNumber = payload.number || payload.sys_id || `INC-${Date.now().toString().slice(-6)}`;
    const summary = payload.short_description || payload.description || "ServiceNow Enterprise Incident";
    const state = String(payload.state || payload.incident_state || "1");

    let sentinelStatus = "PROGRESS";
    if (state === "6" || state === "7") sentinelStatus = "COMPLETE";
    else if (state === "3") sentinelStatus = "PENDING";

    const taskTitle = `[ServiceNow ${incNumber}] ${summary}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
      VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, 'CRITICAL', ?, 'SERVICENOW_GATEWAY', 'SERVICENOW')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `).bind(incNumber, tenantId, defaultDept, taskTitle, sentinelStatus).run();

    return { status: "SERVICENOW_SYNCED", incNumber, taskTitle, sentinelStatus };
  } catch (err) {
    return { error: err.message };
  }
}
