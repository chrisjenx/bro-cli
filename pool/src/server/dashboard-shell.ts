export function dashboardShell(css: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bro / pool</title>
<style>${css}</style>
</head>
<body>
<header class="app-header">
<a class="brand" href="#" aria-label="Pool overview">bro <span>/ pool</span>
</a>
<nav aria-label="Dashboard views">
<button type="button" data-view="overview" aria-current="page">Overview</button>
<button type="button" data-view="routing">Routing</button>
<button type="button" data-view="settings">Settings</button>
</nav>
<div class="header-actions">
<span id="connection-feedback" role="status">Connecting…</span>
<button type="button" class="icon-button" data-retry aria-label="Refresh status" title="Refresh status">↻</button>
<button type="button" class="icon-button" id="theme-toggle" aria-label="Toggle color theme" title="Toggle color theme">◐</button>
</div>
</header>
<main>
<p id="transport-error" class="notice error" hidden>
</p>
<section id="overview-view" aria-labelledby="overview-title">
<div class="page-heading">
<div>
<p class="eyebrow">MONITOR</p>
<h1 id="overview-title" tabindex="-1">Pool overview</h1>
<p class="subtitle">Account health and reported subscription usage</p>
</div>
<span class="scope-label">All providers · account-wide</span>
</div>
<div class="metrics">
<div class="metric">
<span>Available accounts</span>
<strong data-metric="available">—</strong>
<small>Across all providers</small>
</div>
<div class="metric">
<span>Active sessions</span>
<strong data-metric="sessions">—</strong>
<small>Pinned across the pool</small>
</div>
<div class="metric">
<span>In-flight requests</span>
<strong data-metric="inflight">—</strong>
<small>Currently being served</small>
</div>
<div class="metric">
<span>Unavailable accounts</span>
<strong data-metric="unavailable">—</strong>
<small>Login, cooldown or other limits</small>
</div>
</div>
<div data-attention class="notice" hidden>
<span data-attention-text>
</span>
<div class="notice-actions">
<button type="button" data-filter-unavailable>View unavailable</button>
<button type="button" data-filter-warning>View usage warnings</button>
</div>
</div>
<div data-account-list>
<div class="toolbar">
<h2>Accounts <span class="muted" data-account-count>
</span>
</h2>
<div class="filters">
<label class="search">
<span class="sr-only">Search accounts</span>
<input type="search" aria-label="Search accounts" placeholder="Search accounts…" autocomplete="off">
</label>
<label>
<span class="sr-only">Provider</span>
<select aria-label="Provider">
<option value="all">All providers</option>
<option value="anthropic">Anthropic</option>
<option value="openai">OpenAI</option>
</select>
</label>
<label>
<span class="sr-only">Account status</span>
<select aria-label="Account status">
<option value="all">All statuses</option>
<option value="ready">Ready</option>
<option value="cooldown">Cooldown</option>
<option value="logged-out">Logged out</option>
<option value="sidelined">Sidelined</option>
<option value="unavailable">Unavailable</option>
<option value="usage-warning">Usage warnings</option>
</select>
</label>
</div>
</div>
<div class="table-region">
<table class="overview-table">
<thead data-overview-head>
<tr>
<th aria-sort="ascending">
<button data-sort="name">Account <span aria-hidden="true">↑</span>
</button>
</th>
<th>
<button data-sort="status">Status</button>
</th>
<th>
<button data-sort="fiveHour">5h used</button>
</th>
<th>
<button data-sort="sevenDay">7d used</button>
</th>
<th class="overview-reset">
<button data-sort="nextReset">Next reset</button>
</th>
<th class="overview-sessions">
<button data-sort="activeSessions">Sessions</button>
</th>
<th class="overview-inflight">
<button data-sort="inFlight">In-flight</button>
</th>
</tr>
</thead>
<tbody data-overview-rows>
</tbody>
</table>
</div>
<p data-loading class="empty">Loading pool status…</p>
<p data-filter-empty class="empty" hidden>No accounts match. <button type="button" data-clear-filters>Clear filters</button>
</p>
<p class="table-note">Select an account for details. Missing usage means “Not reported”, never zero.</p>
</div>
<section id="onboard" class="onboard" hidden>
<h2>Set up your first account</h2>
<p>Account setup stays in the CLI. Run these commands from the pool package directory.</p>
<ol>
<li>
<h3>Install Claude Code if needed</h3>
<p>The pool uses account OAuth credentials; direct proxying does not launch a CLI per request.</p>
<div class="command">
<code>npm install -g @anthropic-ai/claude-code</code>
<button data-copy>Copy</button>
</div>
</li>
<li>
<h3>Log in an isolated account</h3>
<div class="command">
<code>bun run src/index.ts accounts login work</code>
<button data-copy>Copy</button>
</div>
<p>In the opened CLI, run <code>/login</code>, complete sign-in, then <code>/exit</code>.</p>
</li>
<li>
<h3>Or import your existing login</h3>
<div class="command">
<code>bun run src/index.ts accounts import primary</code>
<button data-copy>Copy</button>
</div>
</li>
<li>
<h3>Connect your client</h3>
<p>Use the pool’s <code data-origin-path="/v1">/v1</code> endpoint. This page discovers accounts automatically.</p>
</li>
</ol>
</section>
</section>
<section id="routing-view" aria-labelledby="routing-title" hidden>
<div class="page-heading">
<div>
<p class="eyebrow">INSPECT</p>
<h1 id="routing-title" tabindex="-1">Routing</h1>
<p class="subtitle">Understand the next new session. Existing session pins stay stable.</p>
</div>
<label class="context-select">Routing model family <select aria-label="Routing model family" data-routing-context>
</select>
</label>
</div>
<p data-routing-context-note class="notice">
</p>
<div data-routing-pick class="routing-pick">
</div>
<p data-routing-pending class="notice" hidden>Updating routing context…</p>
<div class="toolbar">
<h2>Active candidates</h2>
<span class="muted">Server preview order · not a ranking</span>
</div>
<div class="table-region">
<table class="routing-table">
<thead>
<tr>
<th>Account</th>
<th>Priority</th>
<th>Weight</th>
<th>Expiry share</th>
<th>5h headroom</th>
<th>Sessions</th>
<th>In-flight</th>
<th>Viability</th>
<th>Score</th>
</tr>
</thead>
<tbody data-routing-candidates>
</tbody>
</table>
</div>
<p data-no-candidates class="empty" hidden>No candidates in this context.</p>
<h2 class="section-title">Outside the current candidate set</h2>
<div class="table-region">
<table>
<thead>
<tr>
<th>Account</th>
<th>Account status</th>
<th>Context</th>
</tr>
</thead>
<tbody data-routing-others>
</tbody>
</table>
</div>
</section>
<section id="settings-view" aria-labelledby="settings-title" hidden>
<div class="page-heading">
<div>
<p class="eyebrow">CONFIGURE</p>
<h1 id="settings-title" tabindex="-1">Settings</h1>
<p class="subtitle">Explicit saves. Live monitoring continues while you edit.</p>
</div>
</div>
<form novalidate data-mapping-form class="settings-panel">
<div class="panel-heading">
<h2>Model mappings</h2>
<p class="muted">Choose which provider targets can serve each model family.</p>
</div>
<fieldset data-mapping-fields>
<label class="toggle-label">
<input type="checkbox" data-mapping-enabled> Pool Claude + Codex capacity</label>
<div data-mapping-rows>
</div>
</fieldset>
<p data-mapping-warning class="notice" hidden>
</p>
<div class="form-actions">
<button type="submit" class="primary">Save mappings</button>
<button type="button" data-cancel-mapping>Cancel</button>
<span data-mapping-feedback role="status">
</span>
</div>
</form>
<form novalidate data-tuning-form class="settings-panel">
<div class="panel-heading">
<h2>Routing tuning</h2>
<p class="muted">Controls for five-hour headroom. These are session-allocation factors, not token or request ratios.</p>
</div>
<fieldset data-tuning-fields class="tuning-grid">
</fieldset>
<details class="help">
<summary>How weighted routing works</summary>
<p>Weekly expiry shares follow distinct reset times (5:3:2:1:0.5:0.25…), multiplied by manual weight and the five-hour taper, divided by pinned sessions + 1. Above the taper start the five-hour factor is neutral. The minimum headroom gate is five-hour-only, with best-effort fallback. Weekly capacity remains usable until exhausted; existing session pins stay stable.</p>
</details>
<div class="form-actions">
<button type="submit" class="primary">Apply tuning</button>
<button type="button" data-cancel-tuning>Cancel</button>
<span data-tuning-feedback role="status">
</span>
</div>
</form>
</section>
</main>
<footer>
<span>bro / pool</span>
<div>
<code>/v1/messages</code>
<code>/v1/chat/completions</code>
<code>/v1/models</code>
<code>/api/status</code>
</div>
<span data-copy-feedback role="status">
</span>
</footer>
<dialog id="account-drawer" class="account-drawer" aria-labelledby="account-title">
<div class="drawer-heading">
<button type="button" class="icon-button close" aria-label="Close account details">×</button>
<p class="eyebrow">ACCOUNT DETAILS</p>
<h2 id="account-title">
</h2>
<p data-account-meta class="muted">
</p>
</div>
<div class="drawer-body">
<p data-account-removed class="notice error" hidden>Account removed. These are its last known details; saving is disabled.</p>
<p data-account-reason class="notice" hidden>
</p>
<h3>Reported usage</h3>
<div data-detail-windows>
</div>
<p data-usage-freshness class="muted small">
</p>
<p data-usage-error class="notice" hidden>
</p>
<details data-auth-details>
<summary>Authentication &amp; activity</summary>
<dl data-auth-values>
</dl>
<p class="muted small">Local counters and recorded cost are operational values, not subscription balances.</p>
<div data-auth-help class="notice" hidden>Authenticate this account from the pool CLI: <code data-login-command>
</code>
</div>
</details>
<details data-detail-routing>
<summary>Routing details</summary>
<p data-detail-context class="muted">
</p>
<dl data-detail-factors>
</dl>
<p data-detail-route-reason class="muted small">
</p>
<button type="button" data-view-routing>View in Routing →</button>
</details>
<form novalidate data-account-form>
<h3>Account settings</h3>
<fieldset data-account-fields class="account-fields">
<label>Priority<input type="number" name="priority" aria-label="Priority" min="0" step="1">
</label>
<label>Weight<input type="number" name="weight" aria-label="Weight" step="any">
</label>
</fieldset>
<div class="form-actions">
<button type="submit" class="primary">Save changes</button>
<button type="button" data-cancel-account>Cancel</button>
</div>
<p data-account-feedback role="status">
</p>
<p data-account-conflict class="notice" hidden>Server settings changed while you were editing. Cancel loads the latest values; Save applies your draft.</p>
</form>
</div>
</dialog>
<dialog id="discard-dialog" class="decision-dialog" aria-labelledby="discard-title">
<h2 id="discard-title">Unsaved changes</h2>
<p>Save your changes before leaving, or explicitly discard them.</p>
<p data-transition-error class="notice error" hidden>
</p>
<div class="form-actions">
<button type="button" class="primary" data-decision="save">Save and continue</button>
<button type="button" data-decision="discard">Discard changes</button>
<button type="button" data-decision="stay">Keep editing</button>
</div>
</dialog>
<script>${script}</script>
</body>
</html>`;
}
