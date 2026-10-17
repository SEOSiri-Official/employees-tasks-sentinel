export async function handleJiraWebhook(data, env, tenantId = "ETM", defaultDept = "ENG") {
  try {
    const payload = (data && typeof data.json === "function") ? await data.json() : data;
    const issue = payload.issue || payload;
    
    // Fallback extraction: Even if issue is flat or nested
    const issueKey = issue.key || payload.key || payload.issueKey || `JIRA-${Date.now().toString().slice(-6)}`;
    const fields = issue.fields || payload.fields || {};
    const summary = fields.summary || payload.summary || issue.summary || "Jira Work Deliverable";
    
    // Priority: Never crash, map any string
    const rawPriority = fields.priority?.name || payload.priority || "MEDIUM";
    const priority = normalizePriority(rawPriority);

    // Status: Never crash, map any string
    const rawStatus = fields.status?.name || payload.status || "To Do";
    const status = normalizeStatus(rawStatus);

    // Department: Auto-map from project key
    const targetDept = (fields.project?.key || defaultDept || "ENG").toUpperCase();

    // Assignee: Real human name, or "Unassigned"
    const rawAssignee = fields.assignee?.displayName || fields.assignee?.name || payload.assignee || "Unassigned";

    const labelsArray = Array.isArray(fields.labels) ? fields.labels : [];
    const labelsStr = labelsArray.join(", ");
    const labelTag = labelsArray.length > 0 ? ` [${labelsStr}]` : "";
    const taskTitle = `[JIRA ${issueKey}]${labelTag} ${summary}`;

    const externalUrl = `https://${env.DEFAULT_JIRA_DOMAIN || "one-atlas-jkdr.atlassian.net"}/browse/${issueKey}`;
    const dueDate = fields.duedate ? new Date(fields.duedate).toISOString() : null;

    // Bulletproof Insert: Never fails, always saves
    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, labels, external_url, created_by, source)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'JIRA_GATEWAY', 'JIRA')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        dept_id = excluded.dept_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(issueKey, tenantId, targetDept, rawAssignee, taskTitle, priority, status, dueDate, labelsStr, externalUrl).run();

    return { status: "SUCCESS", platform: "JIRA", taskId: issueKey, title: taskTitle };
  } catch (err) {
    console.error("Catch-All Ingestion Error:", err);
    return { status: "ERROR", error: err.message };
  }
}
