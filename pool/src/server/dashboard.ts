/**
 * Self-contained status dashboard. Served at `/`, it polls `/api/status` and
 * renders one card per account: auth state, plan/tier, token expiry, rolling
 * usage, and rate-limit cooldown. No external assets (CSP-friendly).
 *
 * Visual language mirrors Claude.ai: warm paper background, editorial serif
 * display type, clay accent, hairline borders, restrained shadows. Supports a
 * light/dark theme toggle (dark is Claude's warm charcoal).
 */

import { TUNING_BOUNDS } from "../accounts/manager.ts";
import { MODEL_FAMILIES } from "../accounts/types.ts";
import { SOURCE_EFFORT_TIERS, CODEX_EFFORTS } from "../models.ts";

/** Presentation for each tuning knob; min/max come from the shared TUNING_BOUNDS. */
const TUNING_LABELS: Record<keyof typeof TUNING_BOUNDS, { label: string; step: string }> = {
  fiveHourExp: { label: "5h weight", step: "0.1" },
  loadSlope: { label: "Session load", step: "0.1" },
  urgencyDecay: { label: "7d urgency decay", step: "0.05" },
  minHeadroom: { label: "Min headroom gate", step: "0.05" },
};

export function dashboardHtml(): string {
  // Field descriptors built once from the single source of truth (TUNING_BOUNDS)
  // and inlined into the client script, so client input ranges can't drift from
  // the server's validation bounds.
  const tuningFields = (Object.keys(TUNING_BOUNDS) as (keyof typeof TUNING_BOUNDS)[]).map((key) => ({
    key,
    label: TUNING_LABELS[key].label,
    step: TUNING_LABELS[key].step,
    min: TUNING_BOUNDS[key].min,
    max: TUNING_BOUNDS[key].max,
  }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Max Pool</title>
<style>
  :root {
    --bg: #f5f4ef; --surface: #ffffff; --surface-2: #faf9f5;
    --border: #e7e4da; --border-strong: #dbd7ca;
    --text: #1c1b19; --muted: #6e6c64; --faint: #93908544;
    --accent: #c96442; --accent-hover: #b15537; --accent-soft: #f2e7e0;
    --ready: #5b9a6e; --warn: #b9812f; --err: #c0553f;
    --track: #eceae1;
    --shadow: 0 1px 2px rgba(28,27,25,.04), 0 2px 6px rgba(28,27,25,.04);
    --shadow-hover: 0 2px 4px rgba(28,27,25,.06), 0 8px 24px rgba(28,27,25,.06);
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  }
  /* Dark palette applied by system preference (unless overridden to light) OR explicit toggle */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #262624; --surface: #302f2c; --surface-2: #35342f;
      --border: #3e3d38; --border-strong: #4a483f;
      --text: #f4f2ec; --muted: #a6a399; --faint: #ffffff10;
      --accent: #d97757; --accent-hover: #e28a6d; --accent-soft: #3a2f28;
      --ready: #6fb283; --warn: #d2a24a; --err: #db7b63;
      --track: #3a3934;
      --shadow: 0 1px 2px rgba(0,0,0,.24), 0 2px 6px rgba(0,0,0,.20);
      --shadow-hover: 0 2px 4px rgba(0,0,0,.3), 0 10px 28px rgba(0,0,0,.32);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #262624; --surface: #302f2c; --surface-2: #35342f;
    --border: #3e3d38; --border-strong: #4a483f;
    --text: #f4f2ec; --muted: #a6a399; --faint: #ffffff10;
    --accent: #d97757; --accent-hover: #e28a6d; --accent-soft: #3a2f28;
    --ready: #6fb283; --warn: #d2a24a; --err: #db7b63;
    --track: #3a3934;
    --shadow: 0 1px 2px rgba(0,0,0,.24), 0 2px 6px rgba(0,0,0,.20);
    --shadow-hover: 0 2px 4px rgba(0,0,0,.3), 0 10px 28px rgba(0,0,0,.32);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 var(--sans);
    letter-spacing: -0.005em; }

  header { border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px; padding: 18px 28px;
    position: sticky; top: 0; background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(1.2) blur(8px); z-index: 10; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { width: 34px; height: 34px; border-radius: 9px; background: var(--accent);
    display: grid; place-items: center; color: #fff; font-family: var(--serif); font-size: 20px;
    font-weight: 600; line-height: 1; }
  h1 { font-family: var(--serif); font-size: 21px; margin: 0; font-weight: 500; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 1px; }
  .spacer { flex: 1; }
  .chips { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .chip { font-size: 12.5px; padding: 5px 11px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface); color: var(--muted); white-space: nowrap; }
  .chip b { color: var(--text); font-weight: 600; }
  .chip.time { border: none; background: transparent; padding-left: 2px; }
  .icon-btn { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--surface); color: var(--muted); cursor: pointer; display: grid; place-items: center;
    font-size: 15px; transition: color .15s, border-color .15s; }
  .icon-btn:hover { color: var(--text); border-color: var(--border-strong); }

  main { padding: 32px 28px 8px; max-width: 1120px; margin: 0 auto; }
  /* Block container for full-width tier sections; .tier-grid tiles the cards. */
  .grid { display: block; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 16px 18px; box-shadow: var(--shadow); transition: box-shadow .18s, transform .18s, border-color .18s; }
  .card:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); }
  .card.down { background: var(--surface-2); }
  .card.next { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
  .card.flash { animation: flash 1.6s ease; }
  @keyframes flash { 0% { background: var(--accent-soft); } 100% { background: var(--surface); } }
  .card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .status { display: inline-flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--ready); } .dot.warn { background: var(--warn); } .dot.err { background: var(--err); }
  .acct-name { font-family: var(--serif); font-weight: 500; font-size: 17px; letter-spacing: -0.01em; }
  .state { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .chip.plan { margin-left: auto; font-size: 11.5px; padding: 3px 9px;
    background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 500; }
  .badge { font-size: 10.5px; padding: 3px 8px; border-radius: 999px; text-transform: uppercase;
    letter-spacing: .04em; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); }

  .dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; font-size: 13px; }
  .dl .k { color: var(--muted); }
  .dl .v { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }

  .bars { margin-top: 12px; display: grid; gap: 8px; }
  .bar-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  .bar-label .num { font-variant-numeric: tabular-nums; color: var(--text); }
  .bar { height: 5px; background: var(--track); border-radius: 999px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s ease; }

  .note { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--border);
    font-size: 12.5px; color: var(--warn); }
  .note.err { color: var(--err); }

  /* Summary table: one glance row per account above the detail cards */
  .summary-tbl { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    overflow-x: auto; box-shadow: var(--shadow); margin-bottom: 26px; }
  .summary-tbl table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .summary-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); font-weight: 600; padding: 10px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface-2); }
  .summary-tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .summary-tbl tr:last-child td { border-bottom: none; }
  .summary-tbl tr.acct:hover { background: var(--surface-2); cursor: pointer; }
  .summary-tbl .c-dot { width: 24px; padding-right: 0; }
  .summary-tbl .prov { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .summary-tbl .mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
  .summary-tbl .mini .bar { flex: 1; }
  .summary-tbl .mini .pct { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px;
    width: 34px; text-align: right; }
  .summary-tbl td.num { font-variant-numeric: tabular-nums; }
  .summary-tbl td.muted { color: var(--muted); }

  /* Attention banner */
  .banner { display: none; background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--warn); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px;
    font-size: 13.5px; color: var(--text); box-shadow: var(--shadow); }
  .banner b { font-weight: 600; }
  .banner code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border);
    padding: 2px 6px; border-radius: 5px; font-size: 12.5px; }

  /* Onboarding walkthrough */
  .onboard { max-width: 720px; margin: 8px auto 0; display: none; }
  .onboard-head { text-align: center; margin-bottom: 30px; }
  .onboard-head h2 { font-family: var(--serif); font-weight: 500; font-size: 27px; margin: 0 0 8px; letter-spacing: -0.015em; }
  .onboard-head p { margin: 0; color: var(--muted); font-size: 15px; }
  .steps { display: grid; gap: 14px; }
  .step { display: grid; grid-template-columns: 32px 1fr; gap: 16px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; box-shadow: var(--shadow); }
  .step .num { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid var(--accent);
    color: var(--accent); display: grid; place-items: center; font-family: var(--serif); font-weight: 600; font-size: 15px; }
  .step h3 { margin: 3px 0 8px; font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em; }
  .step p { margin: 0 0 12px; color: var(--muted); font-size: 13.5px; }
  .step p:last-child { margin-bottom: 0; }
  .step code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border);
    padding: 1px 6px; border-radius: 5px; font-size: 12.5px; color: var(--text); }
  .cmd { display: flex; align-items: center; gap: 12px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 9px; padding: 11px 14px; margin: 8px 0; }
  .cmd .prompt { color: var(--accent); font-family: var(--mono); user-select: none; }
  .cmd > code { flex: 1; background: none; border: none; padding: 0; font-size: 13px;
    white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .cmd button { background: var(--surface); color: var(--muted); border: 1px solid var(--border);
    border-radius: 7px; padding: 5px 11px; font-size: 11.5px; font-family: var(--sans); cursor: pointer;
    transition: color .15s, border-color .15s; }
  .cmd button:hover { color: var(--text); border-color: var(--border-strong); }
  .step small { color: var(--muted); font-size: 12.5px; }
  .waiting { text-align: center; margin-top: 26px; color: var(--muted); font-size: 13px; }
  .waiting .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--ready); margin-right: 7px; animation: pulse 1.6s ease-in-out infinite; vertical-align: middle; }
  @keyframes pulse { 0%,100% { opacity: .3; } 50% { opacity: 1; } }

  footer { color: var(--muted); font-size: 12.5px; text-align: center; padding: 30px 20px 36px; }
  footer code { font-family: var(--mono); background: var(--surface); border: 1px solid var(--border);
    padding: 2px 7px; border-radius: 5px; color: var(--muted); margin: 0 2px; }

  .tier { margin-bottom: 26px; }
  .tier-head { display: flex; align-items: baseline; gap: 10px; font-family: var(--serif);
    font-weight: 500; font-size: 16px; margin: 0 0 12px; letter-spacing: -0.01em; }
  .tier-head.dim { opacity: .5; }
  .tier-meta { font-size: 12px; color: var(--muted); font-family: var(--sans); }
  .tier-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 18px; }
  .badge.next { background: var(--accent-soft); color: var(--accent); border-color: transparent; font-weight: 600; }
  /* Live "next pick" panel: standalone card, always visible (not settings). */
  .routing-panel { display: none; background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--accent); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px;
    font-size: 13.5px; color: var(--text); box-shadow: var(--shadow);
    gap: 28px; align-items: flex-start; flex-wrap: wrap; }
  .routing-panel .muted { color: var(--muted); }
  .routing-panel .pick b { font-family: var(--serif); font-size: 16px; font-weight: 600; }
  .routing-panel .summary { font-size: 12px; margin-top: 2px; }
  .routing-panel .why { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  .routing-panel .why .fact { display: grid; grid-template-columns: 110px 1fr; gap: 10px; font-size: 12.5px; }
  .routing-panel .why .fk { color: var(--muted); }
  .routing-panel .why .fact.decisive .fv { color: var(--accent); font-weight: 600; }

  /* Settings group: one collapsible card wrapping the config disclosures
     (Model mapping, Routing tuning). Collapsed by default; open state persists
     in localStorage. Both nested panels always live inside this group. */
  .settings-group { display: none; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; margin-bottom: 20px; box-shadow: var(--shadow); }
  .settings-group > summary { list-style: none; cursor: pointer; padding: 12px 18px;
    display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600;
    letter-spacing: -0.01em; color: var(--text); user-select: none; }
  .settings-group > summary::-webkit-details-marker { display: none; }
  .settings-group > summary::before { content: "⚙"; color: var(--muted); font-weight: 400; }
  .settings-group > summary .caret { margin-left: auto; color: var(--muted); font-size: 11px;
    transition: transform .15s ease; }
  .settings-group[open] > summary { border-bottom: 1px solid var(--border); }
  .settings-group[open] > summary .caret { transform: rotate(90deg); }
  .settings-body { padding: 2px 18px 12px; }

  /* Nested config disclosures — flat (no card chrome), hairline-separated. */
  .mapping-panel, .tuning-panel { display: none; font-size: 13.5px; color: var(--text); }
  .settings-body > details + details { border-top: 1px solid var(--border); }
  .mapping-panel > summary, .tuning-panel > summary { list-style: none; cursor: pointer;
    padding: 12px 0; display: flex; align-items: center; gap: 8px; font-size: 13.5px;
    font-weight: 600; letter-spacing: -0.01em; color: var(--text); user-select: none; }
  .mapping-panel > summary::-webkit-details-marker,
  .tuning-panel > summary::-webkit-details-marker { display: none; }
  .mapping-panel > summary .caret, .tuning-panel > summary .caret { margin-left: auto;
    color: var(--muted); font-size: 11px; transition: transform .15s ease; }
  .mapping-panel[open] > summary .caret, .tuning-panel[open] > summary .caret { transform: rotate(90deg); }

  .mapping-panel .muted { color: var(--muted); font-size: 12px; font-family: var(--sans); font-weight: 400; }
  .mapping-panel .hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
  .mapping-panel .mapping-body > label { display: block; margin-bottom: 12px; font-size: 13px; }
  .mapping-panel .map-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 8px 0; border-top: 1px solid var(--border); }
  .mapping-panel .map-row select { font: inherit; padding: 4px 8px; border: 1px solid var(--border);
    border-radius: 6px; background: var(--surface-2); color: var(--text); }
  .mapping-panel .efforts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; }
  .mapping-panel .efforts .tier { display: flex; align-items: center; gap: 5px; margin-bottom: 0; }
  .mapping-panel .efforts .tier label { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
  .mapping-panel .efforts select { font-size: 12px; padding: 3px 6px; }
  .mapping-panel #mapping-save { margin-top: 12px; background: var(--surface); color: var(--muted);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
  .mapping-panel #mapping-save:hover { color: var(--text); border-color: var(--border-strong); }
  .tuning-panel .tuning-body { padding: 2px 0 12px; }
  .tuning-panel .hint { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .tuning-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px 18px; }
  .tuning-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .tuning-field label { color: var(--muted); }
  .tuning-field .k { color: var(--text); font-weight: 600; }
  .tuning-field input { width: 100%; font: inherit; padding: 5px 7px; border: 1px solid var(--border);
    border-radius: 6px; background: var(--surface-2); color: var(--text); }
  .tuning-actions { margin-top: 13px; display: flex; align-items: center; gap: 10px; }
  .tuning-actions button { background: var(--surface); color: var(--muted); border: 1px solid var(--border);
    border-radius: 7px; padding: 5px 14px; font-size: 12px; cursor: pointer; }
  .tuning-actions button:hover { color: var(--text); border-color: var(--border-strong); }
  .mapping-panel .status, .tuning-actions .status { font-size: 12px; color: var(--muted); margin-left: 10px; }
  .tier-edit { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
  .tier-edit input { width: 60px; font: inherit; padding: 4px 6px; border: 1px solid var(--border);
    border-radius: 6px; background: var(--surface-2); color: var(--text); }
  .tier-edit button { background: var(--surface); color: var(--muted); border: 1px solid var(--border);
    border-radius: 7px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; }
  .tier-edit button:hover { color: var(--text); border-color: var(--border-strong); }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="logo">C</div>
    <div>
      <h1>Claude Max Pool</h1>
      <div class="sub">Many Claude plans, one endpoint</div>
    </div>
  </div>
  <div class="spacer"></div>
  <div class="chips">
    <span class="chip" id="p-accounts">accounts <b>&ndash;</b></span>
    <span class="chip" id="p-available">available <b>&ndash;</b></span>
    <span class="chip" id="p-window">window <b>&ndash;</b></span>
    <span class="chip time" id="p-updated">&ndash;</span>
    <button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </div>
</header>
<main>
  <div class="routing-panel" id="routing-panel"></div>
  <details class="settings-group" id="settings-group">
    <summary>Settings<span class="caret">▶</span></summary>
    <div class="settings-body">
      <details class="mapping-panel" id="mapping-panel"></details>
      <details class="tuning-panel" id="tuning-panel"></details>
    </div>
  </details>
  <div class="banner" id="banner"></div>
  <div class="summary-tbl" id="summary" style="display:none"></div>
  <div class="grid" id="grid"></div>

  <section class="onboard" id="onboard">
    <div class="onboard-head">
      <h2>Let&rsquo;s set up your first account</h2>
      <p>Each account is a separate Claude Max or Team login the proxy can route between. Add as many as you like.</p>
    </div>
    <div class="steps">
      <div class="step">
        <div class="num">1</div>
        <div>
          <h3>Install the Claude CLI</h3>
          <p>The proxy uses Claude Code logins for account OAuth credentials. Serving requests uses the direct Anthropic backend by default.</p>
          <div class="cmd"><span class="prompt">$</span><code>npm install -g @anthropic-ai/claude-code</code><button data-copy>Copy</button></div>
          <p><small>Already installed? Skip ahead.</small></p>
        </div>
      </div>
      <div class="step">
        <div class="num">2</div>
        <div>
          <h3>Log in your first plan</h3>
          <p>Opens the Claude CLI in an isolated config directory for an account named <code>work</code>. Inside, run <code>/login</code>, finish the browser sign-in, then <code>/exit</code>.</p>
          <div class="cmd"><span class="prompt">$</span><code>bun run src/index.ts accounts login work</code><button data-copy>Copy</button></div>
          <p><small>Use any name &mdash; <code>work</code>, <code>personal</code>, <code>team2</code>. Repeat for each plan you want to pool.</small></p>
        </div>
      </div>
      <div class="step">
        <div class="num">3</div>
        <div>
          <h3>Or import an existing login</h3>
          <p>Already signed in with <code>claude</code> on this machine? Copy that login into the pool &mdash; no re-auth needed.</p>
          <div class="cmd"><span class="prompt">$</span><code>bun run src/index.ts accounts import primary</code><button data-copy>Copy</button></div>
        </div>
      </div>
      <div class="step">
        <div class="num">4</div>
        <div>
          <h3>Send a request</h3>
          <p>Once an account is authenticated this page fills in on its own and the endpoints go live.</p>
          <div class="cmd"><span class="prompt">$</span><code>curl http://localhost:PORT_PLACEHOLDER/v1/chat/completions -H "content-type: application/json" -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'</code><button data-copy>Copy</button></div>
          <p><small>Works with any OpenAI or Anthropic client &mdash; point it at <code>/v1</code>.</small></p>
        </div>
      </div>
    </div>
    <div class="waiting"><span class="live"></span>Watching for accounts &mdash; this page refreshes automatically.</div>
  </section>
</main>
<footer>
  <code>/v1/chat/completions</code> <code>/v1/messages</code> <code>/v1/models</code> <code>/api/status</code>
</footer>
<script>
// Theme: follow system by default; toggle overrides and persists.
(function () {
  const saved = localStorage.getItem("cmp-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  const btn = document.getElementById("theme-toggle");
  btn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = cur ? (cur === "dark" ? "light" : "dark") : (sysDark ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cmp-theme", next);
  });
})();

// Settings forms (Model mapping, Routing tuning) are user-editable, so the 4s
// poll must never overwrite an edit in progress. Each panel tracks a "dirty"
// flag (touched since its last render) and the JSON of the data last rendered;
// renderSettings() consults both. A one-time delegated input/change listener
// (wired below) sets dirty; Save clears it and forces a fresh render.
var settingsDirty = { "mapping-panel": false, "tuning-panel": false };
var settingsRendered = { "mapping-panel": null, "tuning-panel": null };
var accountSettingsDirty = false;

// Collapsible panels: restore each disclosure's open state (collapsed by
// default) and persist it on toggle; wire the per-panel dirty flag.
(function () {
  ["settings-group", "mapping-panel", "tuning-panel"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (localStorage.getItem("cmp-open-" + id) === "1") el.open = true;
    el.addEventListener("toggle", function () {
      localStorage.setItem("cmp-open-" + id, el.open ? "1" : "0");
    });
  });
  ["mapping-panel", "tuning-panel"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const mark = function () { settingsDirty[id] = true; };
    el.addEventListener("input", mark);
    el.addEventListener("change", mark);
  });
  const grid = document.getElementById("grid");
  const markAccountSettings = function () { accountSettingsDirty = true; };
  grid.addEventListener("input", markAccountSettings);
  grid.addEventListener("change", markAccountSettings);
})();

