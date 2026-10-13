export async function handleHubspotWebhook(request, env, tenantId, defaultDept = "GROWTH") {
  try {
    const rawPayload = await request.json();
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || env.HUBSPOT_ACCESS_TOKEN || "";
    const events = Array.isArray(rawPayload) ? rawPayload : [rawPayload];

    for (const item of events) {
      const ticketId = String(item.objectId || item.ticketId || item.id || `HS-${Date.now().toString().slice(-6)}`);
      const properties = item.properties || {};
      
      let subject = properties.hs_task_subject?.value || 
                    properties.subject?.value || 
                    properties.ticketName || 
                    item.subject || 
                    "";
      
      let stage = String(properties.hs_task_status?.value || 
                         properties.hs_pipeline_stage?.value || 
                         item.propertyValue || 
                         item.stage || 
                         "NOT_STARTED").toUpperCase();

      let rawPriority = String(properties.hs_task_priority?.value || 
                               properties.hs_ticket_priority?.value || 
                               item.priority || 
                               "MEDIUM").toUpperCase();

      // If HubSpot delivered a lightweight event without inline properties, fetch via CRM API
      if (!subject && token) {
        try {
          const objectType = (item.subscriptionType && item.subscriptionType.startsWith("deal")) ? "deals" 
                           : (item.subscriptionType && item.subscriptionType.startsWith("ticket")) ? "tickets" 
                           : "tasks";

          const fetchUrl = `https://api.hubapi.com/crm/v3/objects/${objectType}/${ticketId}?properties=hs_task_subject,hs_task_status,hs_task_priority,subject,hs_pipeline_stage,hs_ticket_priority`;
          const hubRes = await fetch(fetchUrl, {
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json"
            }
          });

          if (hubRes.ok) {
            const hubData = await hubRes.json();
            const p = hubData.properties || {};
            subject = p.hs_task_subject || p.subject || p.dealname || `HubSpot Task #${ticketId}`;
            stage = String(p.hs_task_status || p.hs_pipeline_stage || "IN_PROGRESS").toUpperCase();
            rawPriority = String(p.hs_task_priority || p.hs_ticket_priority || "MEDIUM").toUpperCase();
          }
        } catch (fetchErr) {
          console.error("HubSpot API fetch error:", fetchErr);
        }
      }

      if (!subject) {
        subject = `HubSpot Task #${ticketId}`;
      }

      // Normalize Priority for D1 constraint
      let priority = "MEDIUM";
      if (rawPriority === "CRITICAL" || rawPriority.includes("URGENT") || rawPriority.includes("HIGH")) priority = "HIGH";
      else if (rawPriority.includes("LOW")) priority = "LOW";
      else priority = "MEDIUM";

      let sentinelStatus = "PROGRESS";
      if (stage.includes("COMPLETE") || stage.includes("CLOSED") || stage.includes("RESOLVED")) sentinelStatus = "COMPLETE";
      else if (stage.includes("WAITING") || stage.includes("HOLD") || stage.includes("NOT_STARTED")) sentinelStatus = "PROGRESS";

      const taskTitle = `[HubSpot HS-${ticketId}] ${subject}`;

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
        VALUES (?, ?, ?, 'ETM-AG-EMP-R62', ?, ?, ?, 'HUBSPOT_GATEWAY', 'HUBSPOT')
        ON CONFLICT(task_id) DO UPDATE SET 
          title = excluded.title, 
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).bind(ticketId, tenantId, defaultDept, taskTitle, priority, sentinelStatus).run();
    }

    return { status: "HUBSPOT_SYNCED", events_processed: events.length };
  } catch (err) {
    return { error: err.message };
  }
}
