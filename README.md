# singleops-mcp-server

An MCP server for [SingleOps](https://www.singleops.com), the field-service platform for tree care, landscaping and green-industry businesses.

SingleOps publishes only a small Lead Entry API. This server instead exposes the endpoints the **SingleOps web app itself uses**: clients, jobs, visits, invoices, items, tasks, timesheets, reports and more. Every endpoint becomes one MCP tool. Reads are always on. Writes and deletes are off until you turn them on, and even then each call is a dry run until you say otherwise.

It works with any MCP client:
- over **stdio**: Claude Code, Claude Desktop, Cursor, Grok CLI-style local agents
- over **Streamable HTTP**: Grok (xAI API remote MCP) and other remote agents

> **Unofficial.** Not affiliated with or endorsed by SingleOps. It drives your own logged-in session the way your browser does. Use it on accounts you are authorised to operate, at a polite rate (it defaults to 1 request/second).

---

## Contents

- [Quick start](#quick-start)
- [Authentication: the login option](#authentication-the-login-option)
- [Connect a client](#connect-a-client) (Claude Code / Desktop, Grok)
- [Safety model](#safety-model)
- [Configuration](#configuration)
- [The route map: shipped, or build your own](#the-route-map-shipped-or-build-your-own)
- [Tool reference](#tool-reference): read tools, write tools, delete tools
- [Examples](#examples)
- [Development](#development)

---

## Quick start

```bash
git clone https://github.com/Zeekeey-jpeg/Single_Ops_MCP.git
cd Single_Ops_MCP
npm install
npx playwright install chrome   # once: the login browser
npm run build
npm run login                   # a browser opens; sign in to SingleOps by hand
npm start                       # stdio MCP server: 87 tools live (82 read + 5 meta)
```

Requirements: Node.js 20+, and Google Chrome (or run `npx playwright install chromium` and set `channel` in `scripts/capture.mjs`).

---

## Authentication: the login option

SingleOps' internal API has **no API key and no JWT**. It authenticates the way the web app does: a **session cookie plus a Rails CSRF token**.

1. `npm run login` opens a real browser window at `app.singleops.com`.
2. **You sign in by hand**, including any 2FA. The script never sees, asks for or stores your password.
3. As soon as the app loads, the browser's cookies are saved to `state/session.json` (gitignored), and the window closes.
4. Every tool call replays that session:
   - the `_SingleOps_session` cookie
   - `x-csrf-token`, read from the app's `<meta name="csrf-token">`, sent on non-GET requests
   - `x-requested-with: XMLHttpRequest`

**When the session expires,** tools return `AUTH: SingleOps rejected the session (HTTP 401)…`. They never retry a 401, because hammering a login wall is how accounts get locked. Run `npm run login` again and restart the server. The browser profile in `state/profile/` usually keeps you signed in, so re-login is often a single click.

**Optional: Lead Entry token.** The official Lead Entry API (4 routes) uses `user_email` + `user_token` from SingleOps → Users → *your API user* → *View API Token*. Put them in `.env` to enable the `singleops_*_lead_*` tools. Everything else uses the browser session.

`state/session.json` is a live login. Treat it like a password: never commit it, never copy it to a shared machine.

---

## Connect a client

### Claude Code

```bash
claude mcp add singleops -s user -- node /absolute/path/to/Single_Ops_MCP/dist/index.js
```

### Claude Desktop / Cursor / any stdio client

```json
{
  "mcpServers": {
    "singleops": {
      "command": "node",
      "args": ["/absolute/path/to/Single_Ops_MCP/dist/index.js"]
    }
  }
}
```

Secrets stay in `.env` next to the server, never in the client config.

### Grok (xAI): remote MCP over Streamable HTTP

Grok connects to **remote** MCP servers by URL. Run the server in HTTP mode on the machine that holds your SingleOps session:

```bash
# 1. a long random token that only you and your Grok config know
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 2. put it in .env
#    SINGLEOPS_HTTP_TOKEN=<that token>
# 3. start
npm run start:http      # http://127.0.0.1:3333/mcp  (health: /health)
```

Grok's servers cannot reach `127.0.0.1`, so publish the port over HTTPS with a tunnel you control. For example, `cloudflared tunnel --url http://127.0.0.1:3333` gives you `https://<random>.trycloudflare.com`. Then point Grok at it.

**xAI API / SDK (remote MCP tool):**

```python
from xai_sdk import Client
from xai_sdk.chat import user
from xai_sdk.tools import mcp

client = Client(api_key=XAI_API_KEY)
chat = client.chat.create(
    model="grok-4",
    tools=[mcp(
        server_url="https://<your-tunnel>/mcp",
        server_label="singleops",
        authorization="Bearer <SINGLEOPS_HTTP_TOKEN>",
    )],
)
chat.append(user("List my SingleOps jobs scheduled this week"))
print(chat.sample().content)
```

**Grok apps / agents with a "Connectors / MCP" setting:** add a custom MCP server with URL `https://<your-tunnel>/mcp` and header `Authorization: Bearer <SINGLEOPS_HTTP_TOKEN>`.

HTTP mode is **stateless**: each request gets a fresh server, so several agents can share one instance. It refuses to start without a 24+ character token, rejects requests without it (constant-time compare), rejects browser `Origin`s unless they are listed in `SINGLEOPS_HTTP_ALLOWED_ORIGINS`, and binds to `127.0.0.1` unless you set `SINGLEOPS_HTTP_HOST`. Anyone with the URL and token acts as you in SingleOps, so keep write and delete off on any internet-reachable instance unless you mean it.

---

## Safety model

| Layer | What it does |
|---|---|
| **Registration gates** | A tool that is not registered cannot be called. Reads: always. Writes (`POST`/`PUT`/`PATCH`): only if `SINGLEOPS_ENABLE_WRITE=true` (**default `false`**). Deletes: only if `SINGLEOPS_ENABLE_DELETE=true` (**default `false`**). |
| **Denied by policy** | Routes that move money, change billing or subscriptions, touch user accounts or passwords, email or text your customers, or change account-wide settings are mapped but **never** registered, whatever the flags say. |
| **Dry run by default** | Every write call returns the exact request (method, URL, every form field) and sends nothing, unless you pass `dry_run: false`. |
| **Typed delete confirmation** | A delete also needs `confirm: "DELETE /tags/42"` naming that one record. |
| **Write budget** | At most `SINGLEOPS_MAX_WRITES` (default 25) live writes per server run. Raise it deliberately for a bulk job. |
| **Map-bound** | Only routes in `api-map.json` can be called. There is no free-form URL tool. |
| **Audit log** | Every write, failed write and auth failure is appended to `audit/YYYY-MM-DD.jsonl`, with **field names only**, never values. |
| **Polite client** | 1 request/second, serialized. 429/5xx are retried with backoff and `Retry-After`. 401/403 are never retried. A stale CSRF token is refreshed once. |

**QuickBooks:** if your SingleOps account syncs to QuickBooks Online, writes to clients, items and invoices flow into QuickBooks. Run `singleops_read_get_qbo_status` first, and test on a throwaway record (e.g. a client named `ZZ-TEST-MCP`).

---

## Configuration

Copy `.env.example` to `.env`. Every capability defaults to **off**.

| Variable | Default | Meaning |
|---|---|---|
| `SINGLEOPS_ENABLE_WRITE` | `false` | Register create/update tools. |
| `SINGLEOPS_ENABLE_DELETE` | `false` | Register delete tools (still need `confirm`). |
| `SINGLEOPS_MAX_WRITES` | `25` | Live writes allowed per server run. |
| `SINGLEOPS_MAX_RPS` | `1` | Requests per second. |
| `SINGLEOPS_LEAD_USER_EMAIL` / `SINGLEOPS_LEAD_USER_TOKEN` | — | Optional, for the official Lead Entry API tools. |
| `SINGLEOPS_HTTP_TOKEN` | — | Required for `--http`. Clients send `Authorization: Bearer <token>`. |
| `SINGLEOPS_HTTP_HOST` / `SINGLEOPS_HTTP_PORT` | `127.0.0.1` / `3333` | HTTP bind address. |
| `SINGLEOPS_HTTP_ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to call HTTP mode. |
| `SINGLEOPS_BASE_URL` | `https://app.singleops.com` | Override for a different SingleOps host. |

Gitignored and never committed: `.env`, `state/` (session and browser profile), `capture/` (raw traffic), `audit/`, `dist/`, `node_modules/`.

---

## The route map: shipped, or build your own

The tools are generated at startup from **`api-map.json`**, a map of SingleOps' internal routes. It records **shapes only**: method, path template, query-parameter names, body field names and types, and response key names. It holds no values, no record ids, no account names and no cookies. A test enforces this.

**Decision: a sanitized map ships with the repo**, so the server is useful immediately. SingleOps is multi-tenant SaaS, so the routes are the same for every account. The shipped map was built from one account's read-only crawl and scrubbed of anything account-specific. `api-map.md` is the human-readable version.

**Build your own** to pick up routes your plan or settings expose, or after SingleOps ships changes (`singleops_read_contract_test` tells you when):

```bash
npm run crawl     # sign in; it then visits every page type READ-ONLY and records traffic to capture/*.har
npm run map       # rebuilds api-map.json + api-map.md (merges with the existing map)
npm run docs      # regenerates the tool tables in this README
```

How the map is built:
- **Read routes:** XHR/JSON calls are taken from the recorded traffic (HAR) and the paths templated (`/clients/123` → `/clients/{id}`), the same idea as `mitmproxy2swagger` and `har-to-openapi`.
- **Write routes:** these come from the Rails `<form>`s and `data-method` links in the pages the crawl already loaded: action, method (`_method` override) and field names. **No write is performed to discover them.**
- **Crawler safety:** the crawler follows only plain GET links and skips anything that looks like an action (send, approve, convert, delete, pay, export…). `node scripts/audit-actions.mjs capture/<file>.har` lists every non-GET or action-like request a crawl made, so you can confirm nothing changed.
- **Sensitive output:** `capture/*.har` contains your real customer data and cookies. It stays local (gitignored). Delete it when you're done.

---

## Tool reference

Naming follows `singleops_{read|write}_{verb}_{entity}`. Each tool carries MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Read tools take `response_format` (`markdown` default, or `json`). Long outputs are truncated at 25,000 characters with a hint to page.

How to call:
- **Path parameters** (`{id}`, `{client_id}`) are named inputs.
- **Query parameters** seen in traffic are named inputs. Anything else goes in `extra_query`.
- **Search tools** (Rails datatables) take DataTables-style paging in `body`: `{"start": 0, "length": 25, "search": {"value": "smith"}}`.
- **Write tools** take Rails-style nested objects in `body`, e.g. `{"client": {"first_name": "Pat", "last_name": "Lee"}}`. Send only the fields you set. Success returns `{ok, status, redirect, id}`. A validation failure returns the form's error messages.

<!-- TOOLS:START (generated by scripts/gen-readme-tools.mjs — do not edit by hand) -->

**132 tools**: 5 meta, 82 read, 37 write, 8 delete. 15 more mapped routes are denied by policy and never exposed. With default settings 87 tools are live (meta + read).

### Meta tools (5)

Always on. Discovery, health and guarded generic access.

| ID | Tool name | Description | Endpoint | Enabled when |
|---|---|---|---|---|
| 1 | `singleops_discover_tools` | List every tool grouped by domain (clients, jobs, visits, reports…), filterable by domain and read/write, with enabled/disabled state. | — | always |
| 2 | `singleops_read_whoami` | Connection status: session presence/expiry and auth scheme (no secret values), gates, write budget, and a live probe of one GET route. | — | always |
| 3 | `singleops_call_route` | Call any mapped route by tool name or route id. Free-form URLs are not accepted; the target's gates and dry-run apply. | — | same as target |
| 4 | `singleops_read_contract_test` | Replay parameter-free GET routes and diff response keys against the map, to detect SingleOps changing its internal API. | — | always |
| 5 | `singleops_read_get_qbo_status` | Report the QuickBooks Online connection settings. Check before any bulk write: writes sync to QuickBooks. | — | always |

### Read tools (82)

Read-only (`readOnlyHint: true`). Always on. `GET` routes plus Rails datatable/report queries that are sent as `POST` but only read. Every read tool accepts `response_format` (`markdown` default, or `json`).

| ID | Tool name | Description | Endpoint | Enabled when |
|---|---|---|---|---|
| 1 | `singleops_read_lead_list_operations` | Lead Entry API: list operations (divisions). | `GET /api/v1/operations` | Lead Entry token |
| 2 | `singleops_read_lead_list_custom_inputs` | Lead Entry API: list custom input (custom field) definitions. | `GET /api/v1/custom_inputs` | Lead Entry token |
| 3 | `singleops_read_lead_list_clients_search_by_field` | Lead Entry API: search clients. search_field = email \| phone (prefix match). | `GET /api/v1/clients/search_by_field` | Lead Entry token |
| 4 | `singleops_read_list_account_settings_options_quickbooks` | List account settings options quickbooks. | `GET /api/v1/account_settings/options/quickbooks` | always |
| 5 | `singleops_read_list_accounts_info` | List accounts info. | `GET /api/v1/accounts/info` | always |
| 6 | `singleops_read_get_dashboard` | Get dashboard by id. | `GET /api/v1/dashboards/{id}` | always |
| 7 | `singleops_read_list_operations` | List operations. | `GET /api/v1/operations` | always |
| 8 | `singleops_read_list_users_current` | List users current. | `GET /api/v1/users/current` | always |
| 9 | `singleops_read_list_widgets` | List widgets. | `GET /api/v1/widgets` | always |
| 10 | `singleops_read_list_portal_accounts_feature_flags` | List portal accounts feature flags. | `GET /client/api/v1/accounts/feature_flags` | always |
| 11 | `singleops_read_list_client_location_stats` | List client location stats for one client/location. | `GET /clients/{client_id}/location/{location_id}/stats` | always |
| 12 | `singleops_read_list_client_emails` | List client emails for one id. | `GET /clients/{id}/emails` | always |
| 13 | `singleops_read_list_client_invoices` | List client invoices for one id. | `GET /clients/{id}/invoices` | always |
| 14 | `singleops_read_list_client_jobs` | List client jobs for one id. | `GET /clients/{id}/jobs` | always |
| 15 | `singleops_read_list_client_locations` | List client locations for one id. | `GET /clients/{id}/locations` | always |
| 16 | `singleops_read_list_client_stat_hours` | List client stat hours for one id. | `GET /clients/{id}/stats/hours.json` | always |
| 17 | `singleops_read_list_client_stat_revenue` | List client stat revenue for one id. | `GET /clients/{id}/stats/revenue.json` | always |
| 18 | `singleops_read_list_client_tasks` | List client tasks for one id. | `GET /clients/{id}/tasks` | always |
| 19 | `singleops_read_list_client_text_messages` | List client text messages for one id. | `GET /clients/{id}/text_messages` | always |
| 20 | `singleops_read_list_client_visits` | List client visits for one id. | `GET /clients/{id}/visits` | always |
| 21 | `singleops_read_search_clients` | Search clients (server-side table query: paging, sorting, filters). | `GET /clients/data_table` | always |
| 22 | `singleops_read_list_email_spam_addresses_check_batch_emails` | List email spam addresses check batch emails. | `POST /email_spam_addresses/check_batch_emails` | always |
| 23 | `singleops_read_list_emails_report` | List emails report. | `GET /emails/report` | always |
| 24 | `singleops_read_search_invoices_archived_invoices` | Search invoices archived invoices (server-side table query: paging, sorting, filters). | `GET /invoices/archived_invoices_data_table` | always |
| 25 | `singleops_read_search_invoices` | Search invoices (server-side table query: paging, sorting, filters). | `POST /invoices/data_table` | always |
| 26 | `singleops_read_list_invoices_invoice_totals` | List invoices invoice totals. | `POST /invoices/invoice_totals` | always |
| 27 | `singleops_read_search_invoices_2` | Search invoices (server-side table query: paging, sorting, filters). | `POST /invoices/invoices_datatable` | always |
| 28 | `singleops_read_list_item_groups` | List item groups. | `GET /item_groups` | always |
| 29 | `singleops_read_list_items` | List items. | `GET /items` | always |
| 30 | `singleops_read_search_jobs_invoices` | Search jobs invoices (server-side table query: paging, sorting, filters) for one id. | `GET /jobs/{id}/invoices_datatable` | always |
| 31 | `singleops_read_search_jobs` | Search jobs (server-side table query: paging, sorting, filters). | `POST /jobs/jobs_datatable` | always |
| 32 | `singleops_read_search_jobs_report` | Search jobs report (server-side table query: paging, sorting, filters). | `POST /jobs/jobs_report_datatable` | always |
| 33 | `singleops_read_search_jobs_progress_billing` | Search jobs progress billing (server-side table query: paging, sorting, filters). | `GET /jobs/progress_billing_datatable` | always |
| 34 | `singleops_read_search_jobs_visits_report` | Search jobs visits report (server-side table query: paging, sorting, filters). | `POST /jobs/visits_report_datatable` | always |
| 35 | `singleops_read_search_labor_resources` | Search labor resources (server-side table query: paging, sorting, filters). | `GET /labor_resources/data_table` | always |
| 36 | `singleops_read_list_public_accounts_feature_flags` | List public accounts feature flags. | `GET /public/api/v1/accounts/feature_flags` | always |
| 37 | `singleops_read_list_public_brand_details` | List public brand details for one id. | `GET /public/api/v1/brands/{id}/details` | always |
| 38 | `singleops_read_list_public_client_public_invoices` | List public client public invoices for one id. | `GET /public/api/v1/clients/{id}/public_invoices` | always |
| 39 | `singleops_read_list_purchase_orders` | List purchase orders. | `GET /purchase_orders` | always |
| 40 | `singleops_read_get_archived_jobs_report` | Get archived jobs report. | `GET /reports/archived_jobs_report` | always |
| 41 | `singleops_read_get_batch_renew_jobs_report` | Get batch renew jobs report. | `GET /reports/batch_renew_jobs` | always |
| 42 | `singleops_read_get_client_labor_report` | Get client labor report. | `GET /reports/client_labor` | always |
| 43 | `singleops_read_get_custom_inputs_report` | Get custom inputs report. | `GET /reports/custom_inputs_report` | always |
| 44 | `singleops_read_get_customer_history_report` | Get customer history report. | `GET /reports/customer_history` | always |
| 45 | `singleops_read_get_customer_type_report` | Get customer type report. | `GET /reports/customer_type_report` | always |
| 46 | `singleops_read_get_equipment_utilization_report` | Get equipment utilization report. | `GET /reports/equipment_utilization` | always |
| 47 | `singleops_read_get_global_planner_report` | Get global planner report. | `GET /reports/global_planner` | always |
| 48 | `singleops_read_get_inventory_transactions_report` | Get inventory transactions report. | `POST /reports/inventory_transactions` | always |
| 49 | `singleops_read_get_item_groups_report` | Get item groups report. | `GET /reports/item_groups_report` | always |
| 50 | `singleops_read_get_items_report` | Get items report. | `GET /reports/items_report` | always |
| 51 | `singleops_read_get_job_expenses_report` | Get job expenses report. | `POST /reports/job_expenses` | always |
| 52 | `singleops_read_get_job_labor_report` | Get job labor report. | `GET /reports/job_labor` | always |
| 53 | `singleops_read_get_job_profit_margin_report` | Get job profit margin report. | `GET /reports/job_profit_margin` | always |
| 54 | `singleops_read_get_master_line_item_report` | Get master line item report. | `POST /reports/master_line_item` | always |
| 55 | `singleops_read_get_net_sales_report` | Get net sales report. | `GET /reports/net_sales` | always |
| 56 | `singleops_read_get_operation_performance_report` | Get operation performance report. | `GET /reports/operation_performance_report` | always |
| 57 | `singleops_read_get_payment_records_report` | Get payment records report. | `GET /reports/payment_records_report` | always |
| 58 | `singleops_read_get_payment_totals_report` | Get payment totals report. | `POST /reports/payment_totals_report` | always |
| 59 | `singleops_read_get_purchase_orders_report` | Get purchase orders report. | `GET /reports/purchase_orders` | always |
| 60 | `singleops_read_get_sales_rep_report` | Get sales rep report. | `GET /reports/sales_rep` | always |
| 61 | `singleops_read_get_timesheet_summary_report` | Get timesheet summary report. | `GET /reports/timesheet_summary_report` | always |
| 62 | `singleops_read_get_timesheet_totals_report` | Get timesheet totals report. | `POST /reports/timesheet_totals_report` | always |
| 63 | `singleops_read_get_tree_inventory_report` | Get tree inventory report. | `POST /reports/tree_inventory_report` | always |
| 64 | `singleops_read_get_visit_profit_margin_report` | Get visit profit margin report. | `GET /reports/visit_profit_margin` | always |
| 65 | `singleops_read_list_tags` | List all tags (id, name, html_color, tag_type). Use the id with update_tag / delete_tag. | `GET /tags` | always |
| 66 | `singleops_read_get_task` | Get task by id. | `GET /tasks/{id}.json` | always |
| 67 | `singleops_read_list_tasks_calendar` | List tasks calendar. | `GET /tasks/calendar` | always |
| 68 | `singleops_read_search_tasks` | Search tasks (server-side table query: paging, sorting, filters). | `POST /tasks/data_table/all` | always |
| 69 | `singleops_read_list_tasks_route_planner` | List tasks route planner. | `GET /tasks/route_planner` | always |
| 70 | `singleops_read_list_text_messages_report` | List text messages report. | `GET /text_messages/report.json` | always |
| 71 | `singleops_read_list_timesheet_events_list` | List timesheet events list. | `GET /timesheet_events/list.json` | always |
| 72 | `singleops_read_list_timesheets_list` | List timesheets list. | `GET /timesheets/list.json` | always |
| 73 | `singleops_read_list_users_crews` | List users crews. | `GET /users/crews.json` | always |
| 74 | `singleops_read_list_vendors` | List vendors. | `GET /vendors` | always |
| 75 | `singleops_read_get_visit` | Get visit by id. | `GET /visits/{id}.json` | always |
| 76 | `singleops_read_search_visits_approved` | Search visits approved (server-side table query: paging, sorting, filters). | `GET /visits/approved/data_table` | always |
| 77 | `singleops_read_list_visits_awaiting_scheduling_stats` | List visits awaiting scheduling stats. | `GET /visits/awaiting_scheduling_stats` | always |
| 78 | `singleops_read_list_visits_index_fullcalendar_events` | List visits index fullcalendar events. | `GET /visits/index_fullcalendar_events.json` | always |
| 79 | `singleops_read_list_visits_index_fullcalendar_holiday_events` | List visits index fullcalendar holiday events. | `GET /visits/index_fullcalendar_holiday_events.json` | always |
| 80 | `singleops_read_list_visits_index_route_planner_events` | List visits index route planner events. | `GET /visits/index_route_planner_events.json` | always |
| 81 | `singleops_read_list_visits_route_planner_data` | List visits route planner data. | `GET /visits/route_planner_data` | always |
| 82 | `singleops_read_list_visits_user_routes` | List visits user routes. | `GET /visits/user_routes` | always |

### Write tools (37)

**Mutating.** Registered only when `SINGLEOPS_ENABLE_WRITE=true` (default `false`). Each call is a **dry run by default** and returns the exact request; pass `dry_run: false` to send. Capped at `SINGLEOPS_MAX_WRITES` live writes per run and audited to `audit/`.

| ID | Tool name | Description | Endpoint | Enabled when |
|---|---|---|---|---|
| 1 | `singleops_write_lead_create_job` | Lead Entry API: create a lead (for an existing client_id, or with a new client profile). | `POST /api/v1/jobs` | SINGLEOPS_ENABLE_WRITE |
| 2 | `singleops_write_create_client` | Create client. | `POST /clients` | SINGLEOPS_ENABLE_WRITE |
| 3 | `singleops_write_update_client` | Update client for one id. | `PATCH /clients/{id}` | SINGLEOPS_ENABLE_WRITE |
| 4 | `singleops_write_create_custom_input` | Create custom input. | `POST /custom_inputs` | SINGLEOPS_ENABLE_WRITE |
| 5 | `singleops_write_update_custom_input` | Update custom input for one id. | `PATCH /custom_inputs/{id}` | SINGLEOPS_ENABLE_WRITE |
| 6 | `singleops_write_create_customer_type` | Create customer type. | `POST /customer_types` | SINGLEOPS_ENABLE_WRITE |
| 7 | `singleops_write_update_invoice` | Update invoice for one id. | `PATCH /invoices/{id}` | SINGLEOPS_ENABLE_WRITE |
| 8 | `singleops_write_create_item_group` | Create item group. | `POST /item_groups` | SINGLEOPS_ENABLE_WRITE |
| 9 | `singleops_write_create_item_subcategory` | Create item subcategory. | `POST /item_subcategories` | SINGLEOPS_ENABLE_WRITE |
| 10 | `singleops_write_create_item` | Create item. | `POST /items` | SINGLEOPS_ENABLE_WRITE |
| 11 | `singleops_write_update_item` | Update item for one id. | `PATCH /items/{id}` | SINGLEOPS_ENABLE_WRITE |
| 12 | `singleops_write_create_job_template` | Create job template. | `POST /job_templates` | SINGLEOPS_ENABLE_WRITE |
| 13 | `singleops_write_create_job` | Create job. | `POST /jobs` | SINGLEOPS_ENABLE_WRITE |
| 14 | `singleops_write_update_job` | Update job for one id. | `PATCH /jobs/{id}` | SINGLEOPS_ENABLE_WRITE |
| 15 | `singleops_write_update_job_notes` | Update job notes for one id. | `PATCH /jobs/{id}/update_notes` | SINGLEOPS_ENABLE_WRITE |
| 16 | `singleops_write_create_labor_resource` | Create labor resource. | `POST /labor_resources` | SINGLEOPS_ENABLE_WRITE |
| 17 | `singleops_write_create_labor_schedule` | Create labor schedule. | `POST /labor_schedules` | SINGLEOPS_ENABLE_WRITE |
| 18 | `singleops_write_create_loaded_labor_rate_formula` | Create loaded labor rate formula. | `POST /loaded_labor_rate_formulas` | SINGLEOPS_ENABLE_WRITE |
| 19 | `singleops_write_create_operation` | Create operation. | `POST /operations` | SINGLEOPS_ENABLE_WRITE |
| 20 | `singleops_write_update_operation` | Update operation for one id. | `PATCH /operations/{id}` | SINGLEOPS_ENABLE_WRITE |
| 21 | `singleops_write_create_payment_method` | Create payment method. | `POST /payment_methods` | SINGLEOPS_ENABLE_WRITE |
| 22 | `singleops_write_create_purchase_order` | Create purchase order. | `POST /purchase_orders` | SINGLEOPS_ENABLE_WRITE |
| 23 | `singleops_write_create_recurrence_schedule` | Create recurrence schedule. | `POST /recurrence_schedules` | SINGLEOPS_ENABLE_WRITE |
| 24 | `singleops_write_create_tag` | Create tag. | `POST /tags` | SINGLEOPS_ENABLE_WRITE |
| 25 | `singleops_write_update_tag` | Update tag for one id. | `PATCH /tags/{id}` | SINGLEOPS_ENABLE_WRITE |
| 26 | `singleops_write_create_task` | Create task. | `POST /tasks` | SINGLEOPS_ENABLE_WRITE |
| 27 | `singleops_write_unschedule_task` | Unschedule task for one id. | `PUT /tasks/{id}/unschedule` | SINGLEOPS_ENABLE_WRITE |
| 28 | `singleops_write_create_tax_location` | Create tax location. | `POST /tax_locations` | SINGLEOPS_ENABLE_WRITE |
| 29 | `singleops_write_create_tax_rate` | Create tax rate. | `POST /tax_rates` | SINGLEOPS_ENABLE_WRITE |
| 30 | `singleops_write_create_term` | Create term. | `POST /terms` | SINGLEOPS_ENABLE_WRITE |
| 31 | `singleops_write_update_term` | Update term for one id. | `PATCH /terms/{id}` | SINGLEOPS_ENABLE_WRITE |
| 32 | `singleops_write_update_timesheet_event` | Update timesheet event for one id. | `PATCH /timesheet_events/{id}` | SINGLEOPS_ENABLE_WRITE |
| 33 | `singleops_write_create_timesheet` | Create timesheet. | `POST /timesheets` | SINGLEOPS_ENABLE_WRITE |
| 34 | `singleops_write_create_unit_of_measure` | Create unit of measure. | `POST /unit_of_measures` | SINGLEOPS_ENABLE_WRITE |
| 35 | `singleops_write_create_vendor` | Create vendor. | `POST /vendors` | SINGLEOPS_ENABLE_WRITE |
| 36 | `singleops_write_create_visit` | Create visit. | `POST /visits` | SINGLEOPS_ENABLE_WRITE |
| 37 | `singleops_write_update_visit` | Update visit for one id. | `PATCH /visits/{id}` | SINGLEOPS_ENABLE_WRITE |

### Delete tools (8)

**Destructive.** Registered only when `SINGLEOPS_ENABLE_DELETE=true` (default `false`). Sending needs `dry_run: false` **and** `confirm: "DELETE <path>"` naming the one record.

| ID | Tool name | Description | Endpoint | Enabled when |
|---|---|---|---|---|
| 1 | `singleops_write_delete_client` | Delete client. | `DELETE /clients/{id}` | SINGLEOPS_ENABLE_DELETE |
| 2 | `singleops_write_delete_custom_input` | Delete custom input. | `DELETE /custom_inputs/{id}` | SINGLEOPS_ENABLE_DELETE |
| 3 | `singleops_write_delete_invoice` | Delete invoice. | `DELETE /invoices/{id}` | SINGLEOPS_ENABLE_DELETE |
| 4 | `singleops_write_delete_operation` | Delete operation. | `DELETE /operations/{id}` | SINGLEOPS_ENABLE_DELETE |
| 5 | `singleops_write_delete_tag` | Delete tag. | `DELETE /tags/{id}` | SINGLEOPS_ENABLE_DELETE |
| 6 | `singleops_write_delete_task` | Delete task. | `DELETE /tasks/{id}` | SINGLEOPS_ENABLE_DELETE |
| 7 | `singleops_write_delete_term` | Delete term. | `DELETE /terms/{id}` | SINGLEOPS_ENABLE_DELETE |
| 8 | `singleops_write_delete_timesheet_event` | Delete timesheet event. | `DELETE /timesheet_events/{id}` | SINGLEOPS_ENABLE_DELETE |

### Denied by policy (never exposed) (15)

Mapped so you know they exist, but no flag turns them on: they move money, change billing or logins, message customers, or reconfigure the account.

| ID | Tool name | Description | Endpoint | Enabled when |
|---|---|---|---|---|
| 1 | `singleops_write_update_account_setting_general_settings` | Update account setting general settings. | `POST /account_settings/update_general_settings` | never (account-wide settings) |
| 2 | `singleops_write_update_account_setting_payment_gateway` | Update account setting payment gateway. | `POST /account_settings/update_payment_gateway` | never (billing, payments or subscription) |
| 3 | `singleops_write_update_account` | Update account for one id. | `PATCH /accounts/{id}` | never (account-wide settings) |
| 4 | `singleops_write_create_financing` | Create financing. | `POST /financings` | never (billing, payments or subscription) |
| 5 | `singleops_write_custom_import_input_drop_downs_import` | Custom import input drop downs import. | `POST /imports/custom_input_drop_downs_import` | never (bulk import) |
| 6 | `singleops_read_list_inventories_search_and_repredict` | List inventories search and repredict. | `POST /inventories/search_and_repredict` | never (bulk recalculation or UI state) |
| 7 | `singleops_write_update_propay_config` | Update propay config for one id. | `PATCH /propay_configs/{id}` | never (billing, payments or subscription) |
| 8 | `singleops_write_salesforce_subscription_add` | Salesforce subscription add for one id. | `POST /subscription/licenses/{id}/salesforce_subscription_add` | never (billing, payments or subscription) |
| 9 | `singleops_write_update_subscription` | Update subscription for one id. | `PATCH /subscriptions/{id}` | never (billing, payments or subscription) |
| 10 | `singleops_write_create_user` | Create user. | `POST /users` | never (user accounts and logins) |
| 11 | `singleops_write_update_user` | Update user for one id. | `PATCH /users/{id}` | never (user accounts and logins) |
| 12 | `singleops_write_clear_user_tooltip_history` | Clear user tooltip history for one id. | `POST /users/{id}/clear_tooltip_history` | never (user accounts and logins) |
| 13 | `singleops_write_resend_user_invitation` | Resend user invitation for one id. | `POST /users/{id}/resend_invitation` | never (user accounts and logins) |
| 14 | `singleops_write_save_user_table_settings` | Save user table settings. | `POST /users/save_table_settings` | never (user accounts and logins) |
| 15 | `singleops_write_email_visit` | Email visit. | `POST /visits/email` | never (sends to customers) |

<!-- TOOLS:END -->

---

## Examples

**Health check:** `singleops_read_whoami` returns the session status, the gates, the write budget and a live probe.

**Find a client and their jobs:**
1. `singleops_read_search_clients` with `body: {"start":0,"length":10,"search":{"value":"Lee"}}`
2. `singleops_read_list_client_jobs` with `id: <client id>`

**Revenue report:** `singleops_read_get_net_sales_report`, with a date range in `extra_query` (reports need dates; without them some return HTTP 500).

**Create a client (writes enabled):**
1. `singleops_write_create_client` with `body: {"client":{"first_name":"ZZ","last_name":"TEST-MCP"}}`. This returns the dry-run request.
2. Repeat with `dry_run: false`. This returns `{ok: true, redirect: "/clients/123", id: "123"}`.

**Update job notes:** `singleops_write_update_job_notes` with `id: 123`, `body: {"job":{"crew_notes":"Bring the 60ft lift"}}` and `dry_run: false`.

**Delete a test tag (deletes enabled):** `singleops_write_delete_tag` with `id: 42`, `dry_run: false` and `confirm: "DELETE /tags/42"`.

**Anything else:** `singleops_discover_tools` with `domain: "visits"`, then `singleops_call_route` with the tool name.

---

## Development

```bash
npm run build        # tsc → dist/
npm test             # vitest: map building, no-leak guarantees, auth replay, gates, dry-run, Rails encoding
npm run inspect      # MCP Inspector against the stdio server
npm run docs         # regenerate the README tool tables
npm run forms -- capture/<file>.har   # list write forms found in a capture
```

Layout:

```
src/
  index.ts     stdio + Streamable HTTP entry
  tools.ts     tool generation, gates, dry-run, catalog, meta tools
  naming.ts    {service}_{read|write}_{verb}_{entity} names
  client.ts    throttled, retrying HTTP; Rails form submit + redirect/error handling
  auth.ts      session cookie + CSRF replay from state/session.json
  rails.ts     nested param encoding, validation-error parsing
  format.ts    markdown rendering
  map.ts       route types + the 4 Lead Entry routes
scripts/
  capture.mjs        login / crawl / manual capture (Playwright, headed)
  har-to-map.mjs     HAR (+ HTML forms) → api-map.json
  audit-actions.mjs  post-crawl "did anything change?" report
  gen-readme-tools.mjs
```

Credit: the retry and error patterns follow `sanjibani/singleops-mcp` (MIT), which wraps the Lead Entry API.

## License

MIT. See [LICENSE](LICENSE).
