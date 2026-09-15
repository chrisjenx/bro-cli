export const DASHBOARD_STYLES = String.raw`
:root {
  color-scheme:light;
  --bg:#f5f6f8;
  --surface:#fff;
  --surface2:#f0f2f6;
  --line:#dce0e8;
  --text:#202633;
  --muted:#596274;
  --accent:#315fbe;
  --accent-soft:#eaf0ff;
  --meter:#2a78d6;
  --track:#e2e7ef;
  --good:#237448;
  --warn:#8b5916;
  --bad:#ae3834;
  --notice:#fff7e9;
  --shadow:0 4px 20px #16213a08;
}
@media(prefers-color-scheme:dark) {
  :root:not([data-theme="light"]) {
    color-scheme:dark;
    --bg:#15191f;
    --surface:#1b2028;
    --surface2:#222933;
    --line:#343e4c;
    --text:#edf0f5;
    --muted:#adb6c5;
    --accent:#afc0ff;
    --accent-soft:#27334e;
    --meter:#3987e5;
    --track:#354153;
    --good:#91d6ae;
    --warn:#e9be83;
    --bad:#f0aaa5;
    --notice:#2d271f;
    --shadow:none;
  }
}
:root[data-theme="dark"] {
  color-scheme:dark;
  --bg:#15191f;
  --surface:#1b2028;
  --surface2:#222933;
  --line:#343e4c;
  --text:#edf0f5;
  --muted:#adb6c5;
  --accent:#afc0ff;
  --accent-soft:#27334e;
  --meter:#3987e5;
  --track:#354153;
  --good:#91d6ae;
  --warn:#e9be83;
  --bad:#f0aaa5;
  --notice:#2d271f;
  --shadow:none;
}
* {
  box-sizing:border-box;
}
body {
  margin:0;
  background:var(--bg);
  color:var(--text);
  font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
button,input,select {
  font:inherit;
}
button,select {
  cursor:pointer;
}
button,input,select {
  border:1px solid var(--line);
  border-radius:6px;
  background:var(--surface);
  color:var(--text);
  padding:7px 11px;
}
button:hover {
  background:var(--surface2);
}
button:disabled {
  opacity:.5;
  cursor:default;
}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:3px;
}
button.primary {
  background:var(--accent);
  border-color:var(--accent);
  color:var(--surface);
  font-weight:600;
}
a {
  color:var(--accent);
}
[hidden] {
  display:none!important;
}
h1,h2,h3,p {
  margin:0;
}
h1 {
  font-size:28px;
  letter-spacing:-.045em;
  font-weight:650;
}
h2 {
  font-size:17px;
  letter-spacing:-.025em;
}
h3 {
  font-size:14px;
  font-weight:600;
}
small,.small {
  font-size:12px;
}
.muted,.subtitle,.table-note {
  color:var(--muted);
}
.subtitle {
  margin-top:5px;
}
.eyebrow {
  font-size:10px;
  letter-spacing:.12em;
  color:var(--muted);
  margin-bottom:5px;
}
.sr-only {
  position:absolute;
  width:1px;
  height:1px;
  overflow:hidden;
  clip:rect(0,0,0,0);
  white-space:nowrap;
}
.app-header {
  display:flex;
  align-items:center;
  gap:42px;
  padding:0 32px;
  min-height:72px;
  border-bottom:1px solid var(--line);
  background:var(--surface);
  position:sticky;
  top:0;
  z-index:5;
}
.brand {
  text-decoration:none;
  color:var(--text);
  font-size:22px;
  font-weight:750;
  letter-spacing:-.055em;
  white-space:nowrap;
}
.brand span {
  font-weight:400;
  color:var(--muted);
}
nav {
  display:flex;
  align-self:stretch;
  gap:26px;
}
nav button {
  border:0;
  border-radius:0;
  background:none;
  border-bottom:2px solid transparent;
  padding:0 2px;
  color:var(--muted);
}
nav button[aria-current="page"] {
  color:var(--text);
  border-bottom-color:var(--accent);
}
.header-actions {
  margin-left:auto;
  display:flex;
  gap:9px;
  align-items:center;
}
#connection-feedback {
  font-size:11px;
  color:var(--muted);
  margin-right:5px;
}
.icon-button {
  width:34px;
  height:34px;
  padding:0;
  display:inline-grid;
  place-items:center;
  font-size:18px;
}
main {
  max-width:1500px;
  margin:0 auto;
  padding:30px 32px 16px;
}
.page-heading {
  display:flex;
  align-items:end;
  justify-content:space-between;
  gap:20px;
  margin:0 0 24px;
}
.scope-label {
  color:var(--muted);
  font-size:12px;
}
.metrics {
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:16px;
  margin-bottom:20px;
}
.metric {
  background:var(--surface);
  border:1px solid var(--line);
  border-radius:9px;
  padding:17px 20px;
  box-shadow:var(--shadow);
}
.metric>span,.metric small {
  color:var(--muted);
  font-size:12px;
}
.metric strong {
  display:block;
  font-size:32px;
  letter-spacing:-.04em;
  font-weight:600;
  margin:5px 0;
  font-variant-numeric:tabular-nums;
}
.notice {
  padding:12px 15px;
  background:var(--notice);
  border:1px solid var(--line);
  border-radius:7px;
  margin:0 0 20px;
  color:var(--text);
  font-size:12px;
  overflow-wrap:anywhere;
}
.notice.error {
  border-left:3px solid var(--bad);
}
[data-attention] {
  display:flex;
  align-items:center;
  gap:16px;
  justify-content:space-between;
}
.notice-actions {
  display:flex;
  gap:8px;
}
.notice button {
  background:transparent;
  padding:4px 8px;
  font-size:12px;
}
.toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  margin:24px 0 12px;
}
.toolbar h2 .muted {
  font-weight:400;
  font-size:14px;
}
.filters {
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}
.filters input,.filters select {
  font-size:12px;
}
.search input {
  width:210px;
}
.table-region {
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:9px;
  background:var(--surface);
  box-shadow:var(--shadow);
}
table {
  width:100%;
  border-collapse:collapse;
  text-align:left;
  font-size:12px;
}
th {
  font-size:11px;
  color:var(--muted);
  font-weight:500;
  padding:11px 15px;
  background:var(--surface2);
  white-space:nowrap;
  border-bottom:1px solid var(--line);
}
th button {
  border:0;
  padding:0;
  border-radius:0;
  color:inherit;
  background:none;
  white-space:nowrap;
}
th[aria-sort]:not([aria-sort="none"]) {
  color:var(--text);
}
td {
  padding:12px 15px;
  border-bottom:1px solid var(--line);
  vertical-align:middle;
  font-variant-numeric:tabular-nums;
}
tr:last-child td {
  border-bottom:0;
}
tbody tr:hover {
  background:var(--surface2);
}
.overview-table td:first-child {
  width:32%;
  min-width:200px;
}
.account-name {
  border:0;
  background:none;
  padding:0;
  text-align:left;
  font-weight:550;
  overflow-wrap:anywhere;
  max-width:100%;
  color:var(--text);
}
.account-meta {
  display:block;
  color:var(--muted);
  font-size:10px;
  margin-top:3px;
}
.status-label {
  white-space:nowrap;
  display:inline-flex;
  align-items:center;
  gap:6px;
}
.status-icon {
  color:var(--good);
}
.status-label[data-status="cooldown"] .status-icon,.status-label[data-status="sidelined"] .status-icon {
  color:var(--warn);
}
.status-label[data-status="logged-out"] .status-icon {
  color:var(--bad);
}
.quota {
  min-width:100px;
  position:relative;
  display:flex;
  gap:8px;
  align-items:center;
  min-height:28px;
}
.quota-track {
  height:4px;
  width:58px;
  flex-shrink:0;
  border-radius:4px;
  background:var(--track);
  overflow:hidden;
}
.quota-fill {
  display:block;
  height:100%;
  border-radius:4px;
  background:var(--meter);
  transition:width .2s;
}
.quota-value {
  white-space:nowrap;
}
.quota {
  flex-wrap:wrap;
}
.quota [data-assumed] {
  flex-basis:100%;
  font-size:10px;
  color:var(--muted);
}
.detail-window [data-assumed] {
  display:none;
}
.quota .unknown {
  color:var(--muted);
  font-size:11px;
}
.quota-tooltip {
  position:fixed;
  z-index:50;
  pointer-events:none;
  background:var(--text);
  color:var(--surface);
  border-radius:6px;
  padding:9px 12px;
  font-size:12px;
  max-width:280px;
  box-shadow:0 5px 25px #0003;
}
.quota-note {
  font-size:10px;
  color:var(--muted);
  display:block;
}
.table-note {
  font-size:11px;
  margin-top:12px;
}
.empty {
  text-align:center;
  padding:30px;
  color:var(--muted);
}
.empty button {
  margin-left:10px;
}
.context-select {
  display:flex;
  align-items:center;
  gap:10px;
  font-size:12px;
  color:var(--muted);
}
.routing-pick {
  background:var(--surface);
  border:1px solid var(--line);
  border-left:3px solid var(--accent);
  border-radius:8px;
  padding:20px;
  margin-bottom:20px;
}
.routing-pick h2 {
  margin:5px 0 8px;
  font-size:22px;
  overflow-wrap:anywhere;
}
.routing-pick .winner-meta {
  display:flex;
  gap:18px;
  flex-wrap:wrap;
  color:var(--muted);
  font-size:12px;
}
.routing-reasons {
  margin-top:14px;
}
.routing-reasons li {
  margin:9px 0;
}
.routing-reasons b {
  display:block;
}
.decisive {
  font-size:10px;
  border:1px solid var(--line);
  border-radius:3px;
  margin-left:8px;
  padding:2px 5px;
  color:var(--text);
}
.routing-table {
  min-width:850px;
}
.routing-table td {
  white-space:nowrap;
}
.routing-table td:first-child {
  white-space:normal;
  min-width:220px;
}
.next-tag {
  font-size:10px;
  margin-left:7px;
  border:1px solid var(--line);
  border-radius:4px;
  padding:2px 4px;
  color:var(--text);
}
.section-title {
  margin:28px 0 12px;
}
.settings-panel {
  border:1px solid var(--line);
  background:var(--surface);
  border-radius:9px;
  padding:24px;
  margin-bottom:22px;
  max-width:1100px;
}
.panel-heading {
  margin-bottom:20px;
}
.panel-heading p {
  font-size:12px;
  margin-top:5px;
}
fieldset {
  border:0;
  margin:0;
  padding:0;
  min-width:0;
}
.toggle-label {
  display:flex;
  align-items:center;
  gap:9px;
  font-size:13px;
  margin-bottom:18px;
}
input[type="checkbox"] {
  accent-color:var(--accent);
}
.mapping-row {
  border-top:1px solid var(--line);
  padding:16px 0;
}
.mapping-target {
  display:flex;
  align-items:center;
  gap:14px;
}
.mapping-target strong {
  width:70px;
  text-transform:capitalize;
}
.mapping-target select {
  max-width:100%;
  min-width:200px;
}
.effort-grid {
  display:flex;
  flex-wrap:wrap;
  gap:10px;
  margin:12px 0 0 84px;
}
.effort-grid label {
  font-size:10px;
  color:var(--muted);
  display:flex;
  flex-direction:column;
  gap:4px;
}
.effort-grid select {
  font-size:12px;
  max-width:160px;
}
.tuning-grid {
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:20px;
}
.tuning-grid label,.account-fields label {
  display:flex;
  flex-direction:column;
  gap:7px;
  font-size:12px;
  color:var(--muted);
}
.tuning-grid input,.account-fields input {
  width:100%;
}
.tuning-grid small {
  font-size:11px;
}
.form-actions {
  display:flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
  margin-top:18px;
}
.form-actions [role="status"] {
  font-size:12px;
  color:var(--muted);
  overflow-wrap:anywhere;
}
.help {
  margin-top:18px;
  color:var(--muted);
  font-size:12px;
}
.help p {
  margin-top:10px;
}
summary {
  cursor:pointer;
  font-weight:550;
}
.onboard {
  max-width:760px;
  margin:30px auto;
  background:var(--surface);
  padding:28px;
  border:1px solid var(--line);
  border-radius:9px;
}
.onboard>p,.onboard li p {
  color:var(--muted);
  font-size:12px;
  margin-top:8px;
}
.onboard ol {
  padding-left:20px;
}
.onboard li {
  margin:20px 0;
}
.command {
  display:flex;
  gap:10px;
  align-items:center;
  margin-top:10px;
  background:var(--surface2);
  padding:10px;
  border-radius:6px;
}
.command code {
  flex:1;
  overflow-wrap:anywhere;
}
.command button {
  font-size:11px;
}
code {
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px;
}
footer {
  max-width:1500px;
  margin:20px auto;
  padding:20px 32px;
  border-top:1px solid var(--line);
  display:flex;
  justify-content:space-between;
  gap:18px;
  flex-wrap:wrap;
  color:var(--muted);
  font-size:11px;
}
footer div {
  display:flex;
  gap:12px;
  flex-wrap:wrap;
}
footer code {
  font-size:10px;
}
dialog {
  background:var(--surface);
  color:var(--text);
  border:1px solid var(--line);
}
dialog::backdrop {
  background:#05080c88;
}
.account-drawer {
  position:fixed;
  inset:0 0 0 auto;
  width:480px;
  max-width:100vw;
  height:100dvh;
  max-height:100dvh;
  margin:0;
  padding:0;
  overflow-y:auto;
  box-shadow:-12px 0 45px #0003;
}
.drawer-heading {
  padding:24px;
  border-bottom:1px solid var(--line);
}
.drawer-heading h2 {
  overflow-wrap:anywhere;
  font-size:20px;
  margin:8px 35px 7px 0;
}
.close {
  float:right;
}
.drawer-body {
  padding:22px 24px;
}
.drawer-body h3 {
  margin:0 0 13px;
}
.drawer-body details {
  border-top:1px solid var(--line);
  padding:16px 0;
}
.drawer-body details summary {
  font-size:13px;
}
.drawer-body details p {
  margin-top:12px;
}
.drawer-body dl {
  display:grid;
  grid-template-columns:minmax(90px,1fr) minmax(0,1.5fr);
  gap:9px 14px;
  font-size:12px;
  margin:16px 0;
}
.drawer-body dt {
  color:var(--muted);
}
.drawer-body dd {
  margin:0;
  text-align:right;
  overflow-wrap:anywhere;
  font-variant-numeric:tabular-nums;
}
.detail-window {
  padding:10px 0 14px;
}
.window-heading {
  display:flex;
  justify-content:space-between;
  gap:15px;
  font-size:12px;
  margin-bottom:7px;
}
.detail-window .quota {
  display:block;
  min-height:12px;
}
.detail-window .quota-track {
  display:block;
  width:100%;
  height:5px;
}
.detail-window .quota-value {
  display:none;
}
.detail-window small {
  display:block;
  color:var(--muted);
  font-size:11px;
  margin-top:5px;
}
.drawer-body form {
  border-top:1px solid var(--line);
  padding-top:20px;
  margin-top:6px;
}
.account-fields {
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:16px;
}
[data-account-feedback] {
  font-size:12px;
  margin-top:12px;
  overflow-wrap:anywhere;
}
[data-account-conflict] {
  margin-top:12px;
}
.decision-dialog {
  border-radius:12px;
  max-width:min(520px,calc(100vw - 30px));
  padding:24px;
}
.decision-dialog>p {
  margin-top:12px;
  color:var(--muted);
}
.decision-dialog .notice {
  margin-top:12px;
}
.form-conflict {
  color:var(--warn);
  font-size:12px;
  margin-top:10px;
}
@media(max-width:1000px) {
  .app-header {
    gap:25px;
    padding:0 22px;
  }
  main {
    padding:25px 22px;
  }
  .toolbar {
    align-items:start;
  }
  .filters {
    justify-content:flex-end;
  }
  .metric {
    padding:14px;
  }
  .metric strong {
    font-size:27px;
  }
  .overview-table td:first-child {
    min-width:170px;
  }
}
@media(max-width:800px) {
  .app-header {
    flex-wrap:wrap;
    gap:0 22px;
    padding:12px 16px 0;
  }
  .brand {
    font-size:20px;
  }
  nav {
    order:3;
    width:100%;
    height:45px;
    gap:26px;
  }
  .header-actions {
    margin-left:auto;
  }
  #connection-feedback {
    max-width:130px;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  main {
    padding:22px 16px;
  }
  .page-heading {
    align-items:start;
    flex-direction:column;
    gap:10px;
  }
  h1 {
    font-size:25px;
  }
  .scope-label {
    font-size:11px;
  }
  .metrics {
    grid-template-columns:repeat(2,minmax(0,1fr));
    gap:10px;
  }
  .overview-reset,.overview-sessions,.overview-inflight {
    display:none;
  }
  .toolbar {
    flex-direction:column;
    align-items:stretch;
  }
  .filters {
    justify-content:flex-start;
  }
  .search {
    flex:1;
    min-width:150px;
  }
  .search input {
    width:100%;
  }
  .overview-table td:first-child {
    min-width:140px;
  }
  .overview-table td {
    padding:10px;
  }
  .overview-table th {
    padding:10px;
  }
  .quota {
    min-width:82px;
  }
  .quota-track {
    width:36px;
  }
  [data-attention] {
    align-items:start;
    flex-direction:column;
  }
  .account-drawer {
    width:100vw;
    max-width:none;
  }
  .tuning-grid {
    grid-template-columns:1fr;
  }
  .settings-panel {
    padding:18px;
  }
  .mapping-target {
    align-items:start;
    flex-direction:column;
    gap:6px;
  }
  .mapping-target select {
    width:100%;
    min-width:0;
  }
  .effort-grid {
    margin-left:0;
  }
  .context-select {
    flex-wrap:wrap;
  }
  footer {
    padding:18px 16px;
  }
  .drawer-heading,.drawer-body {
    padding:20px;
  }
  .routing-table td {
    padding:10px;
  }
}
@media(max-width:420px) {
  .metric strong {
    font-size:25px;
  }
  .metric small {
    font-size:10px;
  }
  .metrics {
    grid-template-columns:1fr;
  }
  .notice-actions {
    flex-wrap:wrap;
  }
  .form-actions {
    gap:8px;
  }
}
@media(prefers-reduced-motion:reduce) {
  *,*::before,*::after {
    transition:none!important;
    scroll-behavior:auto!important;
  }
}
@media(forced-colors:active) {
  .quota-track {
    border:1px solid CanvasText;
  }
  .quota-fill {
    background:Highlight;
    forced-color-adjust:none;
  }
  .status-icon {
    color:CanvasText;
  }
  .notice {
    border:1px solid CanvasText;
  }
}
`;
