// src/integrations/jira.js - 100% Dedicated Standalone Jira Ingestion

function normalizeJiraPriority(raw) {
  if (!raw) return "MEDIUM";
  const p = String(raw).trim().toUpperCase();
  if (p === "HIGHEST" || p === "CRITICAL" || p === "BLOCKER") return "CRITICAL";
  if (p === "HIGH" || p === "MAJOR") return "HIGH";
  if (p === "LOW" || p === "LOWEST" || p === "MINOR" || p === "TRIVIAL" || p === "INFORMATIONAL") return "LOW";
  return "MEDIUM";
}

function normalizeJiraStatus(rawStatus) {
  if (!rawStatus) return "PENDING";
  const s = String(rawStatus).trim().toUpperCase();
  if (s.includes("PROGRESS") || s.includes("WORKING") || s.includes("ACTIVE")) return "PROGRESS";
  if (s.includes("DONE") || s.includes("RESOLVED") || s.includes("CLOSED")) return "COMPLETE";
  if (s.includes("URGENT")) return "URGENT";
  return "PENDING"; // "To Do", "Open", "Backlog"
}

export async function handleJiraWebhook(request, env, tenantId, defaultDept = "ENG") {
  try {
    const payload = await request.json();
    const issue = payload.issue;
    if (!issue) {
      return { status: "IGNORED", reason: "No issue object in payload" };
    }

    const issueKey = issue.key; // e.g. EO-21
    const summary = issue.fields?.summary || "Jira Task";
    const priorityName = normalizeJiraPriority(issue.fields?.priority?.name);
    const sentinelStatus = normalizeJiraStatus(issue.fields?.status?.name);

    // Extract department from project key (e.g. EO) or fallback to default
    const targetDept = (issue.fields?.project?.key || defaultDept).toUpperCase();

    // Extract assignee (e.g. Alana Grant) - never fails if unregistered
    const assigneeName = issue.fields?.assignee?.displayName || issue.fields?.assignee?.emailAddress || "Alana Grant";

    // Extract labels (e.g. VIP)
    const labels = Array.isArray(issue.fields?.labels) && issue.fields.labels.length > 0 
      ? ` [${issue.fields.labels.join(", ")}]` 
      : "";
    const taskTitle = `[Jira ${issueKey}]${labels} ${summary}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'JIRA_WEBHOOK', 'JIRA')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        priority = excluded.priority,
        assigned_to = excluded.assigned_to,
        dept_id = excluded.dept_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(issueKey, tenantId, targetDept, assigneeName, taskTitle, priorityName, sentinelStatus).run();

    return {
      status: "JIRA_SYNCED",
      issueKey,
      title: taskTitle,
      priority: priorityName,
      statusName: sentinelStatus,
      dept: targetDept
    };
  } catch (err) {
    return { error: err.message };
  }
}
