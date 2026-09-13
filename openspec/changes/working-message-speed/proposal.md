## Why

The `Working...` footer extension shows the live output token count and elapsed time (`⠋ Working... (↓ 1,234 tokens · 12s)`), but not the **rate** at which tokens are arriving. A growing token count cannot distinguish a fast model from a slow one, and gives no signal about whether the stream is healthy or crawling. [pi-speedometer](https://github.com/championswimmer/pi-speedometer) demonstrates the value of a live tok/s readout, but it renders a separate status-bar segment; users of this package already have the working-row override, and the natural place for the speed is inline with the token count it derives from.

## What Changes

- **Live decode speed in the working row**: `Working... (↓ 284 tokens · 863 tok/s · 2m 0s)` — the speed segment is inserted between the token count and the elapsed time. Speed = current output token count ÷ generation duration, where the duration window runs from the **first content delta** of the current response to now (while streaming) or to response end (once finished). Anchoring at the first delta excludes time-to-first-token, so the number reflects decode speed, not latency.
- **Freeze on response end**: when the assistant message completes (`done`) or fails (`error`), the speed's denominator is frozen at the end time. While tools execute between LLM calls within the same turn, tok/s stays at the response's final average instead of decaying spuriously; the elapsed timer keeps ticking independently.
- **Tool-call responses get timing**: `toolcall_delta` events count as timing anchors (they set the first-delta time), so tool-call-heavy responses show a speed whenever the provider streams cumulative `usage.output` (the only token source for those responses, consistent with how the token count already behaves).
- **Formatting**: integer tok/s at ≥ 100 (`863 tok/s`), one decimal below (`87.4 tok/s`) — matching pi-speedometer's `formatTps`.
- **No new config option**: the speed rides behind the existing `enableWorkingMessage` toggle. It is a display detail of an already-gated feature, not a new handler.

## Capabilities

### New Capabilities

- `working-message-speed`: Per-response output-token speed measurement (first content delta → response end) rendered inline in the `Working...` footer row, with frozen speed after response end and per-response reset semantics.

### Modified Capabilities

<!-- openspec/specs/ is empty (greenfield) — no existing requirement specs to modify. -->

## Impact

- **Code**: no new file. The entire change lives in `extensions/feature/shell/working-message.ts`: two timing state variables, reset wiring in the existing reset paths, first-delta anchoring in the `message_update` handler (including `toolcall_delta`, preserving its existing `usage.output` capture), end-time freeze on `done`/`error`, and a speed segment in `buildWorkingMessage`.
- **Tests**: `tests/working-message.test.ts` — update the strict message-format regex; add `mock.timers`-driven tests for the speed value, the freeze-on-done behavior, and per-response reset.
- **Docs**: `README.md` / `README.en.md` line 84 (`enableWorkingMessage` comment) gains a mention of the speed segment.
- **Dependencies**: none added. Timing model is adapted from pi-speedometer (MIT); no code is vendored.
- **Backwards compatibility**: purely additive display segment; users with `enableWorkingMessage: false` see zero change; no persisted state.
