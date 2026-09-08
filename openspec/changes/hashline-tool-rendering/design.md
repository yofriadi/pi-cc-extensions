# Design: Hashline Tool Rendering

## Context

pi-hashline-edit overrides pi's built-in `read`/`edit` (and optionally `grep`)
tools. Every anchor is `NN#HH:` where `HH` uses the alphabet
`ZPMQVRWSNKTXJBYH` (16 chars, one nibble each), length 2 by default,
user-configurable to 2–4 via `~/.pi/agent/hashline.json`. All formats below
are **verified against upstream source** (`src/read.ts`, `src/grep.ts`,
`src/edit-response.ts`, `src/edit-diff.ts`, and `src/hashline/format.ts`
where `formatHashlineRegion` lives).

**`read` output** — `formatHashlineRegion` emits `NN#HH:content` for every
line (including empty lines, which get a hash of the empty string). Optional
bracketed advisories may follow the body:

- `[Showing lines A-B of N. Use offset=K to continue.]`
- `[Showing lines A-B of N (X.0 KB limit). Use offset=K to continue.]`
- `[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`

(`Offset N is beyond end of file …`, `File is empty …`, and `[Line N exceeds
…]` are *whole-body* plain responses with no anchor lines — they classify as
plain and need no special handling.)

**`grep` output** (opt-in) — per-file blocks with **structural scaffolding**,
then a summary. There are **no per-line match markers** (`+`/`-`/`:`/`|`);
anchor lines are left-padded line numbers exactly as in `read`:

```
src/a.ts:
9#VR:foo()
 ...
40#KT:bar()
---
src/b.ts:
3#PM:baz()
---
2 matches in 2 files.
```

Structural lines: `<path>:` file header, a range separator (a run of one
more spaces followed by `...` — upstream emits a constant 4-space
separator (`outputParts.push("    ...")`, grep.ts:403), and anchor
left-padding is region-end-width-relative, NOT separator-aligned, so the
separator may be wider or narrower than the rail), `---` file separator,
and an `N match(es) in M file(s).` summary (singular/plural on both words,
with optional ` (truncated at L)`). (An earlier note claimed a "single
leading space" — a round-3 transcription error; the constant is 4 spaces.
The `1+ spaces` grammar covers it and any width-relative variant.)

**`edit` `details.diff`** — added/context lines carry a live anchor; removed
lines carry a **blank hash slot that replaces `#HH:` entirely** (no `#`, no
`:`), padded to `hashLength + 2` spaces so columns stay aligned:

```
+12#VR:new line
 12#VR:context line
-12    removed line          <- "-NN" + (hashLength+2) spaces + content
    ...                        <- elision: (lineNumWidth+2) spaces + "...", NO digits
```

**`edit` model-facing success text** — only a fresh-anchors block plus
optional warnings; it contains **no `+`/`-` diff lines**:

```
--- Anchors 12-18 ---
12#VR:line content
13#KT:more content
```

The diff lives exclusively in `details.diff`.

When both packages are installed, pi-cc-extensions' renderer wraps these
overridden tools (it wraps by tool **name** via `renderResult` patches), so
the integration surface is entirely on our side.

Current state in pi-cc-extensions (verified against code):

- `diff-parse.ts` parses hashline added/context lines via
  `HASHLINE_ANCHOR_LINE_PATTERN` (`/^([+\- ])(\s*\d+)#([A-Za-z0-9]+| {2}):(.*)$/`).
  Upstream **removed** lines have no `#`/`:` and do **not** match this — they
  fall to the generic `rawLine.startsWith("-")` branch (`:275`), whose
  `pushParsedLineEntry` keeps `content: rawLine.slice(1)` — i.e. the **entire
  number + padding** stays inside `entry.content` (`-21    const x = 20;` →
  `content: "21    const x = 20;"`). Numbers still come out right when context
  anchors seed the cursor, but the rendered content cell duplicates the gutter
  number and misaligns against cleanly-parsed add/context rows, in every
  layout, ungated by config (verified empirically with a real upstream
  `generateDiffString` diff driven through `parseDiff`). Whole-file
  replacements (no preceding context anchors) additionally lose old-side
  numbers entirely (`oldLineNumber: null`). Elision lines (spaces + `...`,
  no digits — see D3.1) fall through as **context line entries** whose
  content is the leftover spaces + `...`, inflating `stats.context`; they
  are not meta rows today.