const fmtInt = (n) => (n ?? 0).toLocaleString();
const fmtUsd = (n) => "$" + (n ?? 0).toFixed(4);
function timeUntil(ts) {
  if (!ts) return "–";
  const d = ts - Date.now();
  if (d <= 0) return "now";
  const m = Math.round(d / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60); return h + "h " + (m % 60) + "m";
}
function ago(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); return h + "h ago";
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// Shared account-derived values, used by both the summary row and the detail
// card so the two representations can never drift apart.
function dotState(a) { return a.available ? "ok" : (a.authenticated ? "warn" : "err"); }
function priorityOf(a) { return a.priority == null ? 100 : a.priority; }
function weightOf(a) { return a.weight == null ? 1 : a.weight; }
// Utilization fraction [0,1] -> clamped percent [0,100]; 0 when unknown.
function pct(w) { return w && w.utilization != null ? Math.min(100, Math.max(0, w.utilization * 100)) : 0; }
// Duration of a window from its key ("5h", "7d", "7d-fable" -> ms); null if
// the key carries no recognisable duration token.
function windowDurationMs(key) {
  const token = String(key).split(/[-_]/).find((t) => /^\\d/.test(t));
  const m = token && /^(\\d+)(mo|min|hrs|hr|days|day|wk|[hdwm])$/i.exec(token);
  if (!m) return null;
  const n = parseInt(m[1], 10), MIN = 60000, H = 60 * MIN, D = 24 * H;
  switch (m[2].toLowerCase()) {
    case "min": case "m": return n * MIN;
    case "h": case "hr": case "hrs": return n * H;
    case "d": case "day": case "days": return n * D;
    case "w": case "wk": return n * 7 * D;
    case "mo": return n * 30 * D;
    default: return null;
  }
}
// A window whose reset time has passed has definitely rolled over on the sub's
// side, so the last counters we saw are stale. Assume the reset rather than
// freezing an old number: show it fresh (0% used) with the reset projected to
// the next boundary. The next request/poll reconciles with real numbers if the
// sub reports different ones. Applies uniformly to 5h, 7d, and model windows.
function rollOver(w) {
  if (!w || w.reset == null || w.reset > Date.now()) return w;
  const dur = windowDurationMs(w.key);
  let reset = null;
  if (dur && dur > 0) {
    const k = Math.floor((Date.now() - w.reset) / dur) + 1; // first boundary in the future
    reset = w.reset + k * dur;
  }
  return { ...w, utilization: 0, reset };
}
function routingPanelHtml(routing) {
  if (!routing || !routing.nextPick) return "";
  const r = routing.nextPick.reason || { summary: "", factors: [] };
  const items = (r.factors || []).map((f) =>
    '<li class="fact' + (f.decisive ? " decisive" : "") + '">'
      + '<span class="fk">' + esc(f.label) + "</span>"
      + '<span class="fv">' + esc(f.detail) + (f.decisive ? " ◀" : "") + "</span></li>"
  ).join("");
  return '<div class="pick">Next request &rarr; <b>' + esc(routing.nextPick.account) + "</b>"
    + '<div class="summary muted" title="' + esc(r.summary) + '">' + esc(r.summary) + "</div></div>"
    + '<ul class="why">' + items + "</ul>";
}

