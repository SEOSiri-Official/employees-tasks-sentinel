import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleServiceNowWebhook(data, env, tenantId, defaultDept = "INFRA") {
  try {
    const payload = (data && typeof data.json === "function") ? await data.json() : data;
    const incNumber = payload.number || payload.sys_id || `INC-${Date.now().toString().slice(-6)}`;
    const summary = payload.short_description || payload.description || "ServiceNow Enterprise Incident";
    const priority = normalizePriority(payload.priority);
    const status = normalizeStatus(payload.state || payload.incident_state);

    const rawAssignee = payload.assigned_to_name || payload.assigned_to || payload.caller_id || null;
    const assigneeInfo = await resolveAssignee(env, tenantId, rawAssignee, payload.assigned_to_email);

    const taskTitle = `[ServiceNow ${incNumber}] ${summary}`;
    const description = payload.description || payload.close_notes || "";
    const externalUrl = `https://dev195140.service-now.com/nav_to.do?uri=incident.do?sysparm_query=number=${incNumber}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, external_url, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SERVICENOW_GATEWAY', 'SERVICENOW')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        external_url = excluded.external_url,
        updated_at = CURRENT_TIMESTAMP
    `).bind(incNumber, tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, externalUrl).run();

    return { status: "SERVICENOW_SYNCED", incNumber, taskTitle, priority, taskStatus: status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
