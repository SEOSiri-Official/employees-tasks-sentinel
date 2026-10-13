export async function handleServiceNowWebhook(request, env, tenantId, defaultDept = "INFRA") {
  try {
    const payload = await request.json();
    const incNumber = payload.number || payload.sys_id || `INC-${Date.now().toString().slice(-6)}`;
    const summary = payload.short_description || payload.description || "ServiceNow Enterprise Incident";
    const state = String(payload.state || payload.incident_state || "1");
    const rawPriority = String(payload.priority || "3");

    // Normalize ServiceNow Priority (1=Critical, 2=High, 3=Medium, 4/5=Low)
    let priority = "MEDIUM";
    if (rawPriority === "1" || rawPriority.toUpperCase().includes("CRITICAL")) priority = "CRITICAL";
    else if (rawPriority === "2" || rawPriority.toUpperCase().includes("HIGH")) priority = "HIGH";
    else if (rawPriority === "4" || rawPriority === "5" || rawPriority.toUpperCase().includes("LOW")) priority = "LOW";

    let sentinelStatus = "PROGRESS";
    if (state === "6" || state === "7") sentinelStatus = "COMPLETE";
    else if (state === "3") sentinelStatus = "PENDING";
    else if (priority === "CRITICAL") sentinelStatus = "URGENT";

    const taskTitle = `[ServiceNow ${incNumber}] ${summary}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
      VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'SERVICENOW_GATEWAY', 'SERVICENOW')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `).bind(incNumber, tenantId, defaultDept, taskTitle, priority, sentinelStatus).run();

    return { status: "SERVICENOW_SYNCED", incNumber, taskTitle, sentinelStatus };
  } catch (err) {
    return { error: err.message };
  }
}
