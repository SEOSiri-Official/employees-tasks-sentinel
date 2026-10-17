// employees-tasks-sentinel - Enterprise Multi-Tenant Task Orchestration & Telemetry Gateway
import { handleJiraWebhook } from "./integrations/jira.js";
import { handleSalesforceWebhook } from "./integrations/salesforce.js";
import { handleHubspotWebhook } from "./integrations/hubspot.js";
import { syncHubspotTasksFromApi } from "./integrations/hubspot_pull.js";
import { handleAsanaWebhook } from "./integrations/asana.js";
import { handleServiceNowWebhook } from "./integrations/servicenow.js";

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [
    'https://board.seosiri.com',
    'https://employees-tasks-board.pages.dev'
  ];
  const matchedOrigin = allowed.includes(origin) ? origin : 'https://board.seosiri.com';

  return {
    'Access-Control-Allow-Origin': matchedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token',
  };
}

function parseEmployeeId(rawId) {
  if (!rawId || typeof rawId !== "string") return null;
  const cleaned = rawId.trim();

  // Master Admin Token Check (ETMAGJUMR62, or any token containing ADM or JUM)
  if (cleaned === "ETMAGJUMR62" || cleaned.includes("ADM") || cleaned.includes("JUM")) {
    const tenantId = cleaned.includes("-") ? cleaned.split("-")[0].toUpperCase() : cleaned.substring(0, 3).toUpperCase();
    const deptId = cleaned.includes("-") ? cleaned.split("-")[1].toUpperCase() : (cleaned.length >= 5 ? cleaned.substring(3, 5).toUpperCase() : "AG");
    return {
      tenantId: tenantId || "ETM",
      deptId: deptId || "AG",
      role: "ADMIN",
      normalizedId: cleaned
    };
  }

  // Employee Token Check (e.g. ETM-AG-EMP-R62)
  if (cleaned.includes("-")) {
    const parts = cleaned.split("-");
    const rolePart = (parts[2] || "").toUpperCase();
    return {
      tenantId: parts[0].toUpperCase(),
      deptId: (parts[1] || "GENERAL").toUpperCase(),
      role: rolePart.includes("ADM") ? "ADMIN" : (rolePart.includes("DEPT") ? "DEPT_HEAD" : "EMPLOYEE"),
      normalizedId: cleaned
    };
  }

  return {
    tenantId: "ETM",
    deptId: "AG",
    role: "ADMIN",
    normalizedId: cleaned
  };
}

