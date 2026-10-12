export async function handleHubspotWebhook(request, env, tenantId, defaultDept = "GROWTH") {
  try {
    const payload = await request.json();
    const ticketId = payload.objectId || payload.ticketId || `HS-${Date.now().toString().slice(-6)}`;
    const properties = payload.properties || {};
    const subject = properties.subject?.value || properties.ticketName || payload.subject || "HubSpot B2B Ticket";
    const stage = (properties.hs_pipeline_stage?.value || payload.stage || "OPEN").toUpperCase();
    const priority = (properties.hs_ticket_priority?.value || payload.priority || "HIGH").toUpperCase();

    let sentinelStatus = "PROGRESS";
    if (stage.includes("CLOSED") || stage.includes("RESOLVED")) sentinelStatus = "COMPLETE";
    else if (stage.includes("WAITING")) sentinelStatus = "PENDING";

    const taskTitle = `[HubSpot ${ticketId}] ${subject}`;

    await env.DB.prepare(`
      INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
      VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'HUBSPOT_GATEWAY', 'HUBSPOT')
      ON CONFLICT(task_id) DO UPDATE SET 
        title = excluded.title, 
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `).bind(String(ticketId), tenantId, defaultDept, taskTitle, priority, sentinelStatus).run();

    return { status: "HUBSPOT_SYNCED", ticketId, taskTitle, sentinelStatus };
  } catch (err) {
    return { error: err.message };
  }
}
