export async function syncHubspotTasksFromApi(env, tenantId, accessToken, defaultDept = "GROWTH") {
  if (!accessToken) {
    return { error: "HUBSPOT_TOKEN_REQUIRED", message: "Private App Access Token is required to sync CRM Tasks." };
  }

  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/tasks?limit=50&properties=hs_task_subject,hs_task_status,hs_task_priority", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: "HUBSPOT_API_ERROR", status: res.status, details: errText };
    }

    const data = await res.json();
    const tasks = data.results || [];
    let syncedCount = 0;

    for (const t of tasks) {
      const props = t.properties || {};
      const subject = props.hs_task_subject || "HubSpot Task";
      const statusRaw = String(props.hs_task_status || "NOT_STARTED").toUpperCase();
      const priorityRaw = String(props.hs_task_priority || "MEDIUM").toUpperCase();

      let priority = "MEDIUM";
      if (priorityRaw.includes("HIGH") || priorityRaw.includes("URGENT")) priority = "HIGH";
      else if (priorityRaw.includes("LOW")) priority = "LOW";

      let status = "PROGRESS";
      if (statusRaw.includes("COMPLETED")) status = "COMPLETE";
      else if (statusRaw.includes("WAITING")) status = "PENDING";

      const taskTitle = `[HubSpot HS-${t.id}] ${subject}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'HUBSPOT_API', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(t.id), tenantId, defaultDept, taskTitle, priority, status).run();

      syncedCount++;
    }

    return { status: "HUBSPOT_TASKS_SYNCED", synced_count: syncedCount, tasks_found: tasks.length };
  } catch (err) {
    return { error: err.message };
  }
}
