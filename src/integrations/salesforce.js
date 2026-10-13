export async function handleSalesforceWebhook(request, env, tenantId, defaultDept = "OPS") {
  try {
    const payload = await request.json();
    const caseId = payload.Id || payload.caseNumber || `SF-${Date.now().toString().slice(-6)}`;
    const subject = payload.Subject || payload.subject || "Salesforce Enterprise Task";
    const status = String(payload.Status || payload.status || "New").toUpperCase();
    const rawPriority = String(payload.Priority || payload.priority || "MEDIUM").toUpperCase();
    const assigneeEmail = payload.ContactEmail || payload.ownerEmail || "";

    // Normalize Priority to match D1 CHECK constraint: ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    let priority = "MEDIUM";
    if (rawPriority === "CRITICAL" || rawPriority.includes("URGENT") || rawPriority.includes("P1")) priority = "CRITICAL";
    else if (rawPriority === "HIGH" || rawPriority.includes("P2")) priority = "HIGH";
    else if (rawPriority === "LOW" || rawPriority.includes("P4")) priority = "LOW";
    else priority = "MEDIUM"; // Maps "NORMAL", "MODERATE", etc.

    let sentinelStatus = "PENDING";
    if (status.includes("PROGRESS") || status.includes("WORKING")) sentinelStatus = "PROGRESS";
    else if (status.includes("CLOSED") || status.includes("RESOLVED") || status.includes("COMPLETED")) sentinelStatus = "COMPLETE";
    else if (priority === "CRITICAL") sentinelStatus = "URGENT";

    let targetAssignee = "ETM-AG-EMP-R62";
    let targetDept = defaultDept;

    if (assigneeEmail) {
      const emp = await env.DB.prepare(
        "SELECT employee_id, dept_id FROM employees WHERE tenant_id = ? AND LOWER(email) = LOWER(?)"
      ).bind(tenantId, assigneeEmail).first();
      if (emp) {
        targetAssignee = emp.employee_id;
        targetDept = emp.dept_id || defaultDept;
      }
    }

    const taskTitle = `[Salesforce ${caseId}] ${subject}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'SALESFORCE_GATEWAY', 'SALESFORCE')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `).bind(caseId, tenantId, targetDept, targetAssignee, taskTitle, priority, sentinelStatus).run();

    return { status: "SALESFORCE_SYNCED", caseId, taskTitle, sentinelStatus };
  } catch (err) {
    return { error: err.message };
  }
}
