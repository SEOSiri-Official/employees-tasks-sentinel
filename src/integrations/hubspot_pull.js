import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function syncHubspotTasksFromApi(env, tenantId, accessToken, defaultDept = "GROWTH") {
  const token = accessToken || env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    return { error: "HUBSPOT_TOKEN_REQUIRED", message: "Private App Access Token is required via Cloudflare secret." };
  }

  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/tasks?limit=50&properties=hs_task_subject,hs_task_status,hs_task_priority,hubspot_owner_id,hs_task_body,hs_timestamp", {
      headers: {
        "Authorization": `Bearer ${token}`,
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
      const status = normalizeStatus(props.hs_task_status);
      const priority = normalizePriority(props.hs_task_priority);

      const rawOwner = props.hubspot_owner_id;
      const assigneeInfo = await resolveAssignee(env, tenantId, rawOwner ? `Owner #${rawOwner}` : "Unassigned", null);

      const taskTitle = `[HubSpot HS-${t.id}] ${subject}`;
      const description = props.hs_task_body || "";
      const dueDate = props.hs_timestamp ? new Date(props.hs_timestamp).toISOString() : null;
      const externalUrl = `https://app.hubspot.com/contacts/3271531/objects/0-27/views/all/list`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, external_url, created_by, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUBSPOT_API', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          assigned_to = excluded.assigned_to,
          deadline = excluded.deadline,
          external_url = excluded.external_url,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(t.id), tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate, externalUrl).run();

      syncedCount++;
    }

    return { status: "HUBSPOT_TASKS_SYNCED", syncedCount, tasksFound: tasks.length };
  } catch (err) {
    return { error: err.message };
  }
}
