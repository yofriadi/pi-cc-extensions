# Design: Working Message Speed (tok/s)

## Context

`extensions/feature/shell/working-message.ts` extends pi's footer working row
via `ctx.ui.setWorkingMessage`, preserving the native spinner and `Working...`
prefix and appending `(↓ N tokens · <elapsed>)`. Live tokens use a chars/4
estimate over visible text/thinking block lengths, replaced by the provider's
cumulative `usage.output` whenever the stream exposes it (`tokenCount()`).
The row re-renders on every `message_update` and on a 1s refresh timer
(`REFRESH_INTERVAL_MS`) while a turn is active.

Reference implementation — pi-speedometer (`src/index.ts`, MIT) timing model:

```
before_provider_request ──► first *_delta ──► ...deltas... ──► message_end
        │ requestStart           │ firstDeltaTime                    │ end
        └───────── TTFT ─────────┘
                                └───── generation duration ──────┘
                                TPS = tokens / duration
```

Its `tps = tokenCount / (now − firstDeltaTime)` is a **cumulative decode
average**: it excludes TTFT, needs no sliding window, and self-corrects the
initial spike (first fraction of a second produces a high reading that decays
into the true rate). Its token count is `usage.output` when the provider
streams cumulative usage, else chars/4 over content chars — identical in
spirit to our existing `tokenCount()`.

What we deliberately do **not** take from pi-speedometer: its TTFT metric, its
`ctx.ui.setStatus` rendering (we already own the working row), its settings
file, and its `/speed` command.

Verified facts about the current code (all line references are
`working-message.ts` as of this change):

- State reset funnels through `resetResponseTracking()` (`:76-81`), which is
  called on response `start` (`:172`), `done` (`:187`), `error` (`:189`),
  `turn_start` (`:161`), `turn_end` (`:202`), and via `clearDisplay()`
  (`:144-150`) on `agent_end` / `session_shutdown`. Adding timing-state resets
  to this one function covers every path.
- The elapsed clock reads `Date.now() - (agentStartTime || turnStartTime)`
  (`:88`) — a **turn-scoped** clock. The speed clock is **response-scoped**
  (it resets on each LLM response `start`); the two coexist as independent
  segments in the same message.
- `buildWorkingMessage()` (`:87-97`) currently pushes `↓ N tokens` then
  `formatDuration(elapsed) || "0s"`. The speed segment inserts between them.
- The 1s `scheduleRefreshTick()` (`:125-136`) already calls
  `syncWorkingMessage()`, so a live speed keeps updating during streaming and
  long thinking stalls with no new timer. Post-`done` steady state: the frozen
  speed text never changes, but each tick advances `Date.now()` by exactly
  1000ms and elapsed is second-floored (`formatDuration`), so the composed
  text flips once per tick and the `next === lastMessage` equality skip
  (`:116`) fires only between renders within the same second — exactly the
  behavior today (no change).
- Test harness: `tests/working-message.test.ts` drives the extension with a
  mock pi (`events` map + captured `setWorkingMessage` calls). Async handlers
  are awaited directly; no fake timers are used today, so Date-dependent
  tests must introduce `node:test` `mock.timers`.

`before_provider_request` is available in the installed pi-coding-agent types
(`dist/core/extensions/types.d.ts:905`) but is **not needed**: anchoring at the
first delta makes requestStart unnecessary for TPS (it would only matter for
TTFT, which is out of scope).

## Goals / Non-Goals

**Goals**

- `Working... (↓ 284 tokens · 863 tok/s · 2m 0s)` — live decode speed between
  the token count and elapsed time.
- Speed = current output tokens ÷ (speed basis − first content delta time),
  response-scoped; excludes TTFT by construction.
- Speed freezes when the response ends (`done`/`error`); elapsed keeps
  ticking.
- `toolcall_delta` counts as a timing anchor so tool-call responses show a
  speed when (and only when) provider `usage.output` is streamed.
- No new config surface; the speed rides behind `enableWorkingMessage`.

**Non-Goals**

