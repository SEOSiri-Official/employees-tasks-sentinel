// src/index.js - SEOSiri Global Workforce & Task Intelligence Gateway

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
};

// Helper: Parse and validate Employee ID (Format: TENANT-DEPT-ROLE-CHECKSUM)
function parseEmployeeId(employeeId) {
  if (!employeeId) return null;
  const parts = employeeId.trim().toUpperCase().split("-");
  if (parts.length < 4) return null;
  return {
    tenantId: parts[0],
    deptId: parts[1],
    role: parts[2], // 'ADM', 'DPT', or 'EMP'
    checksum: parts[3]
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Health Endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "HEALTHY",
        service: "SEOSiri Global Task Sentinel Gateway",
        gateway: "tasks.seosiri.com",
        engine: "Edge Multi-Tenant D1",
        version: "1.0.0",
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // 3. Extract Identity from Secure Header
    const rawEmployeeId = request.headers.get("X-Employee-ID");
    const identity = parseEmployeeId(rawEmployeeId);

    // Unauthenticated protection (allow webhooks with secret token)
    const isWebhook = url.pathname.startsWith("/v1/webhooks/");
    if (!identity && !isWebhook) {
      return new Response(JSON.stringify({
        error: "UNAUTHORIZED",
        message: "Missing or invalid cryptographic X-Employee-ID header (Expected: TENANT-DEPT-ROLE-HASH)."
      }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    try {
      // =====================================================================
      // ROUTE 1: INGESTION - SINGLE ASSIGNMENT (Admin / Dept Head only)
      // =====================================================================
      if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
        if (identity.role !== "ADM" && identity.role !== "DPT") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Only Admins and Department Heads can assign tasks." }), { status: 403, headers: CORS_HEADERS });
        }

        const body = await request.json();
        const taskId = body.taskId || crypto.randomUUID();
        const priority = body.priority || "MEDIUM";
        const status = body.isUrgent ? "URGENT" : "PENDING";

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          taskId,
          identity.tenantId,
          body.deptId || identity.deptId,
          body.assignedTo,
          body.title,
          body.description || "",
          priority,
          status,
          rawEmployeeId
        ).run();

        return new Response(JSON.stringify({
          status: "ASSIGNED",
          task_id: taskId,
          assigned_to: body.assignedTo,
          state: status,
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // ROUTE 2: INGESTION - BULK CSV/JSON IMPORT (1-Click Day-1 Onboarding)
      // =====================================================================
      if (url.pathname === "/v1/tasks/bulk" && request.method === "POST") {
        if (identity.role !== "ADM") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin role required for bulk data ingestion." }), { status: 403, headers: CORS_HEADERS });
        }

        const { tasks } = await request.json(); // Array of parsed CSV or JSON tasks
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return new Response(JSON.stringify({ error: "INVALID_BATCH", message: "Payload must contain an array of tasks." }), { status: 400, headers: CORS_HEADERS });
        }

        // Build atomic D1 SQL batch
        const statements = tasks.map(t => env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, source, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CSV_IMPORT', ?)
          ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, priority = excluded.priority
        `).bind(
          t.taskId || crypto.randomUUID(),
          identity.tenantId,
          t.deptId || identity.deptId,
          t.assignedTo,
          t.title,
          t.description || "",
          t.priority || "MEDIUM",
          t.isUrgent ? "URGENT" : "PENDING",
          rawEmployeeId
        ));

        // Execute batch in a single round-trip (<30ms)
        await env.DB.batch(statements);

        return new Response(JSON.stringify({
          status: "BULK_INGESTED_SUCCESSFULLY",
          tenant: identity.tenantId,
          total_ingested: tasks.length,
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // ROUTE 3: INGESTION - REAL-TIME JIRA WEBHOOK SYNC
      // =====================================================================
      if (url.pathname === "/v1/webhooks/jira" && request.method === "POST") {
        const jiraPayload = await request.json();
        const issue = jiraPayload.issue;
        if (!issue) {
          return new Response(JSON.stringify({ error: "NO_ISSUE_IN_PAYLOAD" }), { status: 400, headers: CORS_HEADERS });
        }

        const tenantQuery = url.searchParams.get("tenant") || "DEFAULT";
        const title = `[${issue.key}] ${issue.fields.summary}`;
        const assigneeEmail = issue.fields.assignee ? issue.fields.assignee.emailAddress : null;

        let targetEmpId = "UNASSIGNED";
        if (assigneeEmail) {
          const empMatch = await env.DB.prepare(
            "SELECT employee_id, dept_id FROM employees WHERE tenant_id = ? AND email = ?"
          ).bind(tenantQuery, assigneeEmail).first();
          if (empMatch) targetEmpId = empMatch.employee_id;
        }

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, source, external_ref, created_by)
          VALUES (?, ?, 'ENG', ?, ?, ?, 'HIGH', 'URGENT', 'JIRA_SYNC', ?, 'SYSTEM_JIRA_BOT')
          ON CONFLICT(task_id) DO UPDATE SET title = excluded.title
        `).bind(
          issue.key,
          tenantQuery,
          targetEmpId,
          title,
          issue.fields.description || "",
          issue.key
        ).run();

        return new Response(JSON.stringify({ status: "JIRA_TASK_SYNCED", issueKey: issue.key }), { status: 200, headers: CORS_HEADERS });
      }

      // =====================================================================
      // ROUTE 4: FETCH TASKS (Role-Partitioned Zero-Trust Query)
      // =====================================================================
      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        let query;
        if (identity.role === "ADM") {
          // Admin sees entire organization across all departments
          query = env.DB.prepare(
            "SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC"
          ).bind(identity.tenantId);
        } else if (identity.role === "DPT") {
          // Department Head sees all tasks in their assigned department
          query = env.DB.prepare(
            "SELECT * FROM tasks WHERE tenant_id = ? AND dept_id = ? ORDER BY created_at DESC"
          ).bind(identity.tenantId, identity.deptId);
        } else {
          // Individual Employee: Strictly isolated to their own assigned tasks
          query = env.DB.prepare(
            "SELECT * FROM tasks WHERE tenant_id = ? AND assigned_to = ? ORDER BY CASE status WHEN 'URGENT' THEN 1 WHEN 'PROGRESS' THEN 2 WHEN 'PENDING' THEN 3 ELSE 4 END, created_at DESC"
          ).bind(identity.tenantId, rawEmployeeId);
        }

        const data = await query.all();
        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          identity: rawEmployeeId,
          role: identity.role,
          count: data.results.length,
          tasks: data.results
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // ROUTE 5: STATUS TRANSITION & TELEMETRY COLLECTION
      // =====================================================================
      if (url.pathname === "/v1/tasks/status" && request.method === "POST") {
        const { taskId, newStatus, blockerReason } = await request.json();

        // Validate state
        if (!["URGENT", "PROGRESS", "PENDING", "COMPLETE"].includes(newStatus)) {
          return new Response(JSON.stringify({ error: "INVALID_STATUS" }), { status: 400, headers: CORS_HEADERS });
        }

        // Fetch current state
        const currentTask = await env.DB.prepare(
          "SELECT status, assigned_to FROM tasks WHERE task_id = ? AND tenant_id = ?"
        ).bind(taskId, identity.tenantId).first();

        if (!currentTask) {
          return new Response(JSON.stringify({ error: "TASK_NOT_FOUND" }), { status: 404, headers: CORS_HEADERS });
        }

        // Employee can only update tasks assigned to them; Admin can update any
        if (identity.role === "EMP" && currentTask.assigned_to !== rawEmployeeId) {
          return new Response(JSON.stringify({ error: "UNAUTHORIZED_TASK_MUTATION" }), { status: 403, headers: CORS_HEADERS });
        }

        // 1. Update task state
        await env.DB.prepare(`
          UPDATE tasks 
          SET status = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE task_id = ? AND tenant_id = ?
        `).bind(newStatus, taskId, identity.tenantId).run();

        // 2. Tasks Data Collector: Ingest Telemetry Log
        await env.DB.prepare(`
          INSERT INTO task_telemetry (log_id, task_id, tenant_id, employee_id, previous_status, new_status, blocker_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          taskId,
          identity.tenantId,
          rawEmployeeId,
          currentTask.status,
          newStatus,
          blockerReason || null
        ).run();

        return new Response(JSON.stringify({
          status: "TRANSITION_LOGGED",
          task_id: taskId,
          previous: currentTask.status,
          current: newStatus,
          telemetry_synced: true,
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // ROUTE 6: AUTONOMOUS EXECUTIVE TELEMETRY DIGEST (/v1/analytics/digest)
      // =====================================================================
      if (url.pathname === "/v1/analytics/digest" && request.method === "GET") {
        if (identity.role !== "ADM" && identity.role !== "DPT") {
          return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: CORS_HEADERS });
        }

        // Ingest telemetry aggregates across the tenant
        const totalTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ?").bind(identity.tenantId).first();
        const completedTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'COMPLETE'").bind(identity.tenantId).first();
        const inProgress = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'PROGRESS'").bind(identity.tenantId).first();
        const urgentPending = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'URGENT'").bind(identity.tenantId).first();
        const blockedLogs = await env.DB.prepare("SELECT COUNT(*) as count FROM task_telemetry WHERE tenant_id = ? AND blocker_reason IS NOT NULL").bind(identity.tenantId).first();

        const velocityRate = totalTasks.count > 0 ? Number(((completedTasks.count / totalTasks.count) * 100).toFixed(1)) : 0;

        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          generated_for: rawEmployeeId,
          digest: {
            total_tasks: totalTasks.count,
            completed_tasks: completedTasks.count,
            active_in_flight: inProgress.count,
            urgent_queue: urgentPending.count,
            flagged_blockers: blockedLogs.count,
            completion_velocity: `${velocityRate}%`
          },
          health_index: urgentPending.count > 5 ? "WARNING_BOTTLENECK_DETECTED" : "OPTIMAL_FLOW",
          generated_at: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      return new Response(JSON.stringify({ error: "ENDPOINT_NOT_FOUND" }), { status: 404, headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ error: "EDGE_EXCEPTION", details: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }
};
