# Employees Tasks Sentinel (`employees-tasks-sentinel`)

> 🌐 **Live Gateway:** `https://tasks.seosiri.com`
> 📊 **Global Web Command Board:** [board.seosiri.com](https://board.seosiri.com)
> 📖 **Developer Documentation:** [developers.seosiri.com](https://developers.seosiri.com)
> 🛡️ **Corporate Gateway:** [seosiri.com](https://seosiri.com)

An enterprise-grade, multi-tenant workforce task monitoring, autonomous telemetry ingestion, and real-time alert gateway deployed natively on Cloudflare Workers and Cloudflare D1 serverless SQL.

---

## 🏛️ System Architecture Overview

The **Employees Tasks Sentinel** operates as an autonomous edge control plane connecting corporate administrators, department heads, and distributed employees without cross-tenant data leakage.
┌───────────────────────┐ ┌───────────────────────┐
│ Admin / Dept Head │ │ Individual Employee │
│ (Global Oversight) │ │ (Isolated View) │
└───────────┬────────────┘ └───────────┬────────────┘
│ │
└─────────────────┬──────────────────┘
▼
┌───────────────────────────────────┐
│ tasks.seosiri.com / Edge API │
├───────────────────────────────────┤
│ Zero-Trust Identity (X-Employee-ID)│
│ 4-State Pipeline Router │
│ Blocker Detection & Telemetry │
└───────────────┬───────────────────┘
│
┌────────────────┴────────────────┐
▼ ▼
┌───────────────────────┐ ┌───────────────────────┐
│ Cloudflare D1 SQL │ │ Autonomous Pings │
│ (Tenant-Partitioned) │ │ (Desktop Tray / Web) │
└───────────────────────┘ └───────────────────────┘

---

## 🚀 Key Functional Modules

1. **Cryptographic Identity & RBAC (`X-Employee-ID`):**
   * Supports both compact (`ETMAGJUMR62`) and hyphenated (`ETM-AG-JUM-R62`) identifier formats.
   * Enforces zero-trust isolation: Admins access company-wide macro metrics; employees access strictly their own assigned task streams.

2. **Core 4-State Workflow Pipeline:**
   * `URGENT`: High-priority tasks dispatched with automated ping alerts.
   * `PROGRESS`: Active, in-flight work with telemetry tracking.
   * `PENDING`: Blocked items awaiting dependencies or administrative review.
   * `COMPLETE`: Verified, resolved tasks with cycle-time logging.

3. **Triple Ingestion Stream:**
   * **Single Task Ingestion:** Direct assignment via `/v1/tasks/assign`.
   * **Bulk Ingestion:** Ingests up to 1,000 tasks in a single atomic batch via `/v1/tasks/bulk` for instant Day-1 migration.
   * **Webhook Synchronization:** Real-time Jira issue ingestion via `/v1/webhooks/jira`.

4. **Telemetry & Blocker Escalation Loop:**
   * Logs transition timestamps and calculates completion velocity.
   * Auto-escalates blocked items with reasons directly into managerial notification queues.

5. **Freemium SME Licensing Cap:**
   * **1–10 Employees:** Free community tier ($0).
   * **11+ Employees:** Token-gated licensing requiring valid SEOSiri HMAC keys (`PRO_` / `ENT_`) via `/v1/tenants/license`.

---

## 🔌 API Endpoints Reference

All requests require the `X-Employee-ID` header (except `/health` and webhooks).

| Endpoint | Method | Role | Description |
| :--- | :---: | :---: | :--- |
| `/health` | `GET` | Public | Edge gateway status and engine health probe. |
| `/v1/tasks` | `GET` | All | Fetch tasks (Admin sees all; Employee sees self only). |
| `/v1/tasks/assign` | `POST` | Admin / Dept Head | Assign single task with optional urgent ping dispatch. |
| `/v1/tasks/bulk` | `POST` | Admin | Atomic bulk insertion of CSV/JSON task arrays. |
| `/v1/tasks/status` | `POST` | Assigned Employee | Transition task status and log blocker telemetry. |
| `/v1/notifications/ping` | `GET` | All | Fetch unread priority alerts and executive digests. |
| `/v1/notifications/ack` | `POST` | All | Acknowledge and dismiss notifications. |
| `/v1/analytics/digest` | `GET` | Admin / Dept Head | Real-time completion velocity and bottleneck metrics. |
| `/v1/tenants/license` | `POST` | Admin | Activate commercial license token to unlock seats. |
| `/v1/tenants/stats` | `GET` | All | Fetch current active seats vs. licensed limit. |

---

## 🛠️ Local Development & Deployment

### Prerequisites
* Node.js v20+ or v22+
* Wrangler CLI (`npm install -g wrangler`)
* Active Cloudflare account

### Setup & Deploy

```bash
# 1. Clone repository
git clone https://github.com/SEOSiri-Official/employees-tasks-sentinel.git
cd employees-tasks-sentinel

# 2. Install dependencies
npm install

# 3. Apply schema migrations to Cloudflare D1
npx wrangler d1 execute employees-tasks-db --file=db/schema.sql --remote

# 4. Deploy Worker to live edge
npx wrangler deploy
```

---

## 📄 License

Distributed under the [MIT License](https://github.com/SEOSiri-Official/employees-tasks-sentinel/blob/main/LICENSE).

---

Architected and maintained by Momenul Ahmad under SEOSiri Enterprise Labs.