// Cross-subscription model mapping: each Claude family (fable/opus/sonnet/haiku)
// can be routed to a Codex/OpenAI-provider target model, with a per-source-tier
// reasoning-effort override translated into the target's own effort values.
// Injected from models.ts so the client offer set can't drift from the server's
// canonical tiers/efforts (same pattern as TUNING_FIELDS below).
var SOURCE_TIERS = ${JSON.stringify(SOURCE_EFFORT_TIERS)};
var CODEX_EFFORTS = ${JSON.stringify(CODEX_EFFORTS)};
var EFFORT_LABELS = { low: "Low (Light)", xhigh: "Extra High", none: "None" };

// Read each tier's <select> in a container into a { tier: value } object,
// skipping pass-through ("") selections. Shared by the save and target-change
// handlers in wireMapping().
function readEfforts(container) {
  var out = {};
  container.querySelectorAll("[data-effort-tier]").forEach(function (s) {
    if (s.value) out[s.getAttribute("data-effort-tier")] = s.value;
  });
  return out;
}
// Injected from MODEL_FAMILIES so the card renders (and round-trips) every
// family the router recognizes — a hardcoded list silently drops mappings for
// families it omits when Save posts the full set.
var FAMILIES = ${JSON.stringify(MODEL_FAMILIES)};