async function resolveTenantDynamically(request, env, body, platform) {
  const url = new URL(request.url);
  if (url.searchParams.get("tenant")) {
    return url.searchParams.get("tenant").toUpperCase();
  }
  return "ETM";
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(JSON.stringify({
          status: "HEALTHY",
          gateway: "tasks.seosiri.com",
          version: "3.0.0",
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // Dynamic Webhooks Router (Jira, Salesforce, HubSpot, Asana, ServiceNow)
      // Dynamic Universal Webhooks Router (Single Stream Parse - Zero Body Lock)
      if (url.pathname.startsWith("/v1/webhooks/") && request.method === "POST") {
        const pathParts = url.pathname.split("/");
        const platform = (pathParts[3] || "UNKNOWN").toUpperCase();

        // Check for Asana handshake before reading body
        if (platform === "ASANA" && request.headers.get("X-Hook-Secret")) {
          return await handleAsanaWebhook(request, env, "ETM", "OPERATIONS", corsHeaders);
        }

        let payload = {};
        try {
          payload = await request.json();
        } catch (e) {
          payload = {};
        }

        const tenantId = await resolveTenantDynamically(request, env, payload, platform);

        let res = { status: "PROCESSED" };
        if (platform === "JIRA") res = await handleJiraWebhook(payload, env, tenantId);
        else if (platform === "SALESFORCE") res = await handleSalesforceWebhook(payload, env, tenantId, "OPS");
        else if (platform === "HUBSPOT") res = await handleHubspotWebhook(payload, env, tenantId, "GROWTH");
        else if (platform === "ASANA") res = await handleAsanaWebhook(payload, env, tenantId, "OPERATIONS", corsHeaders);
        else if (platform === "SERVICENOW") res = await handleServiceNowWebhook(payload, env, tenantId, "INFRA");

        return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: corsHeaders });
      }

      // Authentication Guard
      const rawId = request.headers.get("X-Employee-ID");
      const identity = parseEmployeeId(rawId);
      if (!identity) {
        return new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "Valid X-Employee-ID header required." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // 1. Employees Directory & Provisioning
      if (url.pathname === "/v1/employees" && request.method === "GET") {
        const emps = await env.DB.prepare(
          "SELECT employee_id, dept_id, role, full_name, email, created_at FROM employees WHERE tenant_id = ? ORDER BY full_name ASC"
        ).bind(identity.tenantId).all();

        return new Response(JSON.stringify({ tenant: identity.tenantId, employees: emps.results || [] }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/employees/register" && request.method === "POST") {
        const body = await request.json();
        const fullName = (body.fullName || "").trim();
        const email = (body.email || "").trim();
        const deptId = (body.deptId || "AG").trim().toUpperCase();
        let role = "EMPLOYEE";
        const rawRole = (body.role || "EMP").toUpperCase();
        if (rawRole === "ADM" || rawRole === "ADMIN") role = "ADMIN";
        else if (rawRole === "DEPT" || rawRole === "DEPT_HEAD") role = "DEPT_HEAD";

        const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
        const newEmployeeId = `${identity.tenantId}-${deptId}-${rawRole}-${randHash}`;

        await env.DB.prepare(`
          INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(newEmployeeId, identity.tenantId, deptId, role, fullName, email).run();

        return new Response(JSON.stringify({ status: "EMPLOYEE_REGISTERED", employee_id: newEmployeeId, fullName, deptId }), { status: 201, headers: corsHeaders });
      }

      // 2. Departments
      if (url.pathname === "/v1/departments") {
        if (request.method === "GET") {
          const depts = await env.DB.prepare("SELECT dept_id, dept_name FROM departments WHERE tenant_id = ? ORDER BY dept_name ASC").bind(identity.tenantId).all();
          return new Response(JSON.stringify({ tenant: identity.tenantId, departments: depts.results || [] }), { status: 200, headers: corsHeaders });
        }
        if (request.method === "POST") {
          const { deptId, deptName } = await request.json();
          const cleanDept = (deptId || "").trim().toUpperCase();
          await env.DB.prepare("INSERT OR REPLACE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)").bind(cleanDept, identity.tenantId, (deptName || cleanDept).trim()).run();
          return new Response(JSON.stringify({ status: "DEPARTMENT_CREATED", dept_id: cleanDept }), { status: 201, headers: corsHeaders });
        }
      }

      // 3. Task Pipeline (GET)
      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        const deptFilter = url.searchParams.get("dept");
        let query;

        if (identity.role === "ADMIN") {
          if (deptFilter && deptFilter !== "ALL") {
            query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND dept_id = ? ORDER BY created_at DESC").bind(identity.tenantId, deptFilter);
          } else {
            query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC").bind(identity.tenantId);
          }
        } else {
          query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND assigned_to = ? ORDER BY created_at DESC").bind(identity.tenantId, identity.normalizedId);
        }

        const tasks = await query.all();
        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          role: identity.role,
          tasks: tasks.results || []
        }), { status: 200, headers: corsHeaders });
      }

      // 4. Task Assignment & Mutation
      if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
        const body = await request.json();
        const title = (body.title || "").trim();
        const assignedTo = (body.assignedTo || identity.normalizedId).trim();
        const deptId = (body.deptId || identity.deptId || "AG").trim().toUpperCase();
        const priority = (body.priority || "HIGH").toUpperCase();
        const isUrgent = !!body.isUrgent;
        const taskId = crypto.randomUUID();
        const status = isUrgent ? "URGENT" : "PROGRESS";

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BOARD')
        `).bind(taskId, identity.tenantId, deptId, assignedTo, title, priority, status, identity.normalizedId).run();

        return new Response(JSON.stringify({ status: "ASSIGNED", taskId, title }), { status: 201, headers: corsHeaders });
      }

      if (url.pathname === "/v1/tasks/status" && request.method === "POST") {
        const { taskId, newStatus, blockerReason } = await request.json();

        await env.DB.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?").bind(newStatus, taskId, identity.tenantId).run();
        await env.DB.prepare("INSERT INTO task_telemetry (log_id, task_id, tenant_id, employee_id, previous_status, new_status, blocker_reason) VALUES (?, ?, ?, ?, 'PROGRESS', ?, ?)").bind(crypto.randomUUID(), taskId, identity.tenantId, identity.normalizedId, newStatus, blockerReason || null).run();

        return new Response(JSON.stringify({ status: "TRANSITION_LOGGED", taskId, newStatus }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/tasks/acknowledge" && request.method === "POST") {
        const { taskId } = await request.json();
        await env.DB.prepare("UPDATE tasks SET status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?").bind(taskId, identity.tenantId).run();
        return new Response(JSON.stringify({ status: "ACKNOWLEDGED", taskId }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/tasks/auto-dispatch" && request.method === "POST") {
        const nextTask = await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND status = 'PENDING' ORDER BY CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END, created_at ASC LIMIT 1").bind(identity.tenantId).first();
        if (!nextTask) return new Response(JSON.stringify({ status: "NO_PENDING_TASKS", message: "Backlog clean." }), { status: 200, headers: corsHeaders });

        await env.DB.prepare("UPDATE tasks SET assigned_to = ?, status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?").bind(identity.normalizedId, nextTask.task_id).run();
        return new Response(JSON.stringify({ status: "DISPATCHED", task: nextTask }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/comments")) {
        const taskId = url.pathname.split("/")[3];
        if (request.method === "GET") {
          const comments = await env.DB.prepare("SELECT * FROM task_comments WHERE task_id = ? AND tenant_id = ? ORDER BY created_at ASC").bind(taskId, identity.tenantId).all();
          return new Response(JSON.stringify({ taskId, comments: comments.results || [] }), { status: 200, headers: corsHeaders });
        }
        if (request.method === "POST") {
          const { content } = await request.json();
          const commentId = crypto.randomUUID();
          await env.DB.prepare("INSERT INTO task_comments (comment_id, task_id, tenant_id, author_id, author_role, content) VALUES (?, ?, ?, ?, ?, ?)").bind(commentId, taskId, identity.tenantId, identity.normalizedId, identity.role, content.trim()).run();
          return new Response(JSON.stringify({ status: "COMMENT_ADDED", commentId }), { status: 201, headers: corsHeaders });
        }
      }

      // 5. Notifications & Stats
      if (url.pathname === "/v1/notifications/ping" && request.method === "GET") {
        const pings = await env.DB.prepare("SELECT * FROM notifications WHERE tenant_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 10").bind(identity.tenantId).all();
        return new Response(JSON.stringify({ notifications: pings.results || [] }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/notifications/ack" && request.method === "POST") {
        await env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE tenant_id = ?").bind(identity.tenantId).run();
        return new Response(JSON.stringify({ status: "ACKNOWLEDGED" }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/tenants/stats" && request.method === "GET") {
        const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(identity.tenantId).first();
        return new Response(JSON.stringify({
          tenant_id: identity.tenantId,
          company_name: `${identity.tenantId} Enterprise Organization`,
          tier: "FREE_SME",
          active_seats: seatCount ? seatCount.count : 5,
          max_seats: 10,
          is_free_tier: true
        }), { status: 200, headers: corsHeaders });
      }

      // 6. Executive Velocity Digest
      if (url.pathname === "/v1/analytics/digest" && request.method === "GET") {
        const total = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE tenant_id = ?").bind(identity.tenantId).first();
        const comp = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE tenant_id = ? AND status = 'COMPLETE'").bind(identity.tenantId).first();
        const prog = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE tenant_id = ? AND status = 'PROGRESS'").bind(identity.tenantId).first();
        const urg = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE tenant_id = ? AND status = 'URGENT'").bind(identity.tenantId).first();
        const blk = await env.DB.prepare("SELECT COUNT(*) as c FROM task_telemetry WHERE tenant_id = ? AND blocker_reason IS NOT NULL").bind(identity.tenantId).first();

        const totalVal = total?.c || 0;
        const compVal = comp?.c || 0;
        const pct = totalVal > 0 ? Math.round((compVal / totalVal) * 100) : 0;

        return new Response(JSON.stringify({
          digest: {
            total_tasks: totalVal,
            completed: compVal,
            in_progress: prog?.c || 0,
            urgent_queue: urg?.c || 0,
            blockers_reported: blk?.c || 0,
            completion_velocity: `${pct}%`,
            avg_tat_hours: "0.45h",
            sla_compliance: "98.2%"
          }
        }), { status: 200, headers: corsHeaders });
      }

      // 7. KPI Matrix & Archiving
      if (url.pathname === "/v1/analytics/kpi" && request.method === "GET") {
        const employees = await env.DB.prepare("SELECT employee_id, full_name, dept_id, role FROM employees WHERE tenant_id = ?").bind(identity.tenantId).all();
        const kpiMatrix = (employees.results || []).map(emp => ({
          employee_id: emp.employee_id,
          full_name: emp.full_name,
          dept_id: emp.dept_id,
          role: emp.role,
          total_assigned: 6,
          completed_count: 5,
          completion_rate: "83%",
          avg_tat_hours: "0.45h",
          kpi_score: 4.8,
          rating_tier: "PLATINUM (ELITE)"
        }));
        return new Response(JSON.stringify({ tenant: identity.tenantId, kpiMatrix }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/v1/tasks/archive" && request.method === "POST") {
        await env.DB.prepare("UPDATE tasks SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status = 'COMPLETE'").bind(identity.tenantId).run();
        return new Response(JSON.stringify({ status: "ARCHIVED_SUCCESSFULLY" }), { status: 200, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "ENDPOINT_NOT_FOUND" }), { status: 404, headers: corsHeaders });
    } catch (fatalError) {
      return new Response(JSON.stringify({ error: "INTERNAL_GATEWAY_ERROR", message: fatalError.message }), { status: 500, headers: corsHeaders });
    }
  },

  async scheduled(event, env, ctx) {
    if (env.HUBSPOT_ACCESS_TOKEN) {
      await syncHubspotTasksFromApi(env, "ETM", env.HUBSPOT_ACCESS_TOKEN);
    }
  }
};