- `diff-edit-render.ts:93-96` computes `showHashlineAnchors` **and**
  `lineNumberWidth` at construction time — mode-agnostic — so anchors today
  leak into every expanded layout (including split and width-forced compact)
  and the gutter width is fixed before the layout mode is known.
- Expanded `read`/`grep` in mode `on` goes through `renderExpandedToolResult`
  → `ExpandedToolIoView`, which styles output lines uniformly; no per-line
  hook exists.
- **Compact mode is different by design**: expanded non-edit/write tools fall
  through to the native Pi renderer (`compact-mode.ts:1173-1174`, comment at
  `:1172` "独立展开走原 renderer"), and the default-mode ccstyle renderResult
  is gated on mode `on` (`default-mode.ts:277-285`). The only
  `renderExpandedToolResult` call in compact mode is inside
  `compactEditWriteLines` (`:620-628`, `flushLeft=true`), which runs only for
  `edit`/`write`.
- Compact edit stats come solely from `countEditDiffStats`
  (`diff-edit-render.ts:51-62`), which returns `undefined` only for empty /
  throwing diffs — but `parseDiff` never throws on arbitrary text (unparseable
  lines become meta entries, `diff-parse.ts:345`). So a present-but-useless
  details diff yields `{added: 0, removed: 0}` and compact mode faithfully
  renders `(+0 -0)` (`compact-mode.ts:529-532`).
- Config flows: `Config` (`config.ts:42-67`) / `DEFAULT_CONFIG` (`:103-128`) /
  `normalizeConfig` (`:147-227`) → `getToolDisplayConfig` (`:237-247`) →
  `resolveLiveDisplayConfig` → `displayConfigCacheKey`
  (`diff-component.ts:37-47`) gates the diff render cache. Any new display
  option must touch every step or it will be dropped on save
  (`updateConfig`→`normalizeConfig`, `config.ts:303`) or fail to repaint.

Constraints: no new runtime dependencies; must not import pi-hashline-edit;
must not regress rendering for users without the package; render path must
stay cheap (line-level regex only, no hashing).

## Goals / Non-Goals

**Goals**

- Expanded hashline `read`/`grep` output in mode `on` renders as anchor rail +
  stripped, aligned content column; grep structural lines and advisory notices
  render as plain dimmed rows.
- Hashline edit diffs show real line numbers in collapsed/split/compact
  layouts and `NN#HH` anchor labels only in expanded unified layout.
- Removed-line content is stripped of its `-NN` + padding prefix at parse
  time (B1) — no duplicated numbers or phantom indent in any layout.
- Compact edit summaries never show a false `(+0 -0)` for edits whose
  details diff contains change lines (B2, via edit-only zero-suppression).
- `hashlineAnchors` config (`auto`/`on`/`off`) with live repaint, honored by
  every hashline code path.

**Non-Goals**

- Anchor-rail rendering for compact-mode read/grep. Their expanded path is
  deliberately native (`compact-mode.ts:1172`); the native renderer keeps
  prefixes visible and usable. Changing that design decision is out of scope.
- Re-computing or verifying line hashes in the renderer (anchors are opaque).
- Changing pi-hashline-edit itself, its tool prompts, or the model-facing
  transcript in any way.
- Hashline-aware `write` rendering (write is not hashline-annotated upstream).
- Clicking an anchor to issue a follow-up edit (possible future work).
- Porting pi-hashline-edit's `xxhashjs` dependency — deliberately avoided.

## Decisions

### D1: Detect by content, with a three-kind line taxonomy

Detection is a pure function over the result text. Every line is classified
into exactly one kind:

- **anchor** — `^(\s*\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):(.*)$`;
- **structure** — blank, grep `<path>:` header, a run of one or more spaces
  then `...`, `---`, or the `N match(es) in M file(s).` summary;
- **advisory** — bracketed, verb-led (`Showing` / `Line N exceeds` /
  `Offset N` / `Non-UTF-8`). Upstream emits no advisory led by `Truncated`
  (grep truncation is the lowercase ` (truncated at L)` summary suffix), so
  that token is deliberately omitted.

A body qualifies when it has **at least one** anchor line and **every** line
is anchor, structure, or advisory. An empty body (zero anchor lines) returns
`null` — never a phantom rail.

*Why not detect "is pi-hashline-edit installed"?* The renderer wraps tools by
name and cannot reliably attribute an overridden tool definition to a
specific package; content-based detection is exact, side-effect free, and
covers resumed transcripts. *Why strict?* A single unclassifiable line means
the body isn't trustworthy hashline output; falling back to plain rendering
is always safe and never loses information.

