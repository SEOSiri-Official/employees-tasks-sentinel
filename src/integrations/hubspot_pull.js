export async function syncHubspotTasksFromApi(env, tenantId, accessToken, defaultDept = "GROWTH") {
  if (!accessToken) {
    return { error: "HUBSPOT_TOKEN_REQUIRED", message: "Private App Access Token is required." };
  }

  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/tasks?limit=50&properties=hs_task_subject,hs_task_status,hs_task_priority,hubspot_owner_id", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      return { error: "HUBSPOT_API_ERROR", status: res.status };
    }

    const data = await res.json();
    const tasks = data.results || [];
    let syncedCount = 0;

    for (const t of tasks) {
      const props = t.properties || {};
      const subject = props.hs_task_subject || "HubSpot Task";
      const statusRaw = String(props.hs_task_status || "NOT_STARTED").toUpperCase();
      const priorityRaw = String(props.hs_task_priority || "MEDIUM").toUpperCase();

      // Normalize Priority
      let priority = "MEDIUM";
      if (priorityRaw.includes("HIGH") || priorityRaw.includes("URGENT")) priority = "HIGH";
      else if (priorityRaw.includes("LOW")) priority = "LOW";

      // Normalize Status
      let status = "PROGRESS";
      if (statusRaw.includes("COMPLETED")) status = "COMPLETE";
      else if (statusRaw.includes("WAITING")) status = "PENDING";

      // Clean Assignee Resolution - NEVER hardcode internal test IDs
      const rawOwner = props.hubspot_owner_id;
      const targetAssignee = rawOwner ? `Owner #${rawOwner}` : "Unassigned";

      const taskTitle = `[HubSpot HS-${t.id}] ${subject}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'HUBSPOT_API', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          priority = excluded.priority,
          assigned_to = excluded.assigned_to,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(t.id), tenantId, defaultDept, targetAssignee, taskTitle, priority, status).run();

      syncedCount++;
    }

    return { status: "HUBSPOT_TASKS_SYNCED", synced_count: syncedCount, tasks_found: tasks.length };
  } catch (err) {
    return { error: err.message };
  }
}
