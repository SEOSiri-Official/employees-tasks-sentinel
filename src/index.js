// src/index.js - SEOSiri Global Workforce & Task Intelligence Gateway

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
};

function parseEmployeeId(rawId) {
  if (!rawId) return null;
  const cleaned = rawId.trim().toUpperCase();

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

async function ensureTenantAndEmployee(env, tenantId, deptId, employeeId, role = "EMPLOYEE") {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, company_name) VALUES (?, ?)"
  ).bind(tenantId, `${tenantId} Enterprise Group`).run();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)"
  ).bind(deptId || "GENERAL", tenantId, `${deptId || "General"} Department`).run();

  if (employeeId) {
    // Check if employee already exists
    const existing = await env.DB.prepare(
      "SELECT employee_id FROM employees WHERE employee_id = ? AND tenant_id = ?"
    ).bind(employeeId, tenantId).first();

    if (!existing) {
      // Enforce 10-seat cap for new auto-provisioned employees
      const tenant = await env.DB.prepare("SELECT tier, max_seats FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
      const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(tenantId).first();
      const current = seatCount ? seatCount.count : 0;
      const maxAllowed = tenant ? tenant.max_seats : 10;

      if ((!tenant || tenant.tier === "FREE_SME") && current >= maxAllowed) {
        throw new Error(`SEAT_LIMIT_REACHED: Organization has reached the free cap (${maxAllowed} seats). Upgrade via developers.seosiri.com/#key-issuer`);
      }

      await env.DB.prepare(
        "INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(employeeId, tenantId, deptId || "GENERAL", role, `Member ${employeeId}`, `${employeeId.toLowerCase()}@seosiri.com`).run();
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "HEALTHY",
        service: "SEOSiri Global Task Sentinel Gateway",
        gateway: "tasks.seosiri.com",
        engine: "Edge Multi-Tenant D1",
        version: "1.2.0",
        timestamp: new Date().toISOString()
      }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

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
      if (identity) {
        await ensureTenantAndEmployee(env, identity.tenantId, identity.deptId, identity.normalizedId, identity.role);
      }

            // =====================================================================
      // 1B. TENANT LICENSE ACTIVATION & SEAT STATS
      // =====================================================================
      if (url.pathname === "/v1/tenants/license" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin role required to activate license." }), { status: 403, headers: CORS_HEADERS });
        }

        const { licenseToken } = await request.json();
        if (!licenseToken || typeof licenseToken !== "string") {
          return new Response(JSON.stringify({ error: "INVALID_TOKEN", message: "License token string required." }), { status: 400, headers: CORS_HEADERS });
        }

        const isEnterprise = licenseToken.startsWith("ENT_");
        const newTier = isEnterprise ? "ENTERPRISE" : "PRO";
        const newMaxSeats = isEnterprise ? 5000 : 250;

        await env.DB.prepare(
          "UPDATE tenants SET tier = ?, license_token = ?, max_seats = ? WHERE tenant_id = ?"
        ).bind(newTier, licenseToken.trim(), newMaxSeats, identity.tenantId).run();

        return new Response(JSON.stringify({
          status: "LICENSE_ACTIVATED",
          tenant: identity.tenantId,
          tier: newTier,
          max_seats: newMaxSeats,
          activated_at: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      if (url.pathname === "/v1/tenants/stats" && request.method === "GET") {
        const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE tenant_id = ?").bind(identity.tenantId).first();
        const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(identity.tenantId).first();
        const activeSeats = seatCount ? seatCount.count : 0;
        const maxSeats = tenant ? tenant.max_seats : 10;
        const currentTier = tenant ? tenant.tier : "FREE_SME";

        return new Response(JSON.stringify({
          tenant_id: identity.tenantId,
          company_name: tenant ? tenant.company_name : `${identity.tenantId} Group`,
          tier: currentTier,
          active_seats: activeSeats,
          max_seats: maxSeats,
          is_free_tier: currentTier === "FREE_SME"
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

            // =====================================================================
      // DYNAMIC DEPARTMENT ENGINE (FOR ANY GLOBAL ENTERPRISE)
      // =====================================================================
      if (url.pathname === "/v1/departments" && request.method === "GET") {
        let depts = await env.DB.prepare(
          "SELECT dept_id, dept_name FROM departments WHERE tenant_id = ? ORDER BY dept_name ASC"
        ).bind(identity.tenantId).all();

        // If company has no departments yet, auto-seed standard universal defaults
        if (!depts.results || depts.results.length === 0) {
          const defaultSeeds = [
            ["OPERATIONS", "Operations & Delivery"],
            ["ENGINEERING", "Engineering & Tech"],
            ["GROWTH", "Sales & Marketing"],
            ["EXECUTIVE", "Leadership & Strategy"]
          ];
          for (const [dId, dName] of defaultSeeds) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)"
            ).bind(dId, identity.tenantId, dName).run();
          }
          depts = await env.DB.prepare(
            "SELECT dept_id, dept_name FROM departments WHERE tenant_id = ? ORDER BY dept_name ASC"
          ).bind(identity.tenantId).all();
        }

        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          departments: depts.results
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      if (url.pathname === "/v1/departments" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Only Admins can add departments." }), { status: 403, headers: CORS_HEADERS });
        }

        const { deptId, deptName } = await request.json();
        if (!deptId || !deptName) {
          return new Response(JSON.stringify({ error: "INVALID_PAYLOAD", message: "deptId and deptName required." }), { status: 400, headers: CORS_HEADERS });
        }

        const cleanDeptId = deptId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
        await env.DB.prepare(
          "INSERT OR REPLACE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)"
        ).bind(cleanDeptId, identity.tenantId, deptName.trim()).run();

        return new Response(JSON.stringify({
          status: "DEPARTMENT_CREATED",
          dept_id: cleanDeptId,
          dept_name: deptName.trim()
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // 1. REGISTER EMPLOYEE & 10-SEAT FREEMIUM CHECK
      if (url.pathname === "/v1/employees/register" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin role required." }), { status: 403, headers: CORS_HEADERS });
        }

        const body = await request.json();
        const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE tenant_id = ?").bind(identity.tenantId).first();
        const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(identity.tenantId).first();
        const currentSeats = seatCount ? seatCount.count : 0;

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

        await env.DB.prepare(
          "INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(newEmpId, identity.tenantId, body.deptId || identity.deptId, body.role || "EMPLOYEE", body.fullName, body.email).run();

        return new Response(JSON.stringify({
          status: "REGISTERED",
          employee_id: newEmpId,
          total_active_seats: currentSeats + 1
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // 2. ASSIGN SINGLE TASK
      if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
        if (identity.role !== "ADMIN" && identity.role !== "DEPT_HEAD") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin or Dept Head required." }), { status: 403, headers: CORS_HEADERS });
        }

        const body = await request.json();
        const taskId = body.taskId || crypto.randomUUID();
        const isUrgent = Boolean(body.isUrgent);
        const status = isUrgent ? "URGENT" : "PENDING";
        const assignedTo = body.assignedTo || identity.normalizedId;

        await ensureTenantAndEmployee(env, identity.tenantId, body.deptId || identity.deptId, assignedTo, "EMPLOYEE");

        await env.DB.prepare(
          "INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          taskId,
          identity.tenantId,
          body.deptId || identity.deptId,
          assignedTo,
          body.title,
          body.description || "",
          body.priority || "MEDIUM",
          status,
          identity.normalizedId
        ).run();

        if (isUrgent) {
          await env.DB.prepare(
            "INSERT INTO notifications (notification_id, tenant_id, target_id, dept_id, type, title, message, task_id) VALUES (?, ?, ?, ?, 'URGENT_TASK', ?, ?, ?)"
          ).bind(
            crypto.randomUUID(),
            identity.tenantId,
            assignedTo,
            body.deptId || identity.deptId,
            `Urgent Task: ${body.title}`,
            `High-priority task assigned by ${identity.normalizedId}`,
            taskId
          ).run();
        }

        return new Response(JSON.stringify({
          status: "ASSIGNED",
          task_id: taskId,
          assigned_to: assignedTo,
          state: status,
          ping_dispatched: isUrgent
        }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      // 3. BULK CSV/JSON INGESTION
      if (url.pathname === "/v1/tasks/bulk" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Admin role required." }), { status: 403, headers: CORS_HEADERS });
        }

        const { tasks } = await request.json();
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return new Response(JSON.stringify({ error: "INVALID_BATCH" }), { status: 400, headers: CORS_HEADERS });
        }

        for (const t of tasks) {
          if (t.assignedTo) {
            await ensureTenantAndEmployee(env, identity.tenantId, t.deptId || identity.deptId, t.assignedTo, "EMPLOYEE");
          }
        }

        const statements = tasks.map(t => env.DB.prepare(
          "INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, description, priority, status, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CSV_IMPORT', ?) ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, priority = excluded.priority"
        ).bind(
          t.taskId || crypto.randomUUID(),
          identity.tenantId,
          t.deptId || identity.deptId,
          t.assignedTo || identity.normalizedId,
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

      // 4. FETCH TASKS (Role-Partitioned)
      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        let query;
        const filterDept = url.searchParams.get("dept");
        if (identity.role === "ADMIN") {
          if (filterDept && filterDept !== "ALL") {
            query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? AND dept_id = ? ORDER BY created_at DESC").bind(identity.tenantId, filterDept);
          } else {
            query = env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC").bind(identity.tenantId);
          }
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

      // 5. STATUS TRANSITION & BLOCKER ESCALATION
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

        await env.DB.prepare(
          "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?"
        ).bind(newStatus, taskId, identity.tenantId).run();

        // Compute exact elapsed transition seconds
        const elapsedSeconds = currentTask.updated_at 
          ? Math.max(0, Math.round((Date.now() - new Date(currentTask.updated_at).getTime()) / 1000))
          : 0;

        await env.DB.prepare(
          "INSERT INTO task_telemetry (log_id, task_id, tenant_id, employee_id, previous_status, new_status, blocker_reason, transition_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          crypto.randomUUID(), taskId, identity.tenantId, identity.normalizedId, currentTask.status, newStatus, blockerReason || null, elapsedSeconds
        ).run();

        if (blockerReason) {
          await env.DB.prepare(
            "INSERT INTO notifications (notification_id, tenant_id, target_id, dept_id, type, title, message, task_id) VALUES (?, ?, 'DEPT_HEAD', ?, 'BLOCKER_ESCALATION', ?, ?, ?)"
          ).bind(
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

      // 6. AUTONOMOUS PINGS
      if (url.pathname === "/v1/notifications/ping" && request.method === "GET") {
        let pingsQuery;
        if (identity.role === "ADMIN") {
          pingsQuery = env.DB.prepare(
            "SELECT * FROM notifications WHERE tenant_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 20"
          ).bind(identity.tenantId);
        } else if (identity.role === "DEPT_HEAD") {
          pingsQuery = env.DB.prepare(
            "SELECT * FROM notifications WHERE tenant_id = ? AND (dept_id = ? OR target_id = ?) AND is_read = 0 ORDER BY created_at DESC LIMIT 20"
          ).bind(identity.tenantId, identity.deptId, identity.normalizedId);
        } else {
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

      // Acknowledge Ping
      if (url.pathname === "/v1/notifications/ack" && request.method === "POST") {
        const { notificationId } = await request.json();
        await env.DB.prepare(
          "UPDATE notifications SET is_read = 1 WHERE notification_id = ? AND tenant_id = ?"
        ).bind(notificationId, identity.tenantId).run();

        return new Response(JSON.stringify({ status: "ACKNOWLEDGED" }), { status: 200, headers: CORS_HEADERS });
      }

      // 7. EXECUTIVE SUMMARY DIGEST
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
