# Architecture

## The core idea

The Claude Code CLI stores its OAuth credentials in a config directory chosen by the `CLAUDE_CONFIG_DIR` environment variable (default `~/.claude`). Point it at a different directory and it uses a different login. That single fact is what makes multi-account pooling possible: we give every Claude plan its own config directory, read its OAuth token, and route each request with the selected account's bearer token.

```
~/.claude-max-pool/
  accounts/
    work/       .credentials.json   ← CLAUDE_CONFIG_DIR for "work"
    personal/   .credentials.json   ← CLAUDE_CONFIG_DIR for "personal"
    team2/      .credentials.json   ← CLAUDE_CONFIG_DIR for "team2"
  usage.json                        ← persisted rolling usage counters
```

Each `.credentials.json` holds a `claudeAiOauth` block with `accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType` (e.g. `team`, `max`), and `rateLimitTier` (e.g. `default_claude_max_5x`). The direct backend reads that block for status, refreshes expiring access tokens with `refreshToken`, and persists rotated tokens back to the same file.

## Request lifecycle

```
HTTP request
   │
   │ 1. Server (server/server.ts) matches the route and checks PROXY_API_KEY.
   ▼
Route parse
   │ 2. For /v1/messages, keep the request body verbatim and read only
   │    metadata.user_id for stickiness.
   │    For /v1/chat/completions or CLAUDE_POOL_BACKEND=cli, use the legacy
   │    adapters that flatten messages into a single CLI prompt.
   ▼
AccountManager.pick(sessionKey)  (accounts/manager.ts)
   │ 3. Sticky by session if still available, else least-loaded authenticated,
   │    non-rate-limited account. Returns null if none available (→ 503).
   ▼
Direct upstream (upstream/anthropic.ts)
   │ 4. Ensure the account access token is fresh. If needed:
   │      POST https://platform.claude.com/v1/oauth/token
   │      grant_type=refresh_token
   │ 5. POST the original JSON body to:
   │      https://api.anthropic.com/v1/messages
   │    with the caller/harness request headers preserved. The only changes:
   │      Authorization is replaced with Bearer <account accessToken>
   │      hop-by-hop headers and local x-api-key proxy auth are stripped
   ▼
Instrument response
   │ 6. Non-stream: parse upstream JSON usage, then return the upstream body.
   │    Stream: parse SSE only as a tap for initial rate-limit failover and
   │    usage; forward upstream SSE bytes unchanged.
   ▼
Response
   │ 7. Return upstream status/body/stream with X-Pool-Account set.
   ▼
HTTP response  (X-Pool-Account header names the chosen account)
```

The direct backend intentionally does not synthesize Anthropic protocol headers
such as `anthropic-version` or `anthropic-beta`. Those come from the harness
request. Claude Code already sends the OAuth beta header it needs.

## Legacy CLI backend

Set `CLAUDE_POOL_BACKEND=cli` to use the previous `/v1/messages` path. That path calls `runClaude(prompt, { configDir, model, ... })`, spawns the CLI with `--print --output-format stream-json --verbose --include-partial-messages`, parses newline-delimited CLI JSON into normalized `TurnEvent`s, and re-serializes those events through the Anthropic adapter.

The OpenAI compatibility endpoint also still uses the legacy adapter path because it has to translate OpenAI chat messages into Anthropic/Claude text responses.

## Normalized `TurnEvent`

```ts
type TurnEvent =
  | { kind: "text"; text: string }              // assistant text delta
  | { kind: "text_block_boundary" }             // separator between text blocks
  | { kind: "tool_use"; id: string; name: string }
  | { kind: "done"; usage; stopReason; costUsd } // final result line
  | { kind: "error"; message; rateLimited; resetAt? };
```

This remains the seam for the CLI fallback and OpenAI compatibility path.

## Routing details

`AccountManager` persists rolling usage to `usage.json` and hard session pins to `sessions.json`.

- **Eligibility and priority**: authenticated accounts must clear cooldowns, provider/model eligibility, and actual exhaustion checks. Only the lowest-numbered usable priority tier participates. Model weekly exhaustion excludes that model only; explicit upstream allowed/blocked semantics (including Codex unenforced limits) remain authoritative.
- **Weighted selection (default)**: successive distinct weekly-reset ranks receive shares **5:3:2:1:0.5:0.25…**. Equal resets share a rank and each account receives that rank's share. Unknown data is probed first; spent reset data is demoted. The next fresh placement maximizes `manualWeight × expiryShare × fiveHourFactor / (activeSessions + 1)`; ties use round-robin. Eleven fresh live sessions across four healthy equal-weight accounts with distinct resets allocate 5/3/2/1.
- **Five-hour-only spillover**: only live account-wide or matching-model five-hour windows gate or taper selection. Missing/expired five-hour data is neutral; weekly-only snapshots never substitute weekly headroom. At least 20% five-hour headroom is neutral by default; below that, the factor is `(headroom / headroomTaperStart)^fiveHourExp`. The default 10% minimum is a preference gate with best-effort fallback when all usable candidates are below it. Weekly quota remains usable below 100%, without early spillover.
- **Provider choice**: weighted/expiring routing compares the best five-hour headroom in each provider's active tier, preserving candidate order on ties and provider pins. Provider-local expiry scores are not compared across providers. Explicit legacy `headroom` routing retains all-window comparisons; `expiring` routing uses strict expiry order with the same five-hour-only gate.
- **Stickiness**: live pins stay with usable accounts in the active tier. New placements and idle-pin expiry gradually approach the shares; this does not force active conversations to migrate. Sessions idle beyond the configured timeout stop counting. Requests without a session key do not change live-session occupancy and have **no ratio guarantee**. Session shares are not request or token shares.
- **Tuning**: manual account weights remain in account `routing.json`; `tuning.json` stores only explicit overrides for `fiveHourExp`, `minHeadroom`, and `headroomTaperStart` (finite, greater than zero and at most one; default 0.20). Retired `urgencyDecay`/`loadSlope` keys are ignored on read and rejected on write, as are unknown keys. They cannot silently restore the old scoring policy.
- **Preview**: `/api/status?provider=anthropic&model=fable` adds a model-aware `routingPreview` and `routingContext`, while retaining the default `routing` field for existing clients. The dashboard's provider/model-family controls describe the next **new session**, not an already-pinned request, and show backend-computed expiry shares, pinned sessions, five-hour headroom/factor, viability and score. Preview does not advance the tie cursor, roll live usage, or write pins.
- **Rate-limit handling**: direct proxy failover handles HTTP 429 and initial streaming rate-limit errors before committing SSE. Actual cooldowns evict pins; changing distribution alone does not. Deployment of code changes still requires a pool restart.

## Failure modes

- **No accounts / none available** → `503` with an OpenAI- or Anthropic-shaped error body.
- **Client disconnects** → the request's `AbortSignal` aborts the upstream fetch or subprocess.
- **Timeout** → `REQUEST_TIMEOUT_MS` aborts the direct upstream request/stream or subprocess.
- **CLI missing** → only affects `CLAUDE_POOL_BACKEND=cli` or OpenAI compatibility requests; a spawn error is surfaced as an `error` TurnEvent (→ `502`).
