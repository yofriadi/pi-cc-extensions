## Why

Users running pi-cc-extensions together with [pi-hashline-edit](https://www.npmjs.com/package/pi-hashline-edit) (a popular `read`/`edit`/`grep` tool override where every line carries a `LINE#HASH:` anchor) currently see degraded rendering: expanded `read`/`grep` results show raw hashline text with a misaligned line-number rail, edit diffs lose their real line numbers when anchors are enabled, and the compact-mode edit summary can claim "(+0 -0)" on successful edits whose diff payload it cannot parse. The anchors are essential for follow-up edits, but today they look like noise.

## What Changes

- **Read/grep hashline-aware rendering (ccstyle mode `on`)**: expanded `read` and `grep` results whose body carries `LINE#HASH:` prefixes render anchor lines as a two-column view — a dimmed anchor rail (`NN#HH`) plus the file content as the only full-width wrapped column. Grep scaffolding (per-file `path:` headers, ` ...` range separators, `---` file separators, the `N match(es) in M file(s).` summary) and bracketed advisories render as plain dimmed rows. Detection is a strict parser over the RAW content text: every line must classify as an anchor line (`NN#HH:` over the `ZPMQVRWSNKTXJBYH` alphabet, lengths 2–4), a structure line, or an advisory — anything else falls back to the existing plain rendering. Classification must never see the details-augmented body (`textFromResult(expanded=true)` appends a `Details:` inspect block, and upstream read/grep results always carry a details object, which would defeat classification for every real result). **Compact mode is explicitly out of scope**: expanded read/grep there deliberately use the native Pi renderer (`compact-mode.ts:1172`), which keeps prefixes visible and usable.
- **Zero-cost abstraction when not in use**: pure string/regex detection in the render path — no dependency on pi-hashline-edit, no hashing, no behavior change for users without the package. Rail stylers are module-level stable references (not per-render closures) so the existing view cache holds in steady state.
- **Edit diff line numbers + removed-line content fix**: hashline diff payloads (pi-hashline-edit's `details.diff`: `+NN#HH:`/`␣NN#HH:` for added/context, `-NN`+padding for removed) render real line numbers in collapsed/split/compact rich-diff layouts; the `NN#HH` anchor label replaces the line number only in expanded unified view, where anchors are actionable. Removed lines, which carry no hash upstream, always show old-side line numbers. The parser additionally strips the `-NN`+padding from removed-line content with an EXACT-width match (pad derived from the diff's own anchors — a greedy range would eat real leading indentation), classifies whole-file-replacement removals with correct old-side numbers, and recognizes spaces-only elision lines as meta rows. The strip is gated on strict-alphabet anchors with no hunk/file headers, so ordinary diffs whose content merely looks anchor-shaped never trigger it.
- **Compact-mode edit stats**: no false `(+0 -0)` — when the structured details-diff parse yields zero change lines for an `edit`, stats are omitted rather than faked. (No re-scan fallback: `countEditDiffStats` already parses the same `result.details.diff` string, so a re-scan can never recover counts the primary parse missed — verified empirically. `write` keeps truthful `(+0 -0)` from its content-comparison stats.)
- **Config**: new `hashlineAnchors` toggle (`"auto" | "on" | "off"`, default `"auto"`) in `/ccstyle` under the Diff tab, honored by every hashline code path (read/grep rails and edit-diff anchor labels) with live repaint.

## Capabilities

### New Capabilities

- `hashline-tool-rendering`: Hashline-aware presentation of `read`, `grep`, and `edit` tool outputs — detection of hashline-formatted text, anchor-rail rendering in expanded tool views (mode `on`), line-number/anchor label policy in edit diffs, compact edit-stats fallback, and the `hashlineAnchors` config option.

### Modified Capabilities

<!-- openspec/specs/ is empty (greenfield) — no existing requirement specs to modify. -->

## Impact

- **Code**:
  - `extensions/renderer/tool/hashline.ts` (new) — detection/parse/prefix-strip helpers.
  - `extensions/renderer/tool/result.ts` — `ExpandedToolIoView` gains an output-line styler hook (options bag; `setContent` change-equality and a shared wrap-plan used by `pushBody` and the truncation pre-decision `bodyExceedsLineLimit` become styler-aware).
  - `extensions/renderer/default-mode.ts` — wire the read/grep styler into expanded results (mode `on` only).
  - `extensions/renderer/compact-mode.ts` — compact edit-stats zero-suppression for `edit` only; no read/grep changes.
  - `extensions/renderer/tool/diff/diff-parse.ts` — gated on strict-alphabet hashline annotation (and no hunk/file headers), recognize the removed-line shape with an exact-width pad (derived from sibling anchors; strip number+padding, preserve true content indentation, no anchor label); recognize spaces-only elisions as meta rows; whole-file replacements get correct old-side numbers.
  - `extensions/renderer/tool/diff/diff-edit-render.ts`, `diff-layout.ts` — anchor-vs-linenumber label policy moved into the width-aware render closure (flag **and** gutter width), gated on live config.
  - `extensions/renderer/tool/diff/diff-component.ts` — render-cache key includes `hashlineAnchors` so live toggles repaint.
  - `extensions/config/config.ts` — `hashlineAnchors` in `ToolDisplayConfig`, `Config`, `DEFAULT_CONFIG`, `normalizeConfig`, `getToolDisplayConfig`; `extensions/config/panel.ts` — `/ccstyle` UI.
- **Tests**: `tests/tool-hashline.test.ts` (new); additions to `tests/tool-diff.test.ts` (label policy + real upstream fixtures) and `tests/compact-mode.test.ts` (details-diff stats fallback).
- **Dependencies**: none added. pi-hashline-edit remains an optional peer package; integration is purely textual.
- **Backwards compatibility**: fully additive; `hashlineAnchors: "auto"` only activates when hashline-formatted output is actually detected.
