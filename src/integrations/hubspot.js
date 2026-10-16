import { normalizePriority, normalizeStatus, resolveAssignee } from "./common.js";

export async function handleHubspotWebhook(request, env, tenantId, defaultDept = "GROWTH") {
  try {
    const rawPayload = await request.json();
    const events = Array.isArray(rawPayload) ? rawPayload : [rawPayload];

    for (const item of events) {
      const ticketId = item.objectId || item.ticketId || item.id || `HS-${Date.now().toString().slice(-6)}`;
      const properties = item.properties || {};
      const subject = properties.subject?.value || properties.ticketName || item.subject || `HubSpot Item #${ticketId}`;
      const status = normalizeStatus(properties.hs_pipeline_stage?.value || item.propertyValue || item.stage);
      const priority = normalizePriority(properties.hs_ticket_priority?.value || item.priority);

      const ownerName = properties.hubspot_owner_id?.label || properties.ticket_owner_name || null;
      const ownerEmail = properties.ticket_owner_email || null;
      const assigneeInfo = await resolveAssignee(env, tenantId, ownerName, ownerEmail, defaultDept);

      const taskTitle = `[HubSpot HS-${ticketId}] ${subject}`;
      const description = properties.content?.value || item.description || "";
      const externalUrl = `https://app.hubspot.com/contacts/3271531/ticket/${ticketId}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, external_url, created_by, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUBSPOT_GATEWAY', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          assigned_to = excluded.assigned_to,
          external_url = excluded.external_url,
          updated_at = CURRENT_TIMESTAMP
      `).bind(String(ticketId), tenantId, defaultDept, assigneeInfo.name, taskTitle, description, priority, status, externalUrl).run();
    }

    return { status: "HUBSPOT_SYNCED", eventsProcessed: events.length };
  } catch (err) {
    return { error: err.message };
  }
}
