// employees-tasks-sentinel - Enterprise Multi-Tenant Task Orchestration & Telemetry Gateway

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [
    "https://board.seosiri.com",
    "https://employees-tasks-board.pages.dev",
    "https://developers.seosiri.com"
  ];
  const matchedOrigin = allowed.includes(origin) ? origin : "https://board.seosiri.com";

  return {
    "Access-Control-Allow-Origin": matchedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Employee-ID, X-SEOSiri-Token",
  };
}

function parseEmployeeId(rawId) {
  if (!rawId || typeof rawId !== "string") return null;
  const cleaned = rawId.trim();

  // Pattern A: ETM-AG-EMP-R62
  if (cleaned.includes("-")) {
    const parts = cleaned.split("-");
    if (parts.length >= 4) {
      return {
        tenantId: parts[0].toUpperCase(),
        deptId: parts[1].toUpperCase(),
        role: parts[2].toUpperCase() === "ADM" ? "ADMIN" : parts[2].toUpperCase() === "DEPT" ? "DEPT_HEAD" : "EMPLOYEE",
        normalizedId: cleaned
      };
    }
  }

  // Pattern B: ETMAGJUMR62
  if (cleaned.length >= 8) {
    const tenantId = cleaned.substring(0, 3).toUpperCase();
    const deptId = cleaned.substring(3, 5).toUpperCase();
    const rawRole = cleaned.substring(5, 8).toUpperCase();
    return {
      tenantId,
      deptId,
      role: (rawRole === "JUM" || rawRole === "ADM") ? "ADMIN" : "EMPLOYEE",
      normalizedId: cleaned
    };
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "HEALTHY",
        gateway: "tasks.seosiri.com",
        version: "2.5.0",
        timestamp: new Date().toISOString()
      }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // =========================================================================
    // INBOUND JIRA WEBHOOK SYNC (No auth header needed, validates payload)
    // =========================================================================
    if (url.pathname === "/v1/webhooks/jira" && request.method === "POST") {
      try {
        const payload = await request.json();
        const issue = payload.issue;
        if (!issue) {
          return new Response(JSON.stringify({ status: "IGNORED" }), { status: 200, headers: corsHeaders });
        }

        const issueKey = issue.key;
        const summary = issue.fields?.summary || "Jira Task";
        const statusName = (issue.fields?.status?.name || "Pending").toUpperCase();
        const projectKey = (issue.fields?.project?.key || "ETM").toUpperCase();

        let sentinelStatus = "PENDING";
        if (statusName.includes("PROGRESS")) sentinelStatus = "PROGRESS";
        else if (statusName.includes("DONE") || statusName.includes("RESOLVED")) sentinelStatus = "COMPLETE";

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, source)
          VALUES (?, ?, 'ENG', 'ETM-AG-EMP-R62', ?, 'HIGH', ?, 'JIRA')
          ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, status = excluded.status, updated_at = CURRENT_TIMESTAMP
        `).bind(issueKey, projectKey, `[Jira ${issueKey}] ${summary}`, sentinelStatus).run();

        return new Response(JSON.stringify({ status: "JIRA_SYNCED", issueKey }), { status: 200, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // =========================================================================
    // AUTHENTICATION GUARD
    // =========================================================================
    const rawId = request.headers.get("X-Employee-ID");
    const identity = parseEmployeeId(rawId);
    if (!identity) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "Valid X-Employee-ID header required." }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // =========================================================================
    // 1. EMPLOYEES DIRECTORY & PROVISIONING (FIXES 404)
    // =========================================================================
    if (url.pathname === "/v1/employees" && request.method === "GET") {
      const emps = await env.DB.prepare(
        "SELECT employee_id, dept_id, role, full_name, email, created_at FROM employees WHERE tenant_id = ? ORDER BY full_name ASC"
      ).bind(identity.tenantId).all();

      return new Response(JSON.stringify({
        tenant: identity.tenantId,
        employees: emps.results || []
      }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (url.pathname === "/v1/employees/register" && request.method === "POST") {
      if (identity.role !== "ADMIN") {
        return new Response(JSON.stringify({ error: "FORBIDDEN", message: "Only Admins can provision employees." }), { status: 403, headers: corsHeaders });
      }

      const { fullName, email, deptId, role } = await request.json();
      const cleanDept = (deptId || "GENERAL").toUpperCase();
      const cleanRole = (role || "EMP").toUpperCase();
      const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
      const newEmployeeId = `${identity.tenantId}-${cleanDept}-${cleanRole}-${randHash}`;

      await env.DB.prepare(
        "INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(newEmployeeId, identity.tenantId, cleanDept, cleanRole, fullName.trim(), email.trim()).run();

      return new Response(JSON.stringify({
        status: "EMPLOYEE_REGISTERED",
        employee_id: newEmployeeId,
        fullName: fullName.trim(),
        deptId: cleanDept
      }), { status: 201, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // =========================================================================
    // 2. DYNAMIC DEPARTMENTS
    // =========================================================================
    if (url.pathname === "/v1/departments") {
      if (request.method === "GET") {
        const depts = await env.DB.prepare(
          "SELECT dept_id, dept_name FROM departments WHERE tenant_id = ? ORDER BY dept_name ASC"
        ).bind(identity.tenantId).all();

        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          departments: depts.results || []
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      if (request.method === "POST") {
        const { deptId, deptName } = await request.json();
        const cleanDept = deptId.trim().toUpperCase();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)"
        ).bind(cleanDept, identity.tenantId, deptName.trim()).run();

        return new Response(JSON.stringify({ status: "DEPARTMENT_CREATED", dept_id: cleanDept }), { status: 201, headers: corsHeaders });
      }
    }

    // =========================================================================
    // 3. TASK PIPELINE (GET, ASSIGN, STATUS, BULK)
    // =========================================================================
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
      }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
      const { title, assignedTo, deptId, priority, isUrgent } = await request.json();
      const taskId = crypto.randomUUID();
      const status = isUrgent ? "URGENT" : "PROGRESS";

      await env.DB.prepare(`
        INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(taskId, identity.tenantId, deptId || "GENERAL", assignedTo || identity.normalizedId, title.trim(), priority || "HIGH", status).run();

      return new Response(JSON.stringify({ status: "ASSIGNED", taskId }), { status: 201, headers: corsHeaders });
    }

    if (url.pathname === "/v1/tasks/bulk" && request.method === "POST") {
      const { tasks } = await request.json();
      const statements = tasks.map(t => 
        env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), identity.tenantId, t.deptId || "GENERAL", t.assignedTo || identity.normalizedId, t.title, t.priority || "MEDIUM", t.isUrgent ? "URGENT" : "PROGRESS")
      );

      const chunkSize = 100;
      for (let i = 0; i < statements.length; i += chunkSize) {
        await env.DB.batch(statements.slice(i, i + chunkSize));
      }

      return new Response(JSON.stringify({ status: "BULK_INGESTED_SUCCESSFULLY", count: tasks.length }), { status: 201, headers: corsHeaders });
    }

    if (url.pathname === "/v1/tasks/status" && request.method === "POST") {
      const { taskId, newStatus, blockerReason } = await request.json();

      await env.DB.prepare(
        "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?"
      ).bind(newStatus, taskId, identity.tenantId).run();

      await env.DB.prepare(
        "INSERT INTO task_telemetry (log_id, task_id, tenant_id, employee_id, previous_status, new_status, blocker_reason) VALUES (?, ?, ?, ?, 'PROGRESS', ?, ?)"
      ).bind(crypto.randomUUID(), taskId, identity.tenantId, identity.normalizedId, newStatus, blockerReason || null).run();

      if (blockerReason) {
        await env.DB.prepare(
          "INSERT INTO notifications (notification_id, tenant_id, target_id, type, title, message) VALUES (?, ?, 'ADMIN', 'BLOCKER', 'Task Blocked', ?)"
        ).bind(crypto.randomUUID(), identity.tenantId, blockerReason).run();
      }

      return new Response(JSON.stringify({ status: "TRANSITION_LOGGED", taskId, newStatus }), { status: 200, headers: corsHeaders });
    }

    // =========================================================================
    // 4. URGENT ACKNOWLEDGE & AUTO-DISPATCH
    // =========================================================================
    if (url.pathname === "/v1/tasks/acknowledge" && request.method === "POST") {
      const { taskId } = await request.json();
      await env.DB.prepare(
        "UPDATE tasks SET status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?"
      ).bind(taskId, identity.tenantId).run();

      return new Response(JSON.stringify({ status: "ACKNOWLEDGED", taskId }), { status: 200, headers: corsHeaders });
    }

    if (url.pathname === "/v1/tasks/auto-dispatch" && request.method === "POST") {
      // Find highest priority pending task in tenant
      const nextTask = await env.DB.prepare(`
        SELECT * FROM tasks 
        WHERE tenant_id = ? AND status = 'PENDING' 
        ORDER BY CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END, created_at ASC 
        LIMIT 1
      `).bind(identity.tenantId).first();

      if (!nextTask) {
        return new Response(JSON.stringify({ status: "NO_PENDING_TASKS", message: "Department backlog clean." }), { status: 200, headers: corsHeaders });
      }

      await env.DB.prepare(
        "UPDATE tasks SET assigned_to = ?, status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?"
      ).bind(identity.normalizedId, nextTask.task_id).run();

      return new Response(JSON.stringify({ status: "DISPATCHED", task: nextTask }), { status: 200, headers: corsHeaders });
    }

    // =========================================================================
    // 5. THREADED COMMENTS (SUPERVISOR & PEER FEEDBACK)
    // =========================================================================
    if (url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/comments")) {
      const taskId = url.pathname.split("/")[3];

      if (request.method === "GET") {
        const comments = await env.DB.prepare(
          "SELECT * FROM task_comments WHERE task_id = ? AND tenant_id = ? ORDER BY created_at ASC"
        ).bind(taskId, identity.tenantId).all();

        return new Response(JSON.stringify({ taskId, comments: comments.results || [] }), { status: 200, headers: corsHeaders });
      }

      if (request.method === "POST") {
        const { content } = await request.json();
        const commentId = crypto.randomUUID();

        await env.DB.prepare(
          "INSERT INTO task_comments (comment_id, task_id, tenant_id, author_id, author_role, content) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(commentId, taskId, identity.tenantId, identity.normalizedId, identity.role, content.trim()).run();

        return new Response(JSON.stringify({ status: "COMMENT_ADDED", commentId }), { status: 201, headers: corsHeaders });
      }
    }

    // =========================================================================
    // 6. NOTIFICATIONS & ANALYTICS
    // =========================================================================
    if (url.pathname === "/v1/notifications/ping" && request.method === "GET") {
      const pings = await env.DB.prepare(
        "SELECT * FROM notifications WHERE tenant_id = ? AND is_read = 0 ORDER BY created_at DESC"
      ).bind(identity.tenantId).all();

      return new Response(JSON.stringify({ notifications: pings.results || [] }), { status: 200, headers: corsHeaders });
    }

    if (url.pathname === "/v1/tenants/stats" && request.method === "GET") {
      const seatCount = await env.DB.prepare("SELECT COUNT(*) as count FROM employees WHERE tenant_id = ?").bind(identity.tenantId).first();
      return new Response(JSON.stringify({
        tenant_id: identity.tenantId,
        company_name: `${identity.tenantId} Enterprise Organization`,
        tier: "FREE_SME",
        active_seats: seatCount ? seatCount.count : 3,
        max_seats: 10,
        is_free_tier: true
      }), { status: 200, headers: corsHeaders });
    }

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
          completion_velocity: `${pct}%`
        }
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "ENDPOINT_NOT_FOUND" }), { status: 404, headers: corsHeaders });
  }
};