function effortOptions(family, tier, selected, targetModel) {
  var opts = '<option value="">pass-through</option>';
  for (var i = 0; i < CODEX_EFFORTS.length; i++) {
    var e = CODEX_EFFORTS[i];
    // Only gpt-5.6* exposes max; earlier targets (gpt-5.5, gpt-5.4*) 400 on it,
    // so the server clamps max->xhigh — mirror that here instead of offering it.
    if (e === "max" && targetModel.indexOf("gpt-5.6") !== 0) continue;
    opts += '<option value="' + e + '"' + (selected === e ? " selected" : "") + ">"
      + esc(EFFORT_LABELS[e] || e.charAt(0).toUpperCase() + e.slice(1)) + "</option>";
  }
  return '<select data-effort-family="' + family + '" data-effort-tier="' + tier + '">' + opts + "</select>";
}

// Inner HTML of a family row's .efforts container (one labelled select per
// source tier). Shared by the initial render and the target-change handler so
// switching targets re-filters the offered efforts (e.g. drops max off 5.4/5.5).
function effortsHtml(family, effort, targetModel) {
  var out = "";
  for (var s = 0; s < SOURCE_TIERS.length; s++) {
    var tier = SOURCE_TIERS[s];
    out += '<span class="tier"><label>' + tier + "</label>"
      + effortOptions(family, tier, (effort || {})[tier] || "", targetModel) + "</span>";
  }
  return out;
}

