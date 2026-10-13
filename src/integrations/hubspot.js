export async function handleHubspotWebhook(request, env, tenantId, defaultDept = "GROWTH") {
  try {
    const rawPayload = await request.json();
    const events = Array.isArray(rawPayload) ? rawPayload : [rawPayload];

    for (const item of events) {
      const ticketId = item.objectId || item.ticketId || item.id || `HS-${Date.now().toString().slice(-6)}`;
      const properties = item.properties || {};
      const subject = properties.subject?.value || properties.ticketName || item.subject || `HubSpot Ticket #${ticketId}`;
      const stage = String(properties.hs_pipeline_stage?.value || item.propertyValue || item.stage || "OPEN").toUpperCase();
      const rawPriority = String(properties.hs_ticket_priority?.value || item.priority || "HIGH").toUpperCase();

      // Normalize Priority
      let priority = "HIGH";
      if (rawPriority === "CRITICAL" || rawPriority.includes("URGENT")) priority = "CRITICAL";
      else if (rawPriority === "LOW") priority = "LOW";
      else if (rawPriority === "MEDIUM" || rawPriority === "NORMAL") priority = "MEDIUM";

      let sentinelStatus = "PROGRESS";
      if (stage.includes("CLOSED") || stage.includes("RESOLVED") || stage.includes("WON")) sentinelStatus = "COMPLETE";
      else if (stage.includes("WAITING") || stage.includes("HOLD")) sentinelStatus = "PENDING";

      const taskTitle = `[HubSpot HS-${ticketId}] ${subject}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'HUBSPOT_GATEWAY', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(ticketId), tenantId, defaultDept, taskTitle, priority, sentinelStatus).run();
    }

    return { status: "HUBSPOT_SYNCED", events_processed: events.length };
  } catch (err) {
    return { error: err.message };
  }
}
