// src/index.js - SEOSiri Global Workforce & Task Intelligence Gateway

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
};

// Robust Parser: Supports BOTH 'ETMAGJUMR62' (compact) and 'ETM-AG-JUM-R62' (hyphenated)
function parseEmployeeId(rawId) {
  if (!rawId) return null;
  const cleaned = rawId.trim().toUpperCase();

  // Hyphenated format: TENANT-DEPT-ROLE-CHECKSUM
  if (cleaned.includes("-")) {
    const parts = cleaned.split("-");
    if (parts.length >= 4) {
      return {
        tenantId: parts[0],
        deptId: parts[1],
        role: parts[2] === "ADM" ? "ADMIN" : parts[2] === "DPT" ? "DEPT_HEAD" : "EMPLOYEE",
        checksum: parts[3],
        normalizedId: cleaned
      };
    }
  }

  // Compact alphanumeric format (e.g. ETMAGJUMR62: 3-char Tenant, 2-char Dept, 3-char Role, remainder Checksum)
  if (cleaned.length >= 10) {
    const tenantId = cleaned.substring(0, 3);
    const deptId = cleaned.substring(3, 5);
    const rawRole = cleaned.substring(5, 8);
    const checksum = cleaned.substring(8);

    let role = "EMPLOYEE";
    if (rawRole === "ADM" || rawRole === "JUM") role = "ADMIN";
    else if (rawRole === "DPT" || rawRole === "HED") role = "DEPT_HEAD";

    return { tenantId, deptId, role, checksum, normalizedId: cleaned };
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Health & Gateway Diagnostics
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "HEALTHY",
        service: "SEOSiri Global Task Sentinel Gateway",
        gateway: "tasks.seosiri.com",
        engine: "Edge Multi-Tenant D1",
        version: "1.1.0",
        timestamp: new Date().toISOString()
      }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    // 3. Authenticate Identity Header
    const rawEmployeeId = request.headers.get("X-Employee-ID");
    const identity = parseEmployeeId(rawEmployeeId);
    const isWebhook = url.pathname.startsWith("/v1/webhooks/");

    if (!identity && !isWebhook) {
      return new Response(JSON.stringify({
        error: "UNAUTHORIZED",
        message: "Missing or invalid X-Employee-ID header (Format: ETMAGJUMR62 or ETM-AG-JUM-R62)."
      }), { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    try {
    // AUTO-PROVISION TENANT IF FIRST TIME ACCESSED
    if (identity && identity.tenantId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (tenant_id, company_name) VALUES (?, ?)"
      ).bind(identity.tenantId, `${identity.tenantId} Enterprise Organization`).run();
    }

      // =====================================================================
      // 1. EMPLOYEE ONBOARDING & 10-SEAT FREEMIUM ENFORCEMENT
      // =====================================================================
      if (url.pathname === "/v1/employees/register" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Only Admins can register employees." }), { status: 403, headers: CORS_HEADERS });
        }

        const body = await request.json();
        const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE tenant_id = ?").bind(identity.tenantId).first();

        // Count current active seats
        const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(identity.tenantId).first();
        const currentSeats = seatCount ? seatCount.count : 0;

        // Freemium Rule: 1-10 Employees Free; >10 requires valid PRO/ENTERPRISE token
        const isFreeTier = !tenant || tenant.tier === "FREE_SME";
        if (isFreeTier && currentSeats >= 10) {
          return new Response(JSON.stringify({
            error: "UPGRADE_REQUIRED",
            message: "SME Free Tier limit reached (10 seats max). Add SEOSiri License Token to unlock unlimited seats.",
            current_seats: currentSeats,
            settlement_contact: "badhan_pbn@yahoo.com",
            portal: "https://developers.seosiri.com/#key-issuer"
          }), { status: 402, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
        }

        const newEmpId = body.employeeId || `${identity.tenantId}${body.deptId || identity.deptId}EMP${Math.random().toString(36).substring(2, 5).toUpperCase()}`;

        await env.DB.prepare(`
          INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(newEmpId, identity.tenantId, body.deptId || identity.deptId, body.role || "EMPLOYEE", body.fullName, body.email).run();

        return new Response(JSON.stringify({
          status: "REGISTERED",
          employee_id: newEmpId,
          total_active_seats: currentSeats + 1
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // 2. TASK INGESTION: SINGLE ASSIGNMENT
      // =====================================================================
      if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
        if (identity.role !== "ADMIN" && identity.role !== "DEPT_HEAD") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin or Dept Head required." }), { status: 403, headers: CORS_HEADERS });
        }

        const body = await request.json();
        const taskId = body.taskId || crypto.randomUUID();
        const isUrgent = Boolean(body.isUrgent);
        const status = isUrgent ? "URGENT" : "PENDING";

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
          body.priority || "MEDIUM",
          status,
          identity.normalizedId
        ).run();

        // If Urgent, auto-dispatch a Ping Notification to the assigned employee
        if (isUrgent) {
          await env.DB.prepare(`
            INSERT INTO notifications (notification_id, tenant_id, target_id, dept_id, type, title, message, task_id)
            VALUES (?, ?, ?, ?, 'URGENT_TASK', ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            identity.tenantId,
            body.assignedTo,
            body.deptId || identity.deptId,
            `Urgent Task: ${body.title}`,
            `High-priority task assigned by ${identity.normalizedId}`,
            taskId
          ).run();
        }

        return new Response(JSON.stringify({
          status: "ASSIGNED",
          task_id: taskId,
          assigned_to: body.assignedTo,
          state: status,
          ping_dispatched: isUrgent
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // 3. TASK INGESTION: BULK CSV/JSON IMPORT
      // =====================================================================
      if (url.pathname === "/v1/tasks/bulk" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin role required." }), { status: 403, headers: CORS_HEADERS });
        }

        const { tasks } = await request.json();
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return new Response(JSON.stringify({ error: "INVALID_BATCH" }), { status: 400, headers: CORS_HEADERS });
        }

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
          identity.normalizedId
        ));

        await env.DB.batch(statements);

        return new Response(JSON.stringify({
          status: "BULK_INGESTED_SUCCESSFULLY",
          tenant: identity.tenantId,
          total_ingested: tasks.length
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // 4. FETCH TASKS (Role-Partitioned Zero-Trust Query)
      // =====================================================================
      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        let query;
        if (identity.role === "ADMIN") {
          query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC").bind(identity.tenantId);
        } else if (identity.role === "DEPT_HEAD") {
          query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND dept_id = ? ORDER BY created_at DESC").bind(identity.tenantId, identity.deptId);
        } else {
          query = env.DB.prepare(
            "SELECT * FROM tasks WHERE tenant_id = ? AND assigned_to = ? ORDER BY CASE status WHEN 'URGENT' THEN 1 WHEN 'PROGRESS' THEN 2 WHEN 'PENDING' THEN 3 ELSE 4 END, created_at DESC"
          ).bind(identity.tenantId, identity.normalizedId);
        }

        const data = await query.all();
        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          user: identity.normalizedId,
          role: identity.role,
          count: data.results.length,
          tasks: data.results
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // 5. STATUS TRANSITION & BLOCKER ESCALATION
      // =====================================================================
      if (url.pathname === "/v1/tasks/status" && request.method === "POST") {
        const { taskId, newStatus, blockerReason } = await request.json();

        if (!["URGENT", "PROGRESS", "PENDING", "COMPLETE"].includes(newStatus)) {
          return new Response(JSON.stringify({ error: "INVALID_STATUS" }), { status: 400, headers: CORS_HEADERS });
        }

        const currentTask = await env.DB.prepare(
          "SELECT status, assigned_to, dept_id, title FROM tasks WHERE task_id = ? AND tenant_id = ?"
        ).bind(taskId, identity.tenantId).first();

        if (!currentTask) {
          return new Response(JSON.stringify({ error: "TASK_NOT_FOUND" }), { status: 404, headers: CORS_HEADERS });
        }

        if (identity.role === "EMPLOYEE" && currentTask.assigned_to !== identity.normalizedId) {
          return new Response(JSON.stringify({ error: "UNAUTHORIZED_TASK_MUTATION" }), { status: 403, headers: CORS_HEADERS });
        }

        // Update task state
        await env.DB.prepare(`
          UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?
        `).bind(newStatus, taskId, identity.tenantId).run();

        // Telemetry Ingestion
        await env.DB.prepare(`
          INSERT INTO task_telemetry (log_id, task_id, tenant_id, employee_id, previous_status, new_status, blocker_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(), taskId, identity.tenantId, identity.normalizedId, currentTask.status, newStatus, blockerReason || null
        ).run();

        // If blocker is logged, auto-escalate Ping to Department Head and Admin
        if (blockerReason) {
          await env.DB.prepare(`
            INSERT INTO notifications (notification_id, tenant_id, target_id, dept_id, type, title, message, task_id)
            VALUES (?, ?, 'DEPT_HEAD', ?, 'BLOCKER_ESCALATION', ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            identity.tenantId,
            currentTask.dept_id,
            `Task Blocked: ${currentTask.title}`,
            `Employee ${identity.normalizedId} reported blocker: ${blockerReason}`,
            taskId
          ).run();
        }

        return new Response(JSON.stringify({
          status: "TRANSITION_LOGGED",
          task_id: taskId,
          current: newStatus,
          blocker_escalated: Boolean(blockerReason)
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // =====================================================================
      // 6. AUTONOMOUS PING NOTIFICATION ENGINE (/v1/notifications/ping)
      // =====================================================================
      if (url.pathname === "/v1/notifications/ping" && request.method === "GET") {
        let pingsQuery;

        if (identity.role === "ADMIN") {
          // Admin sees all unread notices + blocker alerts across company
          pingsQuery = env.DB.prepare(
            "SELECT * FROM notifications WHERE tenant_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 20"
          ).bind(identity.tenantId);
        } else if (identity.role === "DEPT_HEAD") {
          // Dept Head sees department blocker pings and urgent notices
          pingsQuery = env.DB.prepare(
            "SELECT * FROM notifications WHERE tenant_id = ? AND (dept_id = ? OR target_id = ?) AND is_read = 0 ORDER BY created_at DESC LIMIT 20"
          ).bind(identity.tenantId, identity.deptId, identity.normalizedId);
        } else {
          // Employee sees strictly their direct pings (urgent tasks, deadlines)
          pingsQuery = env.DB.prepare(
            "SELECT * FROM notifications WHERE tenant_id = ? AND target_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 10"
          ).bind(identity.tenantId, identity.normalizedId);
        }

        const pings = await pingsQuery.all();

        return new Response(JSON.stringify({
          recipient: identity.normalizedId,
          unread_pings_count: pings.results.length,
          notifications: pings.results
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // Acknowledge / Mark Ping as Read
      if (url.pathname === "/v1/notifications/ack" && request.method === "POST") {
        const { notificationId } = await request.json();
        await env.DB.prepare(
          "UPDATE notifications SET is_read = 1 WHERE notification_id = ? AND tenant_id = ?"
        ).bind(notificationId, identity.tenantId).run();

        return new Response(JSON.stringify({ status: "ACKNOWLEDGED" }), { status: 200, headers: CORS_HEADERS });
      }

      // =====================================================================
      // 7. EXECUTIVE SUMMARY DIGEST (/v1/analytics/digest)
      // =====================================================================
      if (url.pathname === "/v1/analytics/digest" && request.method === "GET") {
        if (identity.role !== "ADMIN" && identity.role !== "DEPT_HEAD") {
          return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: CORS_HEADERS });
        }

        const totalTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ?").bind(identity.tenantId).first();
        const completedTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'COMPLETE'").bind(identity.tenantId).first();
        const inProgress = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'PROGRESS'").bind(identity.tenantId).first();
        const urgentCount = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE tenant_id = ? AND status = 'URGENT'").bind(identity.tenantId).first();
        const blockedCount = await env.DB.prepare("SELECT COUNT(*) as count FROM task_telemetry WHERE tenant_id = ? AND blocker_reason IS NOT NULL").bind(identity.tenantId).first();

        const velocity = totalTasks.count > 0 ? Number(((completedTasks.count / totalTasks.count) * 100).toFixed(1)) : 0;

        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          generated_for: identity.normalizedId,
          digest: {
            total_tasks: totalTasks.count,
            completed: completedTasks.count,
            in_progress: inProgress.count,
            urgent_queue: urgentCount.count,
            blockers_reported: blockedCount.count,
            completion_velocity: `${velocity}%`
          },
          health_state: urgentCount.count > 5 ? "WARNING_BOTTLENECK_DETECTED" : "OPTIMAL_FLOW",
          generated_at: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      return new Response(JSON.stringify({ error: "ENDPOINT_NOT_FOUND" }), { status: 404, headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ error: "EDGE_EXCEPTION", details: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }
};