function mappingCardHtml(mapping) {
  if (!mapping) return "";
  var rows = "";
  for (var i = 0; i < FAMILIES.length; i++) {
    var fam = FAMILIES[i];
    var row = (mapping.mappings || []).find(function (m) { return m.from === fam; }) || { from: fam, to: fam };
    var inert = row.to === fam || (mapping.targets || []).indexOf(row.to) < 0;
    var targetOpts = '<option value="' + fam + '"' + (inert ? " selected" : "") + ">Claude only</option>";
    for (var t = 0; t < (mapping.targets || []).length; t++) {
      var id = mapping.targets[t];
      targetOpts += '<option value="' + esc(id) + '"' + (row.to === id ? " selected" : "") + ">" + esc(id) + "</option>";
    }
    rows += '<div class="map-row" data-map-row="' + fam + '">'
      + "<b>" + fam + "</b> &rarr; "
      + '<select data-map-family="' + fam + '">' + targetOpts + "</select>"
      + '<div class="efforts"' + (inert ? ' style="display:none"' : "") + ">" + effortsHtml(fam, row.effort, row.to) + "</div>"
      + "</div>";
  }
  return '<summary>Model mapping<span class="caret">▶</span></summary>'
    + '<div class="mapping-body">'
    + '<div class="hint">Claude families served by Codex when pooled.</div>'
    + '<label><input type="checkbox" id="mapping-enabled"' + (mapping.enabled ? " checked" : "") + "> Pool Claude + Codex capacity</label>"
    + rows
    + '<button id="mapping-save">Save mapping</button>'
    + '<span class="status" id="mapping-status"></span>'
    + "</div>";
}

// Editable weighted-score knobs (key/label/step/min/max), built server-side
// from TUNING_BOUNDS so the input ranges match the server's validation. The
// score is weight × urgency × loadFactor × 5h^fiveHourExp; urgency ranks by
// soonest 7d reset, so sooner-to-expire accounts are drained first.
var TUNING_FIELDS = ${JSON.stringify(tuningFields)};

function tuningPanelHtml(tuning) {
  if (!tuning) return "";
  var fields = TUNING_FIELDS.map(function (f) {
    var v = tuning[f.key];
    var val = typeof v === "number" ? v : "";
    return '<div class="tuning-field"><label><span class="k">' + esc(f.label) + "</span></label>"
      + '<input type="number" step="' + f.step + '" min="' + f.min + '" max="' + f.max + '"'
      + ' value="' + esc(String(val)) + '" data-tuning="' + f.key + '"></div>';
  }).join("");
  return '<summary>Routing tuning<span class="caret">▶</span></summary>'
    + '<div class="tuning-body">'
    + '<div class="hint">Weighted-strategy score knobs. Accounts are drained in 7d-expiry order (soonest first); 5h headroom and session load spill new sessions to the next account.</div>'
    + '<div class="tuning-grid">' + fields + "</div>"
    + '<div class="tuning-actions"><button id="tuning-apply">Apply</button>'
    + '<span class="status" id="tuning-status"></span></div>'
    + "</div>";
}

