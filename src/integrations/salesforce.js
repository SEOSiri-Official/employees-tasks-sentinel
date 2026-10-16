import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleSalesforceWebhook(request, env, tenantId, defaultDept = "OPS") {
  try {
    const payload = await request.json();
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

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SALESFORCE_GATEWAY', 'SALESFORCE')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        deadline = excluded.deadline,
        updated_at = CURRENT_TIMESTAMP
    `).bind(caseId, tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate).run();

    return { status: "SALESFORCE_SYNCED", caseId, taskTitle, priority, status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
