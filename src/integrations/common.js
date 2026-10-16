// src/integrations/common.js - Universal Normalizer & Identity Resolver

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
  return "MEDIUM"; // Universal default for "Normal", "Moderate", "3", or unlisted strings
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
  return "PENDING"; // Universal default for "To Do", "Open", "New", "Backlog", "Waiting", "On Hold"
}

export async function resolveAssignee(env, tenantId, rawAssignee, email) {
  if (email) {
    const cleanEmail = email.trim().toLowerCase();
    const matched = await env.DB.prepare(
      "SELECT employee_id, full_name, dept_id FROM employees WHERE tenant_id = ? AND LOWER(email) = ?"
    ).bind(tenantId, cleanEmail).first();
    if (matched) {
      return { id: matched.employee_id, name: matched.full_name, deptId: matched.dept_id };
    }
  }

  // If no internal record exists, return the platform's real human name or "Unassigned"
  const displayName = rawAssignee && String(rawAssignee).trim() ? String(rawAssignee).trim() : "Unassigned";
  return { id: displayName, name: displayName, deptId: null };
}
