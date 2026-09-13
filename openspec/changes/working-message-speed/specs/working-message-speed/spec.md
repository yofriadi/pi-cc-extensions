# Working Message Speed — Delta Spec

Delta for new capability `working-message-speed`. This change is purely
presentational: it never alters tool arguments, results, prompts, or the
model-facing transcript — only the text of the footer working row drawn by
`extensions/feature/shell/working-message.ts` while a turn is active.

**Timing reference** (adapted from pi-speedometer, MIT): the generation
window for a response runs from its first content delta
(`text_delta` / `thinking_delta` / `toolcall_delta`) to the present while
streaming, or to the response's `done`/`error` time once finished. The
window deliberately excludes time-to-first-token.

## ADDED Requirements

### Requirement: Response-scoped speed measurement

The system SHALL measure output token speed per LLM response within a turn.

The speed numerator SHALL be the same token count already displayed in the
working row (provider `usage.output` when streamed, else the chars/4
estimate over text/thinking content). Token counting behavior itself MUST
NOT change.

The speed denominator SHALL be the elapsed wall-clock time from the
response's first content delta to the speed basis, where the basis is the
current time while the response is streaming, or the `done`/`error`
timestamp once the response has ended. Both timing values SHALL reset when
a new response starts, when a new turn starts, and when the display is
cleared (`agent_end` / `session_shutdown`). A response with no content
delta yet SHALL have no speed measurement.

`toolcall_delta` events SHALL count as timing anchors (they establish the
first-delta time) but MUST NOT contribute to the chars/4 token estimate —
consistent with existing token counting, which relies on provider usage for
tool-call content.

#### Scenario: Speed appears with the first tokens

- **WHEN** a response's first `text_delta` (or `thinking_delta`) has
  arrived and at least one millisecond has passed since it arrived
- **THEN** the working row shows a `N tok/s` segment computed as
  tokens ÷ seconds since that first delta

#### Scenario: No speed before the first delta

- **WHEN** a turn has started but no content delta has arrived for the
  current response (e.g. the model is still in time-to-first-token)
- **THEN** the working row shows no `tok/s` segment

#### Scenario: Tool-call deltas anchor timing

- **WHEN** a response consists of tool calls and a `toolcall_delta` arrives
  before any text/thinking delta, and the streamed partial later carries
  `usage.output`
- **THEN** the speed window starts at the `toolcall_delta` and the row
  shows a `tok/s` segment once a token count is available

#### Scenario: Speed resets between responses within a turn

- **WHEN** an assistant message completes, tools execute, and the next
  assistant message begins streaming within the same turn
- **THEN** the speed measurement restarts from that response's first
  content delta (the previous response's speed and window are discarded)

#### Scenario: Speed resets across turns

- **WHEN** a turn ends and a new turn begins
- **THEN** no `tok/s` segment appears until the new response's first
  content delta arrives

### Requirement: Speed freezes at response end

When the assistant message event is `done` or `error`, the system SHALL
freeze the speed denominator at that moment. While the turn continues
(e.g. tools are executing), the rendered `tok/s` MUST remain the response's
final average — it MUST NOT decay as wall time passes without new tokens.
The elapsed-time segment of the working row MUST continue to tick
independently of the freeze.

If a response ends without any content delta (empty or failed stream), no
speed segment SHALL be shown for that response.

#### Scenario: Frozen speed during tool execution

- **WHEN** a response has completed with a displayed speed of
  `120 tok/s` and several seconds pass while tools execute
- **THEN** the working row still shows `120 tok/s` while the elapsed
  segment continues to advance

#### Scenario: Error freeze

- **WHEN** a response ends in an `error` event after streaming some deltas
- **THEN** the speed freezes at its final average exactly as for `done`

#### Scenario: No speed for a delta-less response

- **WHEN** a response ends (done or error) without any content delta
  having arrived
- **THEN** no `tok/s` segment is shown for that response

### Requirement: Speed formatting and placement in the working row

The working message SHALL read
`Working... (↓ <tokens> tokens · <speed> tok/s · <elapsed>)` — the speed
segment sits between the token count and the elapsed time, preserving pi's
native spinner and `Working...` prefix.

Speed values SHALL be formatted as an integer (rounded) when ≥ 100 tok/s
(e.g. `863 tok/s`) and with one decimal place below 100 (e.g. `87.4
tok/s`). The segment SHALL be omitted — never rendered as `0 tok/s`, `NaN`,
or `Infinity` — when there is no token count, no first-delta time, or a
non-positive time window.

The live speed SHALL update on stream events and on the existing one-second
refresh tick while the turn is active; no additional timer SHALL be
introduced. Message-equality short-circuiting (no redundant
`setWorkingMessage` calls when the composed text is unchanged) MUST keep
working.

#### Scenario: Target format

- **WHEN** 284 output tokens have been generated over 0.329 seconds of
  generation window
- **THEN** the row reads `Working... (↓ 284 tokens · 863 tok/s · …)`

#### Scenario: Slow stream formatting

- **WHEN** the computed speed is 87.36 tok/s
- **THEN** the segment reads `87.4 tok/s`

#### Scenario: Degenerate windows omitted

- **WHEN** the first delta and the render happen within the same
  millisecond, or the clock reports a non-positive window
- **THEN** no `tok/s` segment is rendered

#### Scenario: No redundant repaints

- **WHEN** a render is triggered (stream event or refresh tick) while the
  composed message text is unchanged
- **THEN** `setWorkingMessage` is not called again

### Requirement: No new configuration surface

The speed segment SHALL be governed solely by the existing
`enableWorkingMessage` toggle: when the working-message extension is not
loaded, nothing changes. No new config keys SHALL be added to
`claude-code-style.json`, the `/ccstyle` panel, or any settings file, and
no new commands SHALL be registered.

#### Scenario: Existing toggle coverage

- **WHEN** `enableWorkingMessage` is `false`
- **THEN** the footer working row is pi's native one, with no speed segment

#### Scenario: Config unchanged

- **WHEN** the config file is loaded, edited via `/ccstyle`, and saved after
  this change
- **THEN** the persisted key set is identical to before the change (no
  speed-related keys)