### D2: Anchor rail via a body-level styler hook in `ExpandedToolIoView`

Add an **options bag** (the constructor already has 7 positional params, and
tests construct it positionally) carrying a single optional hook:

```ts
styleOutputLines?: (lines: string[]) => { rail: string; content: string }[] | null
```

The hook is body-level because detection is all-or-nothing per body. In
`pushBody`, when the hook returns a non-null classification, each anchor line
is split into `{rail, content}`; the rail is drawn dimmed at a fixed width
computed from the classification, and only `content` goes through
`wrapTextWithAnsi`, with continuation rows prefixed by a blank rail.
Implementation note: the classifier runs on the RAW content text while the
hook receives the view's body lines — a small adapter maps the
classification onto view lines and MUST defensively bail to `null` (plain
rendering) on any count mismatch (e.g. truncation or pre-wrap differing
from the classified text), so a desync can never produce a misaligned rail.

Invariants accompanying the hook:

1. **`setContent` change-equality includes styler identity — with stable
   references** — toggling `hashlineAnchors` with an identical body must
   still invalidate (`result.ts:279-287` early-return), but steady-state
   renders must hit the identity-equality cache. Export a small set of
   **module-level styler functions** keyed by (toolName, mode-leniency) from
   `hashline.ts`, so a config toggle changes *which stable reference* is
   passed (identity check fires → repaint) while repeated renders of the
   same config pass the same reference (identity check holds → cache hit).
   Do NOT construct a fresh closure per render — a per-render closure
   defeats the view cache and re-wraps every body per paint. The reuse path
   matters too: `renderExpandedToolResult` recycles `lastComponent` via
   `isExpandedToolIoView` (`result.ts:678-687`), so the styler must be passed
   on **both** construct and reuse paths (or explicitly cleared), else a
   read-styler could leak onto a recycled bash view.
2. **One shared wrap-plan, not three** — the truncation pre-decision
   (`bodyExceedsLineLimit`, `result.ts:496-524`) duplicates `pushBody`'s wrap
   logic; adding a rail introduces a third site that must agree on effective
   width (`bodyWidth − railWidth`). Extract a shared wrap-plan helper used by
   both, scoped to the **output** call only — the Input section never gets a
   styler.
3. **Output body rows never gain `│`** — footer attribution distinguishes
   input vs output by `line.includes("│")` (`result.ts:316-317`); the rail
   lives inside the existing output tree-prefix (`"  "`) structure.

A new module `extensions/renderer/tool/hashline.ts` exports:

- `classifyHashlineBody(text, { grepLenient }): HashlineBody | null` (D1);
- `formatRailWidth(lines)`, `formatRail(line, width)`, `stripPrefix(line)`.

Wiring (`default-mode.ts`, expanded-result path `:343-351`): pass the
styler when `toolName` is `read`/`grep`, config allows it, and detection
succeeds — **but classify the RAW content, never the details-augmented
body**. The wiring point's body is `textFromResult(result, expanded=true)`,
which appends `\nDetails:\n<inspect(details)>` whenever a structured
details object exists — and upstream `read`/`grep` results ALWAYS carry one
(`read.ts:240` `{truncation, snapshotId, nextOffset?}`, `grep.ts:332/422`
`{matches, files, truncated}`), so classifying that body fails for every
real result and the rail never renders. Read config from the **live
config getter** on every render (not a captured snapshot); classify
`rawTextFromResult(result)`; if a `Details:` suffix would be shown, render
it as plain dimmed rows after the styled body (or pass the body split
before the suffix). The Input section is untouched.

*Alternatives considered*: (a) pre-stripping prefixes from the body text —
rejected: loses anchors and breaks `setContent` identity; (b) a dedicated
`HashlineIoView` — rejected: duplicates truncation/show-more/hover/mouse
machinery (`matchShowMoreLine`, `showMoreHeaderRows`, `withIoViewMarkers`,
`ioViewInvalidators`); a hook keeps one implementation.

### D3: Render-time label policy for edit diffs — flag and width move together

Inside `renderEditDiffResult`'s `render()` closure, after
`resolveDiffPresentationMode` picks the mode:

```ts
const showHashlineAnchors =
  live.hashlineAnchors !== "off" &&
  options.expanded === true &&
  mode === "unified" &&
  parsed.entries.some((e) => e.kind === "line" && !!e.hashlineAnchorContent);
const lineNumberWidth = getLineNumberWidth(parsed.entries, showHashlineAnchors);
```

