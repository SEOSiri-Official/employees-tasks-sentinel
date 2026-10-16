// src/integrations/common.js - Universal Normalizer & Identity Engine with Auto-Provisioning

export function normalizePriority(raw) {
  if (!raw) return "MEDIUM";
  const p = String(raw).trim().toUpperCase();
  if (p === "1" || p.includes("CRITICAL") || p.includes("HIGHEST") || p.includes("URGENT") || p.includes("P1") || p.includes("BLOCKER")) {
    return "CRITICAL";
  }
  if (p === "2" || p.includes("HIGH") || p.includes("P2") || p.includes("MAJOR")) {
    return "HIGH";
  }
  if (p === "4" || p === "5" || p.includes("LOW") || p.includes("LOWEST") || p.includes("P4") || p.includes("P5") || p.includes("MINOR") || p.includes("TRIVIAL") || p.includes("INFORMATIONAL")) {
    return "LOW";
  }
  return "MEDIUM";
}

export function normalizeStatus(raw) {
  if (!raw) return "PENDING";
  const s = String(raw).trim().toUpperCase();
  if (s.includes("PROGRESS") || s.includes("WORKING") || s.includes("ACTIVE") || s.includes("STARTED") || s.includes("INVESTIGAT")) {
    return "PROGRESS";
  }
  if (s.includes("DONE") || s.includes("RESOLVED") || s.includes("CLOSED") || s.includes("COMPLET") || s.includes("WON")) {
    return "COMPLETE";
  }
  if (s.includes("URGENT") || s.includes("EMERGENCY")) {
    return "URGENT";
  }
  return "PENDING";
}

export async function resolveAssignee(env, tenantId, rawAssignee, email, defaultDept = "ENG") {
  let assigneeId = "ETM-AG-EMP-R62";
  let assigneeName = rawAssignee || "System Dispatcher";

  if (email) {
    const cleanEmail = email.trim().toLowerCase();
    const matched = await env.DB.prepare(
      "SELECT employee_id, full_name, dept_id FROM employees WHERE tenant_id = ? AND LOWER(email) = ?"
    ).bind(tenantId, cleanEmail).first();
    
    if (matched) {
      return { id: matched.employee_id, name: matched.full_name, deptId: matched.dept_id };
    } else {
      // Auto-provision missing employee from webhook email to satisfy foreign key
      const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
      assigneeId = `${tenantId}-${defaultDept}-EMP-${randHash}`;
      assigneeName = rawAssignee || cleanEmail.split("@")[0];
      
      await env.DB.prepare(`
        INSERT OR IGNORE INTO employees (employee_id, tenant_id, dept_id, role, full_name, email)
        VALUES (?, ?, ?, 'EMPLOYEE', ?, ?)
      `).bind(assigneeId, tenantId, defaultDept, assigneeName, cleanEmail).run().catch(() => {});
      
      return { id: assigneeId, name: assigneeName, deptId: defaultDept };
    }
  }

  return { id: assigneeId, name: assigneeName, deptId: defaultDept };
}
