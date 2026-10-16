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
      issue.fields?.assignee?.emailAddress,
      targetDept
    );

    const labelsArray = Array.isArray(issue.fields?.labels) ? issue.fields.labels : [];
    const labelsStr = labelsArray.join(", ");
    const labelTag = labelsArray.length > 0 ? ` [${labelsStr}]` : "";
    const taskTitle = `[Jira ${issueKey}]${labelTag} ${summary}`;

    let description = "";
    if (typeof issue.fields?.description === "string") {
      description = issue.fields.description;
    } else if (issue.fields?.description?.content) {
      try {
        description = issue.fields.description.content
          .map(c => c.content ? c.content.map(n => n.text || "").join("") : "")
          .join("\n");
      } catch (e) {
        description = "Atlassian Document Format";
      }
    }

    const dueDate = issue.fields?.duedate ? new Date(issue.fields.duedate).toISOString() : null;
    const jiraDomain = env.DEFAULT_JIRA_DOMAIN || "one-atlas-jkdr.atlassian.net";
    const externalUrl = `https://${jiraDomain}/browse/${issueKey}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, labels, external_url, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'JIRA_WEBHOOK', 'JIRA')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        dept_id = excluded.dept_id,
        deadline = excluded.deadline,
        labels = excluded.labels,
        external_url = excluded.external_url,
        updated_at = CURRENT_TIMESTAMP
    `).bind(issueKey, tenantId, targetDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate, labelsStr, externalUrl).run();

    return { status: "JIRA_SYNCED", issueKey, title: taskTitle, priority, taskStatus: status, assignee: assigneeInfo.name };
  } catch (err) {
    return { error: err.message };
  }
}
