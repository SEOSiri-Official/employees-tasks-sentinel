// src/integrations/outbound.js - Multi-Platform Outbound Status Sync Engine

export async function dispatchOutboundCompletion(env, task) {
  if (!task || !task.source) return;
  const source = task.source.toUpperCase();
  const taskId = task.task_id;

  try {
    // 1. Atlassian Jira Cloud
    if (source === "JIRA" && env.JIRA_BASE_URL && env.JIRA_API_TOKEN) {
      const auth = "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
      const transRes = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${taskId}/transitions`, {
        headers: { "Authorization": auth, "Accept": "application/json" }
      });
      if (transRes.ok) {
        const data = await transRes.json();
        const doneTransition = (data.transitions || []).find(t => 
          t.name.toLowerCase().includes("done") || t.name.toLowerCase().includes("complete") || t.name.toLowerCase().includes("resolved")
        );
        if (doneTransition) {
          await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${taskId}/transitions`, {
            method: "POST",
            headers: { "Authorization": auth, "Content-Type": "application/json" },
            body: JSON.stringify({ transition: { id: doneTransition.id } })
          });
        }
      }
    }

    // 2. HubSpot CRM (Tasks & Tickets)
    if (source === "HUBSPOT" && env.HUBSPOT_ACCESS_TOKEN) {
      const cleanId = taskId.replace(/^HS-/, "");
      await fetch(`https://api.hubapi.com/crm/v3/objects/tasks/${cleanId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { hs_task_status: "COMPLETED" } })
      });
    }

    // 3. Asana Operations
    if (source === "ASANA" && env.ASANA_ACCESS_TOKEN) {
      const cleanGid = taskId.replace(/^ASANA-/, "");
      await fetch(`https://app.asana.com/api/1.0/tasks/${cleanGid}`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${env.ASANA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: { completed: true } })
      });
    }

    // 4. ServiceNow ITSM
    if (source === "SERVICENOW" && env.SERVICENOW_INSTANCE && env.SERVICENOW_PASSWORD) {
      const snowAuth = "Basic " + btoa(`${env.SERVICENOW_USER || "admin"}:${env.SERVICENOW_PASSWORD}`);
      await fetch(`https://${env.SERVICENOW_INSTANCE}.service-now.com/api/now/table/incident/${taskId}`, {
        method: "PATCH",
        headers: { "Authorization": snowAuth, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ state: "6", close_notes: "Completed via SEOSiri Task Sentinel" })
      });
    }

    // 5. Salesforce Service Cloud
    if (source === "SALESFORCE" && env.SALESFORCE_INSTANCE_URL && env.SALESFORCE_ACCESS_TOKEN) {
      await fetch(`${env.SALESFORCE_INSTANCE_URL}/services/data/v60.0/sobjects/Task/${taskId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${env.SALESFORCE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ Status: "Completed" })
      });
    }
  } catch (err) {
    console.error("Outbound completion dispatch failed for source " + source + ":", err);
  }
}
