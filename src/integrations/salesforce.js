import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleSalesforceWebhook(request, env, tenantId, defaultDept = "OPS") {
  try {
    const payload = await request.json();
    const caseId = payload.Id || payload.caseNumber || payload.number || `SF-${Date.now().toString().slice(-6)}`;
    const subject = payload.Subject || payload.subject || payload.short_description || "Salesforce Enterprise Task";
    const priority = normalizePriority(payload.Priority || payload.priority);
    const status = normalizeStatus(payload.Status || payload.status || payload.state);

    const rawOwner = payload.ownerName || payload.Owner?.Name || payload.CreatedBy?.Name || null;
    const ownerEmail = payload.ContactEmail || payload.ownerEmail || payload.email || null;
    const assigneeInfo = await resolveAssignee(env, tenantId, rawOwner, ownerEmail, defaultDept);

    const taskTitle = `[Salesforce ${caseId}] ${subject}`;
    const description = payload.Description || payload.description || "";
    const dueDate = payload.ActivityDate || payload.dueDate ? new Date(payload.ActivityDate || payload.dueDate).toISOString() : null;
    const externalUrl = payload.url || (env.SALESFORCE_INSTANCE_URL ? `${env.SALESFORCE_INSTANCE_URL}/lightning/r/Task/${caseId}/view` : "");

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, external_url, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SALESFORCE_GATEWAY', 'SALESFORCE')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        deadline = excluded.deadline,
        external_url = excluded.external_url,
        updated_at = CURRENT_TIMESTAMP
    `).bind(String(caseId), tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate, externalUrl).run();

    return { status: "SALESFORCE_SYNCED", caseId, taskTitle, priority, taskStatus: status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