Both leave the construction scope: the flag now depends on the per-render
mode and live config, and the gutter width must match the flag actually in
use (`renderSplit`/`renderUnified` consume it in the `bodyRows` ternary at
`diff-edit-render.ts:166-171`). The existing render-cache key already
includes `expanded` and `mode`; `hashlineAnchors` joins it via
`displayConfigCacheKey` (D5), so no extra key input is needed.

Mechanism note: the fix works because the new flag formula includes
`mode === "unified"`, which makes the flag **false** whenever `renderCompact`
or split runs — so `getCompactLineRenderContent` (which returns
`hashlineAnchorContent` when the flag is true, `diff-parse.ts:435-442`) falls
to plain `entry.content`, and the gutter formatters fall to numeric labels.
Removed lines never expose an anchor label (their upstream hash slot is
empty), so expanded-unified shows `NN#HH` for added/context and old-side line
numbers for removed. The `usesHashlineGutter` divider special-cases
(`diff-layout.ts:99-101`) then only trigger in expanded-unified; split
snapshots must be verified unchanged. Note `renderSplit` can internally fall
back to `toUnifiedFallbackRows` → `renderUnified` when `canRenderSplitLayout`
fails (`diff-layout.ts:655-656`), and `renderUnified` consumes
`ctx.showHashlineAnchors` — but `resolveDiffPresentationMode` only picks
`"split"` when `canRenderSplitLayout(safeWidth)` is already true
(`diff-edit-render.ts:117` passes the same predicate), so that internal
fallback is unreachable when `mode === "split"` and no anchor leaks into a
split render. **Summary** layout (`resolveDiffPresentationMode` returns
`"summary"` below the minimum diff width) renders only aggregate stats via
`buildDiffSummaryText` — it has no gutter and no per-line content, so no
label policy applies there.

Parser-side companion (D3.1): when the diff is hashline-annotated — gate
hardened beyond "≥1 anchor line" to ALSO require no `@@` hunk headers and
no `diff --git`/`+++ `/`--- ` file headers (upstream `generateDiffString`
emits none, so a standard unified diff whose *content* merely looks like
`+NN#HH:` anchors — e.g. editing docs about this very feature — cannot
trigger the strip) — `parseCanonicalDiffLine` recognizes two extra shapes:

1. Removed lines `-<padded NN><pad><content>` with the pad width derived
   EXACTLY from sibling anchor lines (all `+NN#HH:`/`␣NN#HH:` lines share
   one hash length; pad = hashLength + 2, default 4). An exact-width
   match, never a greedy ` {4,6}` range: the pad and real leading
   indentation are contiguous space runs, and a greedy range strips
   indentation from indented removed content (verified: pad 4 + 2-space
   indent parses to content with the indent lost).
2. Elision lines — `(lineNumWidth + 2)` spaces followed by `...`, NO
   digits (`` ` ${"".padStart(lineNumWidth, " ")} ...` ``; the earlier
   `␣NN␣...` shape in these docs was a transcription error; the `1+ spaces
   then ...` structure grammar covers it) → meta entries.

*Why render-time?* Layout mode is width-dependent; a component constructed
collapsed must not lock in anchor labels after expansion or a terminal
resize.

### D4: Compact edit stats — edit-only zero-suppression (no re-scan fallback)

In `compactEditWriteLine`, display `(+A -D)` for `edit` only when
`countEditDiffStats(details)` returns **non-zero total changes**. When the
parse succeeds but reports `added + removed === 0`, omit the stats — never
render a false `(+0 -0)` from a payload that parses to zero.