function tierLabel(priority) {
  if (priority === 1) return "Priority 1 — Primary";
  if (priority === 2) return "Priority 2 — Fallback";
  return "Priority " + priority;
}

// "5h" -> "5h window"; "7d-fable" (model "fable") -> "Fable · 7d window".
function windowLabel(w) {
  const dur = w.key.split(/[-_]/).filter((t) => /^\\d/.test(t)).join(" ") || w.key;
  const scope = w.model ? w.model.charAt(0).toUpperCase() + w.model.slice(1) + " · " : "";
  return scope + dur + " window";
}

function windowBar(w0) {
  const w = rollOver(w0);
  const p = pct(w);
  // After rollover a projected reset is always in the future; only a window
  // with an unknown duration can still land here reset-less.
  const resetText = w.reset == null ? "rolled over" : "resets " + timeUntil(w.reset);
  return '<div><div class="bar-label"><span>' + esc(windowLabel(w)) + ' · used</span><span class="num">'
    + p.toFixed(0) + "% · " + resetText
    + '</span></div><div class="bar"><span style="width:' + p + '%"></span></div></div>';
}

// Compact glance row: status dot, name (+next tag), plan, account-wide 5h/7d
// mini-bars, priority, recency. Model-scoped windows stay on the detail card.
function summaryRowHtml(a, isNext) {
  const dot = dotState(a);
  const rl = a.usage.rateLimitStatus;
  const wins = (rl && Array.isArray(rl.windows) ? rl.windows : [])
    .filter((w) => w.utilization != null && !w.model);
  const winCell = (key) => {
    const w = rollOver(wins.find((x) => x.key === key));
    const p = pct(w);
    const label = w ? p.toFixed(0) + "%" : "–";
    return '<td><div class="mini"><div class="bar"><span style="width:' + p
      + '%"></span></div><span class="pct">' + label + "</span></div></td>";
  };
  const pr = priorityOf(a);
  return '<tr class="acct" data-scroll="' + esc(a.name) + '" role="button" tabindex="0">'
    + '<td class="c-dot"><span class="dot ' + dot + '"></span></td>'
    + '<td><span class="acct-name">' + esc(a.name) + "</span>"
    + (isNext ? ' <span class="badge next">next</span>' : "")
    + '<div class="prov">' + esc(a.provider || "anthropic") + "</div></td>"
    + '<td><span class="chip plan">' + esc(a.subscriptionType || "unknown") + "</span></td>"
    + winCell("5h") + winCell("7d")
    + '<td class="num">' + pr + "</td>"
    + '<td class="muted">' + ago(a.usage.lastUsedAt) + "</td></tr>";
}

function summaryTableHtml(accounts, nextAcct) {
  if (!accounts.length) return "";
  const rows = accounts.map((a) => summaryRowHtml(a, a.name === nextAcct)).join("");
  return "<table><thead><tr><th></th><th>Account</th><th>Plan</th><th>5h window</th>"
    + "<th>7d window</th><th>Priority</th><th>Last used</th></tr></thead><tbody>"
    + rows + "</tbody></table>";
}

