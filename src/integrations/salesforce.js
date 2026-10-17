import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleSalesforceWebhook(data, env, tenantId, defaultDept = "OPS") {
  try {
    const payload = (data && typeof data.json === "function") ? await data.json() : data;
    const caseId = payload.Id || payload.caseNumber || `SF-${Date.now().toString().slice(-6)}`;
    const subject = payload.Subject || payload.subject || "Salesforce Task";
    const priority = normalizePriority(payload.Priority || payload.priority);
    const status = normalizeStatus(payload.Status || payload.status);

    const rawOwner = payload.ownerName || payload.Owner?.Name || payload.CreatedBy?.Name || null;
    const ownerEmail = payload.ContactEmail || payload.ownerEmail || null;
    const assigneeInfo = await resolveAssignee(env, tenantId, rawOwner, ownerEmail);

    const taskTitle = `[Salesforce ${caseId}] ${subject}`;
    const description = payload.Description || payload.description || "";
    const dueDate = payload.ActivityDate ? new Date(payload.ActivityDate).toISOString() : null;
    const externalUrl = env.SALESFORCE_INSTANCE_URL ? `${env.SALESFORCE_INSTANCE_URL}/lightning/r/Task/${caseId}/view` : "";

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
    `).bind(caseId, tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate, externalUrl).run();

    return { status: "SALESFORCE_SYNCED", caseId, taskTitle, priority, taskStatus: status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
