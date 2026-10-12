export async function handleAsanaWebhook(request, env, tenantId, defaultDept = "OPERATIONS") {
  try {
    const payload = await request.json();
    const taskData = payload.data || payload;
    const asanaGid = taskData.gid || `ASANA-${Date.now().toString().slice(-6)}`;
    const taskName = taskData.name || "Asana Operational Deliverable";
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

    return { status: "ASANA_SYNCED", asanaGid, taskTitle, sentinelStatus };
  } catch (err) {
    return { error: err.message };
  }
}