function card(a, isNext) {
  const dot = dotState(a);
  const state = a.available ? "Ready" : (a.authenticated ? "Sidelined" : "Logged out");
  const u = a.usage;
  const pr = priorityOf(a);
  const w = weightOf(a);
  const rl = u.rateLimitStatus;
  const tok = u.windowInputTokens + u.windowOutputTokens;

  // Anthropic's unified rolling windows (subscription traffic): the account-wide
  // 5h and 7d windows plus any model-scoped ones (e.g. Fable's separate, lower
  // allowance), each with a utilization fraction in [0,1]. Show every window we
  // have; fall back to our local "(est.)" tally per account-wide slot that's
  // still missing (e.g. a freshly-added account with 5h data but no 7d yet).
  const wins = (rl && Array.isArray(rl.windows) ? rl.windows : []).filter((w) => w.utilization != null);
  const have5h = wins.some((w) => w.key === "5h");
  const have7d = wins.some((w) => w.key === "7d");
  const barsHtml = wins.map(windowBar).join("")
    + (have5h ? "" : '<div><div class="bar-label"><span>Requests (est.)</span><span class="num">' + fmtInt(u.windowRequests) + ' req</span></div><div class="bar"><span style="width:' + Math.min(100, (u.windowRequests / 200) * 100) + '%"></span></div></div>')
    + (have7d ? "" : '<div><div class="bar-label"><span>Tokens (est.)</span><span class="num">' + fmtInt(tok) + '</span></div><div class="bar"><span style="width:' + Math.min(100, tok / 1000000 * 100) + '%"></span></div></div>');

  const limitStatusRow = rl && rl.unifiedStatus
    ? '<span class="k">Usage status</span><span class="v">' + esc(rl.unifiedStatus) + "</span>" : "";
  const errNote = a.unavailableReason
    ? '<div class="note ' + (a.authenticated ? "" : "err") + '">' + esc(a.unavailableReason) + "</div>"
    : (u.lastError ? '<div class="note">Last error: ' + esc(u.lastError) + "</div>" : "");
  const usageErrNote = u.lastUsageCheckError ? '<div class="note">Usage check: ' + esc(u.lastUsageCheckError) + "</div>" : "";
  const cooldownRow = (u.rateLimitedUntil && u.rateLimitedUntil > Date.now())
    ? '<span class="k">Cooldown</span><span class="v">' + timeUntil(u.rateLimitedUntil) + "</span>" : "";
  const usageCheckRow = u.lastUsageCheckAt
    ? '<span class="k">Usage checked</span><span class="v">' + ago(u.lastUsageCheckAt) + "</span>" : "";
  return \`<div class="card \${a.available ? "" : "down"}\${isNext ? " next" : ""}" id="card-\${esc(a.name)}">
    <div class="card-top">
      <span class="status"><span class="dot \${dot}"></span><span class="acct-name">\${esc(a.name)}</span></span>
      <span class="badge">\${esc(a.provider || "anthropic")}</span>
      \${isNext ? '<span class="badge next">next</span>' : ""}
      <span class="chip plan">\${esc(a.subscriptionType || "unknown")}</span>
    </div>
    <div class="dl">
      <span class="k">Status</span><span class="v">\${state}</span>
      <span class="k">Rate tier</span><span class="v">\${esc(a.rateLimitTier || "–")}</span>
      <span class="k">Priority</span><span class="v">\${pr}</span>
      <span class="k">Token</span><span class="v">\${a.tokenExpired ? "auto-refreshing" : "valid · " + timeUntil(a.tokenExpiresAt)}</span>
      <span class="k">Cost (window)</span><span class="v">\${fmtUsd(u.windowCostUsd)}</span>
      <span class="k">Requests</span><span class="v">\${fmtInt(u.totalRequests)} · \${ago(u.lastUsedAt)}</span>
      <span class="k">Sessions</span><span class="v">\${fmtInt(a.activeSessions ?? 0)} active</span>
      \${limitStatusRow}
      \${cooldownRow}
      \${usageCheckRow}
    </div>
    <div class="bars">\${barsHtml}</div>
    \${errNote}\${usageErrNote}
    <div class="tier-edit">Priority
      <input type="number" min="0" value="\${pr}" data-acct="\${esc(a.name)}" />
      <button data-set-priority="\${esc(a.name)}">Set</button>
      &nbsp;Weight
      <input type="number" min="0.1" max="10" step="0.1" value="\${w}" data-weight-acct="\${esc(a.name)}" />
      <button data-set-weight="\${esc(a.name)}">Set</button>
    </div>
  </div>\`;
}

// Fill the real origin into the walkthrough's curl example, wire copy buttons.
document.querySelectorAll(".cmd code").forEach((el) => {
  el.textContent = el.textContent.replace("http://localhost:PORT_PLACEHOLDER", location.origin);
});
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const code = btn.parentElement.querySelector("code").textContent;
    navigator.clipboard?.writeText(code).then(() => {
      const prev = btn.textContent; btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = prev), 1200);
    });
  });
});

// Render one settings panel from its data, returning whether it has content (so
// the caller can show/hide the enclosing Settings group). Leaves the DOM alone —
// never clobbering an edit — while the panel is dirty or focused, and skips a
// no-op re-render when the data is unchanged (avoids 4s flicker and re-wiring).
function renderSettings(id, html, data, wire) {
  const panel = document.getElementById(id);
  if (!html) { panel.style.display = "none"; settingsRendered[id] = null; return false; }
  if (!settingsDirty[id] && !panel.contains(document.activeElement)) {
    const key = JSON.stringify(data);
    if (key !== settingsRendered[id]) {
      panel.style.display = "block";
      panel.innerHTML = html;
      settingsRendered[id] = key;
      settingsDirty[id] = false;
      wire();
    }
  }
  return true;
}

// A settings form becomes clean only after its POST succeeds. On rejection keep
// its draft intact so the user can correct it instead of the poll restoring the
// last server value over the form.
function finishSettingsSave(id, res, status) {
  if (!res.ok) {
    if (status) status.textContent = "rejected";
    return false;
  }
  if (status) status.textContent = "saved";
  settingsDirty[id] = false;
  settingsRendered[id] = null;
  return true;
}

async function refresh() {
  try {
    const r = await fetch("/api/status");
    const d = await r.json();
    const grid = document.getElementById("grid");
    const onboard = document.getElementById("onboard");
    const banner = document.getElementById("banner");
    const accounts = d.accounts || [];
    const avail = accounts.filter((a) => a.available).length;
    let accountCardsRendered = false;

    if (accounts.length === 0) {
      grid.innerHTML = "";
      onboard.style.display = "block";
      banner.style.display = "none";
      document.getElementById("summary").style.display = "none";
    } else {
      onboard.style.display = "none";
      const routing = d.routing || { tiers: [], nextPick: null, activeTier: null };
      const nextAcct = routing.nextPick && routing.nextPick.account;
      const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
      const tieredNames = new Set((routing.tiers || []).flatMap((t) => t.accounts));
      const untiered = accounts.filter((a) => !tieredNames.has(a.name));
      const groups = routing.tiers && routing.tiers.length
        ? routing.tiers.concat(
            untiered.length
              ? [{ priority: null, accounts: untiered.map((a) => a.name), available: untiered.filter((a) => a.available).length }]
              : [],
          )
        : [{ priority: null, accounts: accounts.map((a) => a.name), available: avail }];
      if (!accountSettingsDirty && !grid.contains(document.activeElement)) {
        grid.innerHTML = groups.map((t) => {
          const cardsHtml = t.accounts
            .map((n) => byName[n])
            .filter(Boolean)
            .map((a) => card(a, a.name === nextAcct))
            .join("");
          const head = t.priority == null
            ? ""
            : '<div class="tier-head' + (t.available === 0 ? " dim" : "") + '">' + esc(tierLabel(t.priority))
              + ' <span class="tier-meta">' + t.available + " available"
              + (t.priority === routing.activeTier ? " · active" : "") + "</span></div>";
          return '<section class="tier">' + head + '<div class="tier-grid">' + cardsHtml + "</div></section>";
        }).join("");
        accountCardsRendered = true;
      }

      const summary = document.getElementById("summary");
      const ordered = groups.flatMap((t) => t.accounts).map((n) => byName[n]).filter(Boolean);
      summary.innerHTML = summaryTableHtml(ordered, nextAcct);
      summary.style.display = ordered.length ? "block" : "none";

      const panel = document.getElementById("routing-panel");
      const panelHtml = routingPanelHtml(routing);
      if (panelHtml) {
        panel.innerHTML = panelHtml;
        panel.style.display = "flex";
      } else {
        panel.style.display = "none";
      }

      // Settings forms are user-editable; renderSettings only rewrites them when
      // safe (not mid-edit, and the data actually changed), so a poll tick can
      // never clobber in-progress edits. Show the Settings group iff either
      // config panel has content.
      const mapVisible = renderSettings("mapping-panel", mappingCardHtml(d.mapping), d.mapping, wireMapping);
      const tuneVisible = renderSettings("tuning-panel", tuningPanelHtml(d.tuning), d.tuning, wireTuning);
      document.getElementById("settings-group").style.display = (mapVisible || tuneVisible) ? "block" : "none";

      if (avail === 0) {
        const anyAuthed = accounts.some((a) => a.authenticated);
        banner.innerHTML = anyAuthed
          ? "<b>No accounts are available right now.</b> Every account is rate-limited or its token needs attention &mdash; requests will 503 until one frees up. See the cards below."
          : "<b>No accounts are logged in.</b> Authenticate one to start serving requests: <code>bun run src/index.ts accounts login &lt;name&gt;</code>";
        banner.style.display = "block";
      } else {
        banner.style.display = "none";
      }
    }

    document.getElementById("p-accounts").innerHTML = "accounts <b>" + accounts.length + "</b>";
    document.getElementById("p-available").innerHTML = "available <b>" + avail + "</b>";
    document.getElementById("p-window").innerHTML = "window <b>" + Math.round((d.usageWindowMs || 0) / 3600000) + "h</b>";
    document.getElementById("p-updated").textContent = "updated " + new Date().toLocaleTimeString();

    if (accountCardsRendered) {
      document.querySelectorAll("[data-set-priority]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const name = btn.getAttribute("data-set-priority");
          const input = document.querySelector('input[data-acct="' + (window.CSS ? CSS.escape(name) : name) + '"]');
          const priority = parseInt(input.value, 10);
          if (!Number.isInteger(priority) || priority < 0) return;
          try {
            const res = await fetch("/api/routing", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ account: name, priority }),
            });
            if (res.ok) { accountSettingsDirty = false; refresh(); }
          } catch (e) { /* transient; retain the draft until the user retries */ }
        });
      });

      document.querySelectorAll("[data-set-weight]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const name = btn.getAttribute("data-set-weight");
          const input = document.querySelector('input[data-weight-acct="' + (window.CSS ? CSS.escape(name) : name) + '"]');
          const weight = parseFloat(input.value);
          if (!Number.isFinite(weight) || weight < 0.1 || weight > 10) return;
          try {
            const res = await fetch("/api/routing", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ account: name, weight }),
            });
            if (res.ok) { accountSettingsDirty = false; refresh(); }
          } catch (e) { /* transient; retain the draft until the user retries */ }
        });
      });
    }

    document.querySelectorAll("[data-scroll]").forEach((row) => {
      const scrollToCard = () => {
        const el = document.getElementById("card-" + row.getAttribute("data-scroll"));
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth; // restart animation on repeat clicks
        el.classList.add("flash");
      };
      row.addEventListener("click", scrollToCard);
      // Keyboard parity for the role="button" row (Enter / Space activate).
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollToCard(); }
      });
    });
  } catch (e) {
    document.getElementById("p-updated").textContent = "offline";
  }
}

// Attach the Save handler for the mapping panel. Reads each family's target
// select plus its per-tier effort selects, POSTs the full replacement set to
// /api/mappings, then refreshes so the server's normalized state comes back.
function wireMapping() {
  const saveBtn = document.getElementById("mapping-save");
  if (!saveBtn) return;

  // Changing a family's target re-renders its effort selects so the offered
  // options and visibility stay honest (hide efforts for "Claude only", and
  // drop the max option on targets that don't support it) without waiting for a
  // full poll re-render (which is skipped while the panel has focus).
  document.querySelectorAll("[data-map-family]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const rowEl = sel.closest("[data-map-row]");
      const fam = rowEl.getAttribute("data-map-row");
      const to = sel.value;
      const effortsDiv = rowEl.querySelector(".efforts");
      effortsDiv.innerHTML = effortsHtml(fam, readEfforts(effortsDiv), to);
      effortsDiv.style.display = to === fam ? "none" : "";
    });
  });

  saveBtn.addEventListener("click", async () => {
    const mappings = [];
    document.querySelectorAll("[data-map-row]").forEach((rowEl) => {
      const fam = rowEl.getAttribute("data-map-row");
      const to = rowEl.querySelector("[data-map-family]").value;
      const effort = readEfforts(rowEl);
      const entry = { from: fam, to };
      if (Object.keys(effort).length) entry.effort = effort;
      mappings.push(entry);
    });
    try {
      const res = await fetch("/api/mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: document.getElementById("mapping-enabled").checked, mappings }),
      });
      if (finishSettingsSave("mapping-panel", res, document.getElementById("mapping-status"))) refresh();
    } catch (e) { /* transient; next poll will reconcile */ }
  });
}

// Attach the Apply handler for the routing-tuning panel. Reads every changed
// knob, POSTs the batch to /api/tuning, and reports the outcome inline.
function wireTuning() {
  const apply = document.getElementById("tuning-apply");
  if (!apply) return;
  apply.addEventListener("click", async () => {
    const status = document.getElementById("tuning-status");
    const patch = {};
    let bad = false;
    document.querySelectorAll("[data-tuning]").forEach((input) => {
      const v = parseFloat(input.value);
      const min = parseFloat(input.getAttribute("min"));
      const max = parseFloat(input.getAttribute("max"));
      if (!Number.isFinite(v) || v < min || v > max) { bad = true; return; }
      patch[input.getAttribute("data-tuning")] = v;
    });
    if (bad) { if (status) status.textContent = "out of range"; return; }
    if (status) status.textContent = "saving…";
    try {
      const res = await fetch("/api/tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (finishSettingsSave("tuning-panel", res, status)) refresh();
    } catch (e) {
      if (status) status.textContent = "offline";
    }
  });
}
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
}
