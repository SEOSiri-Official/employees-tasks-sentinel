// employees-tasks-sentinel - Enterprise Multi-Tenant Task Orchestration & Telemetry Gateway

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [
    "https://board.seosiri.com",
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

  return {
    tenantId: "ETM",
    deptId: "AG",
    role: "ADMIN",
    normalizedId: cleaned
  };
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
          version: "2.7.0",
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // Inbound Jira Webhook
      if (url.pathname === "/v1/webhooks/jira" && request.method === "POST") {
        const payload = await request.json();
        const issue = payload.issue;
        if (!issue) return new Response(JSON.stringify({ status: "IGNORED" }), { status: 200, headers: corsHeaders });

        const issueKey = issue.key;
        const summary = issue.fields?.summary || "Jira Task";
        const statusName = (issue.fields?.status?.name || "Pending").toUpperCase();
        const tenantParam = url.searchParams.get("tenant");
        const projectKey = (tenantParam || issue.fields?.project?.key || "ETM").toUpperCase();

        let sentinelStatus = "PENDING";
        if (statusName.includes("PROGRESS")) sentinelStatus = "PROGRESS";
        else if (statusName.includes("DONE") || statusName.includes("RESOLVED")) sentinelStatus = "COMPLETE";

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
          VALUES (?, ?, 'ENG', 'ETM-AG-EMP-R62', ?, 'HIGH', ?, 'JIRA_WEBHOOK', 'JIRA')
          ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, status = excluded.status, updated_at = CURRENT_TIMESTAMP
        `).bind(issueKey, projectKey, `[Jira ${issueKey}] ${summary}`, sentinelStatus).run();

        return new Response(JSON.stringify({ status: "JIRA_SYNCED", issueKey }), { status: 200, headers: corsHeaders });
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

      // 1. EMPLOYEES DIRECTORY
      if (url.pathname === "/v1/employees" && request.method === "GET") {
        const emps = await env.DB.prepare(
          "SELECT employee_id, dept_id, role, full_name, email, created_at FROM employees WHERE tenant_id = ? ORDER BY full_name ASC"
        ).bind(identity.tenantId).all();

        return new Response(JSON.stringify({
          tenant: identity.tenantId,
          employees: emps.results || []
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // 2. EMPLOYEE PROVISIONING (Fixed try/catch with proper validation)
      if (url.pathname === "/v1/employees/register" && request.method === "POST") {
        const body = await request.json();
        const fullName = (body.fullName || "").trim();
        const email = (body.email || "").trim();
        const deptId = (body.deptId || "AG").trim().toUpperCase();
        let rawRole = (body.role || "EMPLOYEE").trim().toUpperCase();
        let role = "EMPLOYEE";
        if (rawRole === "ADM" || rawRole === "ADMIN") role = "ADMIN";
        else if (rawRole === "DEPT" || rawRole === "DEPT_HEAD") role = "DEPT_HEAD";
        else role = "EMPLOYEE";

        if (!fullName || !email) {
          return new Response(JSON.stringify({ error: "INVALID_PAYLOAD", message: "fullName and email are required." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
        const newEmployeeId = `${identity.tenantId}-${deptId}-${role}-${randHash}`;

        // Ensure tenant exists
        await env.DB.prepare(`
          INSERT OR IGNORE INTO tenants (tenant_id, company_name)
          VALUES (?, ?)
        `).bind(identity.tenantId, `${identity.tenantId} Enterprise Organization`).run();

        // Ensure department exists
        await env.DB.prepare(`
          INSERT OR IGNORE INTO departments (dept_id, tenant_id, dept_name)
          VALUES (?, ?, ?)
        `).bind(deptId, identity.tenantId, `${deptId} Department`).run();

        // Insert employee
        await env.DB.prepare(`
          INSERT INTO employees (employee_id, tenant_id, dept_id, role, full_name, email)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(newEmployeeId, identity.tenantId, deptId, role, fullName, email).run();

        return new Response(JSON.stringify({
          status: "EMPLOYEE_REGISTERED",
          employee_id: newEmployeeId,
          fullName,
          deptId
        }), { status: 201, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // 3. DEPARTMENTS
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
          const cleanDept = (deptId || "").trim().toUpperCase();
          await env.DB.prepare(
            "INSERT OR REPLACE INTO departments (dept_id, tenant_id, dept_name) VALUES (?, ?, ?)"
          ).bind(cleanDept, identity.tenantId, (deptName || cleanDept).trim()).run();

          return new Response(JSON.stringify({ status: "DEPARTMENT_CREATED", dept_id: cleanDept }), { status: 201, headers: corsHeaders });
        }
      }

      // 4. TASK PIPELINE
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

      // 5. TASK INJECTION / ASSIGNMENT
      if (url.pathname === "/v1/tasks/assign" && request.method === "POST") {
        const body = await request.json();
        const title = (body.title || "").trim();
        const assignedTo = (body.assignedTo || identity.normalizedId).trim();
        const deptId = (body.deptId || identity.deptId || "AG").trim().toUpperCase();
        const priority = (body.priority || "HIGH").toUpperCase();
        const isUrgent = !!body.isUrgent;

        if (!title) {
          return new Response(JSON.stringify({ error: "MISSING_TITLE", message: "Task title is required." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const taskId = crypto.randomUUID();
        const status = isUrgent ? "URGENT" : "PROGRESS";

        // Ensure department exists
        await env.DB.prepare(`
          INSERT OR IGNORE INTO departments (dept_id, tenant_id, dept_name)
          VALUES (?, ?, ?)
        `).bind(deptId, identity.tenantId, `${deptId} Department`).run();

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BOARD')
        `).bind(taskId, identity.tenantId, deptId, assignedTo, title, priority, status, identity.normalizedId).run();

        return new Response(JSON.stringify({ status: "ASSIGNED", taskId, title }), {
          status: 201,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // 6. BULK INGESTION
      if (url.pathname === "/v1/tasks/bulk" && request.method === "POST") {
        const { tasks } = await request.json();
        const statements = tasks.map(t => 
          env.DB.prepare(`
            INSERT INTO tasks (task_id, tenant_id, dept_id, assigned_to, title, priority, status, created_by, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CSV')
          `).bind(crypto.randomUUID(), identity.tenantId, (t.deptId || "AG").toUpperCase(), t.assignedTo || identity.normalizedId, t.title, t.priority || "MEDIUM", t.isUrgent ? "URGENT" : "PROGRESS", identity.normalizedId)
        );

        const chunkSize = 100;
        for (let i = 0; i < statements.length; i += chunkSize) {
          await env.DB.batch(statements.slice(i, i + chunkSize));
        }

        return new Response(JSON.stringify({ status: "BULK_INGESTED_SUCCESSFULLY", count: tasks.length }), { status: 201, headers: corsHeaders });
      }

      // 7. TASK STATUS MUTATION
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

        
        // Outbound Jira Transition Sync
        if (newStatus === "COMPLETE" && env.JIRA_BASE_URL && env.JIRA_API_TOKEN) {
          const taskRecord = await env.DB.prepare("SELECT source, task_id FROM tasks WHERE task_id = ?").bind(taskId).first();
          if (taskRecord && taskRecord.source === "JIRA") {
            ctx.waitUntil((async () => {
              try {
                const authHeader = "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
                // 1. Get transitions for the issue
                const transRes = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${taskId}/transitions`, {
                  headers: { "Authorization": authHeader, "Accept": "application/json" }
                });
                if (transRes.ok) {
                  const transData = await transRes.json();
                  const doneTrans = transData.transitions?.find(t => 
                    t.name.toLowerCase().includes("done") || 
                    t.name.toLowerCase().includes("complete") || 
                    t.name.toLowerCase().includes("resolved")
                  );
                  if (doneTrans) {
                    await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${taskId}/transitions`, {
                      method: "POST",
                      headers: { "Authorization": authHeader, "Content-Type": "application/json" },
                      body: JSON.stringify({ transition: { id: doneTrans.id } })
                    });
                  }
                }
              } catch (e) {
                console.error("Jira outbound sync failed", e);
              }
            })());
          }
        }

        return new Response(JSON.stringify({ status: "TRANSITION_LOGGED", taskId, newStatus }), { status: 200, headers: corsHeaders });
      }

      // 8. URGENT ACKNOWLEDGE
      if (url.pathname === "/v1/tasks/acknowledge" && request.method === "POST") {
        const { taskId } = await request.json();
        await env.DB.prepare(
          "UPDATE tasks SET status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND tenant_id = ?"
        ).bind(taskId, identity.tenantId).run();

        return new Response(JSON.stringify({ status: "ACKNOWLEDGED", taskId }), { status: 200, headers: corsHeaders });
      }

      // 9. AUTO DISPATCH
      if (url.pathname === "/v1/tasks/auto-dispatch" && request.method === "POST") {
        const nextTask = await env.DB.prepare(`
          SELECT * FROM tasks 
          WHERE tenant_id = ? AND status = 'PENDING' 
          ORDER BY CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END, created_at ASC 
          LIMIT 1
        `).bind(identity.tenantId).first();

        if (!nextTask) {
          return new Response(JSON.stringify({ status: "NO_PENDING_TASKS", message: "Backlog clear." }), { status: 200, headers: corsHeaders });
        }

        await env.DB.prepare(
          "UPDATE tasks SET assigned_to = ?, status = 'PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?"
        ).bind(identity.normalizedId, nextTask.task_id).run();

        return new Response(JSON.stringify({ status: "DISPATCHED", task: nextTask }), { status: 200, headers: corsHeaders });
      }

      // 10. THREADED COMMENTS
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

            // 11. ACKNOWLEDGE & DISMISS NOTIFICATIONS (FIXES STUCK PING BANNER)
      if (url.pathname === "/v1/notifications/ack" && request.method === "POST") {
        const { notificationId } = await request.json();
        if (notificationId) {
          await env.DB.prepare(
            "UPDATE notifications SET is_read = 1 WHERE notification_id = ? AND tenant_id = ?"
          ).bind(notificationId, identity.tenantId).run();
        } else {
          // Mark all as read for this tenant/user
          await env.DB.prepare(
            "UPDATE notifications SET is_read = 1 WHERE tenant_id = ?"
          ).bind(identity.tenantId).run();
        }
        return new Response(JSON.stringify({ status: "ACKNOWLEDGED", notificationId }), { status: 200, headers: corsHeaders });
      }

            // 12. PURGE TEST/DUMMY ARTIFACTS
      if (url.pathname === "/v1/tasks/purge-tests" && request.method === "POST") {
        if (identity.role !== "ADMIN") {
          return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: corsHeaders });
        }
        // 1. Delete child telemetry logs
        await env.DB.prepare(`
          DELETE FROM task_telemetry 
          WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = ? AND (title LIKE 'Chunk Test%' OR title LIKE 'Batch Task%'))
        `).bind(identity.tenantId).run();

        // 2. Delete child comments
        await env.DB.prepare(`
          DELETE FROM task_comments 
          WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = ? AND (title LIKE 'Chunk Test%' OR title LIKE 'Batch Task%'))
        `).bind(identity.tenantId).run();

        // 3. Delete parent tasks safely
        const del = await env.DB.prepare(
          "DELETE FROM tasks WHERE tenant_id = ? AND (title LIKE 'Chunk Test%' OR title LIKE 'Batch Task%')"
        ).bind(identity.tenantId).run();

        return new Response(JSON.stringify({ status: "PURGED", deleted_count: del.meta.changes }), { status: 200, headers: corsHeaders });
      }

      // Notifications & Stats
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

    } catch (fatalError) {
      // Catch-all: Never allow an uncaught exception to trigger Cloudflare Error 1101
      return new Response(JSON.stringify({
        error: "INTERNAL_GATEWAY_ERROR",
        message: fatalError.message,
        stack: fatalError.stack
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
