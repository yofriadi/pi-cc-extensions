# Tasks: Working Message Speed (tok/s)

## 1. Timing state and anchoring

- [x] 1.1 In `extensions/feature/shell/working-message.ts`, add module-level `firstDeltaTime = 0` and `responseEndTime = 0` (design D1). Do NOT clear them in `resetResponseTracking()` — that function also runs on `done`/`error`, where timing must survive. Instead clear both explicitly at: (a) the response `start` branch of the `message_update` handler, (b) the `turn_start` handler, (c) `clearDisplay()`. Update the function's doc comment if it claims full reset coverage
- [x] 1.2 Anchor the first content delta (design D2): in the existing `thinking_delta`/`text_delta` branch, set `if (!firstDeltaTime) firstDeltaTime = Date.now();`. Add a `toolcall_delta` branch that sets the anchor AND calls `updateProviderUsage(evt.partial)` — today `toolcall_delta` falls into the final `else` which already captures `usage.output` mid-stream, and dropping that would violate the "token counting MUST NOT change" requirement. The branch must still NOT touch `responseTextBlockLengths` (chars/4 stays text/thinking-only). No other branch anchors
- [x] 1.3 Freeze at response end (design D3): in the `done` and `error` branches, after the existing `resetResponseTracking(evt.message)` / `(evt.error)` call, set `responseEndTime = Date.now()`

## 2. Speed segment in the working message

- [x] 2.1 Add `formatTps(tps)` (design D4): integer via `Math.round` at ≥ 100, else `toFixed(1)`
- [x] 2.2 In `buildWorkingMessage()`, after pushing the token segment and before the elapsed segment: when `tokens > 0 && firstDeltaTime > 0`, compute `basis = (responseEndTime || Date.now()) - firstDeltaTime`; when `basis > 0`, push `` `${formatTps(tokens / (basis / 1000))} tok/s` ``. Omit the segment in all guarded cases — never render `0 tok/s`, `NaN`, or `Infinity`
- [x] 2.3 Update the module doc comment (`:48-54`) to the new message shape `Working... (↓ 1,234 tokens · 863 tok/s · 12s)` and one line on the timing model (first content delta → response end, excludes TTFT, freezes on done/error). No new timer: the existing 1s refresh tick drives live updates, and `syncWorkingMessage`'s equality skip must be preserved

## 3. Tests

- [x] 3.1 Update the strict format assertion in `tests/working-message.test.ts` test 1 from `/^Working\.\.\. \(↓ \d+ tokens · \d+s\)$/` to include the speed segment: `/^Working\.\.\. \(↓ \d+ tokens · [\d.]+ tok\\/s · \d+s\)$/`. Test 1 also needs the 3.2 mock-timers flow: its render happens synchronously inside the `text_delta` handler where `basis === 0` and the speed segment is omitted — enable `mock.timers`, advance past the anchor, and re-render (second delta or refresh tick) before asserting
- [x] 3.2 Speed value test with `mock.timers.enable({ apis: ["Date", "setTimeout"] })`: `turn_start` at t0; advance 2000ms; `text_delta` (anchor set — assert NO `tok/s` while `basis === 0`); advance 1000ms; assert the segment equals tokens ÷ 1.0s per `formatTps`. Reset/scope timers so the refresh `setTimeout` loop does not leak across tests
- [x] 3.3 Freeze test: after `done` carrying `usage.output`, advance mock time several seconds and drive a re-render via the refresh timer; assert `tok/s` is unchanged while the elapsed segment advanced
- [x] 3.4 Reset tests: (a) a second response `start` within the turn removes the `tok/s` segment until a new delta arrives; (b) `turn_start` clears it across turns
- [x] 3.5 Tool-call anchor test: a `toolcall_delta` sets the anchor; with `usage.output` streamed on a later `toolcall_delta` partial (the common case — usage riding tool-call deltas is exactly what the 1.2 branch preserves) the token and speed segments appear; without any usage, neither segment appears
- [x] 3.6 No-redundant-repaint test: assert the equality skip on an unchanged composed message via a reachable trigger — e.g. fire `done` (carrying `usage.output` consistent with the current token count) at the same mocked millisecond as the preceding render, or fire a stray post-`done` `message_update` within the same millisecond, and assert no additional `setWorkingMessage` call. Do NOT use a post-`done` refresh tick for this: ticks advance `Date.now()` by exactly 1000ms and elapsed is second-floored, so every tick flips the elapsed text by one second — an "unchanged elapsed" tick cannot exist

## 4. Docs

- [x] 4.1 `README.md` and `README.en.md` line 84: extend the `enableWorkingMessage` comment to mention the speed segment (`token/速率/耗时`, `token/speed/elapsed`)

## 5. Verification

- [ ] 5.1 Manual smoke: run pi with the extension — watch the working row during a fast and a slow model response; confirm the speed appears after the first delta, updates live, freezes while tools execute, and resets on the next response/turn
- [x] 5.2 From `packages/pi-cc-ui`: `npm run format && npm run lint && npm run typecheck && npm test` all pass; from the repo root: `pnpm run check` passes with no errors, warnings, or infos