**Why no re-scan fallback:** `countEditDiffStats` already parses the very
same `result.details.diff` string that any fallback would re-scan
(`safeGetDiff` returns `details.diff`, `diff-edit-render.ts:40-45`), with
the same `+`/`-`/`+++`/`---` classification rules. The two can never
diverge — verified empirically: manual `^[+-](?!..)` counting on a real
upstream diff returns identical counts to `parseDiff` (2 vs 2 on a 1-add
1-remove diff). The previously-planned regex re-scan was therefore
unreachable machinery, and its spec scenario ("stats recovered from the
details diff string") described an impossible state.

**Why not blanket zero-suppression:** `write` computes stats from a real
content comparison (`countWriteDiffStats`), where zero is truthful — the
existing test `tests/compact-mode.test.ts:748` asserts `write b.ts (+0 -0)`
still shows. The suppression rule is `edit`-only. (The round-2/3 `undefined`
and zero-trigger conditions remain as the "missing/unparseable diff" arm:
stats stay omitted when the parse yields nothing usable.)

**Historical note:** the earlier fallback design read
`textFromResult(result, …)` — dead code twice over: the model-facing text
carries no `+`/`-` lines (only the anchors block), and the details-inclusive
text `inspect`s the structured details object, escaping newlines and
splitting the diff into `+`-concatenated fragments (verified: `^[+\-]` matches
0 lines in the inspected blob). Reading `details.diff` directly was the
right instinct, but still re-scans the same string `parseDiff` already
counted — so the only remaining real fix is suppression, not re-scan.

### D5: Config as a tri-state, threaded through every config layer

`hashlineAnchors: "auto" | "on" | "off"` (default `"auto"`) added to:

1. `ToolDisplayConfig` + `DEFAULT_TOOL_DISPLAY_CONFIG` (typed display config),
2. `Config` + `DEFAULT_CONFIG` (persisted shape),
3. `normalizeConfig` (else `updateConfig` silently drops it on first write),
4. `getToolDisplayConfig` (the live getter consumers pass down),
5. `displayConfigCacheKey` (else toggling leaves cached diff rows stale),
6. `/ccstyle` panel Diff tab via the existing cycle-control pattern
   (`panel.ts:618-628`, follow `diffWordWrapSetting` at `:323-331`/`:531-536`).

Semantics, grounded in the verified grep shape:

- `"auto"` — strict three-kind detection (D1).
- `"on"` — lenient for `grep` only: unclassifiable non-anchor lines within
  an otherwise-anchored grep body (malformed scaffolding) render as plain
  dimmed rows instead of degrading the body to plain. A bare all-anchor
  region already passes strict `"auto"` (nothing missing to tolerate), so
  the delta is malformed-scaffolding-only. `"on"` has no extra effect for
  `read`; the `/ccstyle` panel description should note that.
- `"off"` — short-circuits every hashline code path: read/grep styler wiring
  and the D3 diff flag alike.

## Risks / Trade-offs

- [False-positive detection on content that coincidentally matches the
  grammar] → Strict every-line-classified rule + alphabet restriction + narrow
  advisory/structure grammars make this vanishingly rare; `off` gives an
  escape hatch; worst case is cosmetic.
- [Hash length 3–4 configured mid-session makes stale transcript anchors
  inconsistent width] → Detection and rail width accept 2–4 per line and size
  the rail per body, matching upstream's "detectors must accept all supported
  lengths" guidance.
- [Performance: extra regex pass over large read bodies every render] →
  Detection runs once per body (construction/`setContent`), result cached on
  the view; regexes are anchored line-level patterns, O(lines).
- [grep scaffolding varies (truncation summary, single-file `1 match in 1
  file.`)] → The structure grammar covers the summary's optional
  ` (truncated at L)` suffix and singular/plural; anything else degrades the
  body to plain rendering, never an error.
- [Upstream pi-hashline-edit changes its output format] → Integration is
  textual and version-tolerant; a format break degrades to plain rendering,
  never to an error.
- [Compact-mode users expect rails after reading the feature list] →
  Documented scope limitation; native rendering keeps prefixes fully usable,
  and compact edit diffs/stats still benefit from this change.

## Migration Plan

Purely additive; no migration. Rollout: feature lands behind `auto` default —
users without pi-hashline-edit see zero change; users with it immediately get
the new rendering. Rollback = revert commit or set `hashlineAnchors: "off"`.

## Open Questions

- ~~Compact-mode read/grep rails~~ — **resolved: descoped** (native renderer
  is a deliberate compact-mode design decision; see Non-Goals).
- ~~grep marker grammar~~ — **resolved**: verified upstream shape has no
  per-line markers; structural lines are `path:` / ` ...` / `---` /
  summary. Grammar is pinned in D1 and the spec.
- ~~Removed-line anchor labels in expanded-unified~~ — upstream removed lines
  have no hash, so they show old-side line numbers. **Resolved, with a twist
  found in round-5 empirical verification**: numbers are right, but the
  parser keeps the `-NN` + padding inside `entry.content` (B1) — the fix is a
  hashline-aware removed-line strip in the parser (spec'd in the label-policy
  requirement), not just a label policy.
- ~~Elision lines as meta rows~~ — **resolved (W1)**: today they parse as
  context line entries; the parser change (B1) also classifies spaces-only
  elision lines (no digits — an earlier `␣NN␣...` shape in these docs was
  a transcription error) as meta rows when the diff is hashline-annotated.
