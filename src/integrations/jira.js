import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleJiraWebhook(request, env, tenantId, defaultDept = "ENG") {
  try {
    const payload = await request.json();
    const issue = payload.issue;
    if (!issue) return { status: "IGNORED", reason: "No issue object in payload" };

    const issueKey = issue.key;
    const summary = issue.fields?.summary || "Jira Task";
    const priority = normalizePriority(issue.fields?.priority?.name);
    const status = normalizeStatus(issue.fields?.status?.name);
    const targetDept = (issue.fields?.project?.key || defaultDept).toUpperCase();

    const assigneeInfo = await resolveAssignee(
      env, tenantId,
      issue.fields?.assignee?.displayName,
      issue.fields?.assignee?.emailAddress
    );

    const labels = Array.isArray(issue.fields?.labels) && issue.fields.labels.length > 0
      ? ` [${issue.fields.labels.join(", ")}]`
      : "";
    const taskTitle = `[Jira ${issueKey}]${labels} ${summary}`;

    let description = "";
    if (typeof issue.fields?.description === "string") {
      description = issue.fields.description;
    } else if (issue.fields?.description?.content) {
      try { description = JSON.stringify(issue.fields.description); } catch (e) {}
    }

    const dueDate = issue.fields?.duedate ? new Date(issue.fields.duedate).toISOString() : null;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'JIRA_WEBHOOK', 'JIRA')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        dept_id = excluded.dept_id,
        deadline = excluded.deadline,
        updated_at = CURRENT_TIMESTAMP
    `).bind(issueKey, tenantId, targetDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate).run();

    return { status: "JIRA_SYNCED", issueKey, title: taskTitle, priority, taskStatus: status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
