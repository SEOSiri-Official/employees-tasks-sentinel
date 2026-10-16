import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleAsanaWebhook(request, env, tenantId, defaultDept = "OPERATIONS", corsHeaders = {}) {
  const hookSecret = request.headers.get("X-Hook-Secret");
  if (hookSecret) {
    return new Response(null, { status: 200, headers: { "X-Hook-Secret": hookSecret, ...corsHeaders } });
  }

  try {
    const payload = await request.json();
    const events = payload.events || [payload];

    for (const ev of events) {
      const resource = ev.resource || ev.data || ev;
      const asanaGid = resource.gid || `ASANA-${Date.now().toString().slice(-6)}`;
      const taskName = resource.name || `Asana Deliverable #${String(asanaGid).slice(-6)}`;
      const completed = ev.action === "completed" || resource.completed || false;
      const status = completed ? "COMPLETE" : "PROGRESS";
      const priority = normalizePriority(resource.priority);

      const assigneeInfo = await resolveAssignee(env, tenantId, resource.assignee?.name, resource.assignee?.email);
      const dueDate = resource.due_on ? new Date(resource.due_on).toISOString() : null;
      const description = resource.notes || "";
      const taskTitle = `[Asana] ${taskName}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, deadline, created_by, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASANA_GATEWAY', 'ASANA')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          assigned_to = excluded.assigned_to,
          deadline = excluded.deadline,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(asanaGid), tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, dueDate).run();
    }

    return new Response(JSON.stringify({ status: "ASANA_SYNCED", count: events.length }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