- TTFT display (pi-speedometer's other metric).
- A separate status-bar segment (`setStatus`) — inline in the working row.
- A `/speed`-style command, settings file, or per-metric on/off toggles.
- Token counting changes (chars/4 estimate vs `usage.output` behavior stays
  exactly as-is).
- Including tool-execution or user-thinking time in the speed denominator.
- Smoothing/EMA over a sliding window (the cumulative average is sufficient;
  it is what pi-speedometer ships).

## Decisions

### D1: Response-scoped timing state, explicit reset sites

Add two module-level variables alongside the existing tracking state:

```ts
let firstDeltaTime = 0;   // Date.now() of the first content delta; 0 = none yet
let responseEndTime = 0;  // Date.now() at done/error; 0 = still streaming
```

These vars are deliberately NOT cleared inside `resetResponseTracking()`:
that function is also called on `done`/`error` — the exact moments where the
timing must survive (D3). Instead both are cleared explicitly at the three
places a response lifecycle genuinely begins or is torn down:

1. the response `start` branch of `message_update` (new response in-turn),
2. the `turn_start` handler (alongside `resetResponseTracking()`),
3. `clearDisplay()` (covers `agent_end` / `session_shutdown`).

No `before_provider_request` handler is registered.

### D2: First-delta anchoring on text/thinking/toolcall deltas

In the `message_update` handler, the existing branches for
`thinking_delta`/`text_delta` (`:176-179`) gain:

```ts
if (!firstDeltaTime) firstDeltaTime = Date.now();
```

A new `toolcall_delta` branch sets the anchor AND calls
`updateProviderUsage(evt.partial)` — today `toolcall_delta` falls into the
final `else` (`:190-192`), which already feeds `usage.output` into the token
count mid-stream; the new branch MUST preserve that (the spec's "token
counting MUST NOT change" constraint). It still must NOT touch
`responseTextBlockLengths` — chars/4 stays text/thinking-only. Branches that
do not anchor: `start`, `*_start`, `*_end` (not deltas), `done`, `error`.

### D3: Freeze the denominator at response end

In the `done` and `error` branches, after the existing
`resetResponseTracking(evt.message)` / `(evt.error)` call:

```ts
} else if (evt.type === "done") {
    resetResponseTracking(evt.message);
    responseEndTime = Date.now();
}
```

Because D1 keeps timing out of `resetResponseTracking`, `firstDeltaTime`
survives the `done`/`error` reset untouched — no capture-and-restore
dance — and `responseEndTime` simply records the freeze. The speed then
remains the response's final average until the next response `start` or the
turn teardown clears it.

*Why freeze at all?* Within a turn, `done` is followed by tool execution;
without a freeze the denominator keeps growing while no tokens arrive, so the
displayed rate decays toward zero — a meaningless number. Freezing shows the
response's final average decode speed until the next response starts.

*Why not stop at `turn_end` instead?* `turn_end` already tears the whole
display down (`restoreDefaultWorkingMessage`, `:198-205`); the freeze only
matters inside the turn, between responses.

### D4: Speed segment in `buildWorkingMessage`

After the token segment is pushed (`:91`) and before the elapsed segment
(`:92-95`):

```ts
if (tokens > 0 && firstDeltaTime > 0) {
    const basis = (responseEndTime || Date.now()) - firstDeltaTime;
    if (basis > 0) parts.push(`${formatTps(tokens / (basis / 1000))} tok/s`);
}
```

Guards: no deltas yet (`firstDeltaTime === 0`), zero tokens (e.g. a pure
tool-call response without streamed usage — consistent with the token
segment, which is also absent then), and a zero/negative window (delta and
render in the same millisecond, or pathological clock skew) → no segment.

Formatter (pi-speedometer's `formatTps`):

```ts
function formatTps(tps: number): string {
    return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}
```

Integer at ≥ 100 (matches the `863 tok/s` target), one decimal below for
legibility of slow streams. No icon, no `⚡` — plain `tok/s`, matching the
row's existing terse `↓ N tokens` style.

Early-stream spike: the first fraction of a second reads high (e.g. 2 tokens
in 60ms → `33.3 tok/s`) and converges within a second or two. This is
inherent to the cumulative model and acceptable — pi-speedometer ships the
same.

### D5: Tests with `mock.timers`

`node:test`'s `mock.timers.enable({ apis: ["Date", "setTimeout"] })` makes
both `Date.now()` and the refresh timer deterministic. New/updated tests:

1. **Format regex** — the existing strict assertion
   `/^Working\.\.\. \(↓ \d+ tokens · \d+s\)$/` (test 1) becomes
   `/^Working\.\.\. \(↓ \d+ tokens · [\d.]+ tok\/s · \d+s\)$/`. Test 1 needs
   the same mock-timers flow as item 2: its render happens synchronously
   inside the `text_delta` handler, where `basis === 0` and the speed segment
   is omitted — enable timers, advance past the anchor, and re-render (a
   second delta or a refresh tick) before asserting.
2. **Speed value** — enable timers at a fixed epoch; `turn_start`; advance
   e.g. 2000ms; one `text_delta` (sets the anchor at t=2000 — so first
   `message_update` renders must not show a speed until the window opens);
   advance 1000ms more and assert the rendered `tok/s` equals
   `tokens / 1.0s` within formatting rules. Note: with mocked Date, deltas at
   t=2000 and render at t=3000 give basis 1000ms — deterministic.
3. **Freeze on done** — after `done` with `usage.output`, advance mock time
   by several seconds and force a re-render (e.g. via the refresh timer
   tick): tok/s unchanged, elapsed advanced. Assert both.
4. **Per-response reset** — a second response `start` within the turn clears
   the speed (message has no `tok/s` until a new delta arrives), and
   `turn_start` clears it across turns.
5. **Tool-call anchor** — a `toolcall_delta` sets the anchor; with streamed
   `usage.output` on a later `toolcall_delta` partial, a speed appears;
   without usage, only the absence of the token segment (existing behavior)
   — speed absent too.
6. **No redundant repaint** — assert the equality skip on an unchanged
   composed message via a reachable trigger: fire `done` (carrying
   `usage.output` consistent with the current token count) at the same
   mocked millisecond as the preceding render, or fire a stray post-`done`
   `message_update` within the same millisecond, and assert no additional
   `setWorkingMessage` call. A post-`done` refresh tick is NOT a usable
   trigger: ticks advance `Date.now()` by exactly 1000ms and elapsed is
   second-floored, so every tick flips the elapsed text by one second — an
   "unchanged elapsed" tick cannot exist.

Each test that enables `mock.timers` must `mock.timers.reset()` (or use
`t.mock.timers` scoping) so the refresh `setTimeout` loop doesn't leak across
tests.

### D6: No config option — and no panel changes

The speed is gated entirely by the existing `enableWorkingMessage` (the
extension isn't loaded when false, `index.ts:26`). pi-speedometer's per-metric
toggles exist because it adds two metrics and a status segment; we add one
segment to an already-optional row. README line 84's comment
(`Working... 底部 token/耗时`) gains `·速率` / `speed` to mention it.

## Risks / Trade-offs

- [First-millisecond spike reads absurdly high] → Cumulative average
  self-corrects within ~1s; the `basis > 0` guard avoids the degenerate
  divide-by-zero. Accepted (matches reference behavior).
- [Providers that never stream `usage.output` mid-response (OpenAI-style:
  usage only in the final chunk)] → tokens jump from estimate to exact at
  `done`, and the frozen speed snaps accordingly — the same snap the token
  count already exhibits today; no new inconsistency.
- [Clock adjustments (NTP) skew Date.now()] → Same exposure as the existing
  elapsed timer; `performance.now()` would be monotonic but the module
  already standardizes on `Date.now()` and tests mock it — consistency wins.
- [Frozen speed misread as "still streaming at this rate"] → The row already
  changes meaning post-`done` (tokens stop growing); the frozen average is
  labeled identically and the elapsed timer continues, signaling liveness of
  the turn, not of the stream.
- [`toolcall_delta` events with different type names across providers] →
  Worst case the anchor is never set and the speed segment is absent for that
  response — graceful degradation, no error.

## Migration Plan

Purely additive display segment; no migration, no persisted state, no config
keys added. Rollback = revert the commit (or set `enableWorkingMessage:
false`, which already disables the whole row).

## Open Questions

- None. Timing reset sites are settled (D1/D3); D5 pins the behavior.
