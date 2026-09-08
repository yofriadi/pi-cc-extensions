# Hashline Tool Rendering — Delta Spec

Delta for new capability `hashline-tool-rendering`. This change is purely
presentational: it never alters tool arguments, results, or the model-facing
transcript — only how `read` / `grep` / `edit` outputs are drawn in the TUI.

**Mode scope**: anchor-rail rendering of `read`/`grep` results applies to
ccstyle mode `on` only. In compact mode, expanded read/grep results
deliberately use the native Pi renderer, which keeps hashline prefixes
visible and usable; this change does not alter that path. The edit-diff
label policy, the compact edit-stats fallback, and the config option apply
to both modes.

**Upstream reference** (verified against pi-hashline-edit source): a hashline
anchor is `NN#HH:` where `HH` is drawn from the alphabet `ZPMQVRWSNKTXJBYH`,
length 2 by default and user-configurable to 2–4. The renderer treats anchors
as opaque labels and never re-computes hashes.

## ADDED Requirements

### Requirement: Hashline output detection

The system SHALL detect hashline-formatted tool result bodies using a strict
parser, before any specialized rendering is attempted.

Every parsed line is classified into exactly one kind:

- **anchor** — a content line carrying a hashline anchor, matching
  `^(\s*\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):(.*)$`.
- **structure** — a non-content scaffolding line: a blank line, a grep file
  header (`<path>:`), a grep range separator (a run of one or more spaces
  followed by `...`; upstream emits a constant 4-space separator, and anchor
  left-padding is region-end-width-relative, NOT separator-aligned), a grep
  file separator (`---`), or a grep summary line (`N match(es) in M file(s).`
  — singular/plural on both words — with optional ` (truncated at L)`).
- **advisory** — a bracketed tool notice matching a narrow verb-led grammar
  whose leading token is one of `Showing`, `Line N exceeds`, `Offset N`, or
  `Non-UTF-8`. (Upstream emits no advisory beginning with `Truncated`; grep's
  truncation marker is the lowercase ` (truncated at L)` summary suffix.)

A body qualifies as hashline-formatted only when it contains **at least one**
anchor line and **every** line of the body classifies as anchor, structure,
or advisory. Detection MUST NOT depend on tool name alone, on the presence of
pi-hashline-edit in the process, or on computing any content hash.

`read` output consists of anchor lines plus optional advisories. `grep`
output (upstream-verified shape) consists of per-file blocks: a `<path>:`
header, one or more hashline regions separated by ` ...` lines, a trailing
`---`, and a final summary line. Grep carries **no** per-line `+`/`-`/`:`
/`|` match markers — anchors are left-padded line numbers (padded to each
region's end-line width, as in `read`).

Detection MUST operate on the raw content text only — the result's
`content` text blocks — NEVER on the details-augmented expanded body.
`textFromResult(result, expanded=true)` appends `\nDetails:\n<inspect(details)>`
whenever a structured details object exists, and upstream `read`/`grep`
results ALWAYS carry one (`{truncation, snapshotId, nextOffset?}` /
`{matches, files, truncated}`), so the details-augmented body fails the
every-line classifier for every real hashline result — the rail would never
render. The classifier input is `rawTextFromResult(result)`; if a `Details:`
suffix is present in the body passed to the view, it renders as plain dimmed
rows appended after the styled body (never silently dropped — the Details
block is visible today and stays visible).

#### Scenario: Detect a plain hashline read body

- **WHEN** an expanded `read` result body contains only lines like
  ` 8#VR:function hello() {`, ` 9#KT:  console.log("world");` and a trailing
  `[Showing lines 8-200 of 400. Use offset=201 to continue.]` notice
- **THEN** the body is classified as hashline-formatted

#### Scenario: Detect a real grep body

- **WHEN** an expanded `grep` result body contains
  `src/a.ts:` then `9#VR:foo()` then ` ...` then `40#KT:bar()` then
  `---` then `2 matches in 1 file.`
- **THEN** the body is classified as hashline-formatted, the structural lines
  are recognized as scaffolding, and the anchor lines drive the rail

#### Scenario: Reject mixed or plain content

- **WHEN** a result body contains any line that classifies as none of
  anchor / structure / advisory (e.g. raw-mode read output, ordinary prose,
  or a corrupt line)
- **THEN** the body is classified as plain and rendered by the existing
  code path unchanged

#### Scenario: Reject an empty body

- **WHEN** a result body contains zero anchor lines (empty, or only blank /
  advisory / structure lines)
- **THEN** the body is classified as plain (no phantom anchor rail)

#### Scenario: Reject near-miss hash characters

- **WHEN** a line looks like `12#AB:content` (characters outside the
  hashline alphabet) or `12#Z:content` (hash shorter than 2 characters)
- **THEN** the body is classified as plain

#### Scenario: Tolerate the Non-UTF-8 advisory

- **WHEN** a hashline `read` body ends with
  `[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
- **THEN** the body is still classified as hashline-formatted and the notice
  renders as an advisory line

#### Scenario: Classification ignores the Details suffix

- **WHEN** a real upstream-shaped `read` result (content = hashline anchors,
  details = `{truncation, snapshotId, nextOffset?}`) is expanded in mode `on`
- **THEN** the classifier runs on the raw content text only; the `Details:`
  block appended by `textFromResult(result, expanded=true)` does not defeat
  classification, and it renders as plain dimmed rows after the styled body

### Requirement: Anchor-rail rendering for expanded read/grep results

When a `read` or `grep` tool result is expanded in ccstyle mode `on` and its
output body is classified as hashline-formatted, the system SHALL render the
Output section as two columns for anchor lines:

- a right-aligned, dimmed **anchor rail** containing the `NN#HH` prefix, and
- the line content with the `LINE#HASH:` prefix stripped, as the **only**
  full-width wrapping column.

The anchor rail MUST NOT wrap; only content wraps, and wrapped continuation
rows MUST align with the content column (blank rail). Long content lines MUST
NOT be hard-truncated earlier than the existing plain rendering would
truncate them.

Structure lines (grep `path:` headers, ` ...` range separators, `---`, summary) and
advisory notices MUST be rendered as ordinary dimmed body lines without a
rail entry. The rail MUST be drawn inside the existing Output tree-prefix
structure: output body rows MUST NOT introduce the `│` continuation glyph,
which is reserved for the Input section (show-more footer attribution depends
on this).

Truncation accounting MUST stay consistent: the show-more pre-decision and
the actual body rendering MUST agree on the effective content width (body
width minus rail width) so a truncation footer is drawn exactly when hidden
rows exist, and never when they do not.

Non-hashline bodies, error results, and partial results MUST render exactly
as before.

#### Scenario: Expanded read shows anchor rail

- **WHEN** a `read` result is expanded in mode `on` and its body is
  hashline-formatted
- **THEN** each anchor line is drawn as `<dim NN#HH> <content>`, the hash
  prefix does not occupy the content wrap width, and the content column is
  aligned across all rows

#### Scenario: Wrapped continuation rows keep alignment

- **WHEN** a hashline content line exceeds the available body width
- **THEN** it wraps within the content column and continuation rows carry a
  blank anchor rail so the left edge of content stays aligned

#### Scenario: Advisory and structure lines render without rail

- **WHEN** the body contains a bracketed truncation notice or grep
  scaffolding (`path:`, ` ...`, `---`, summary)
- **THEN** those lines render as dimmed body lines with no anchor rail entry

#### Scenario: Truncation footer consistency

- **WHEN** a hashline body exceeds the expanded-output line limit only after
  the rail reduces the effective content width
- **THEN** the show-more footer is drawn, and conversely no footer is drawn
  when every wrapped row is visible

#### Scenario: Plain read output unchanged

- **WHEN** a `read` result was produced with `raw: true` (no hashline
  prefixes) or by the built-in read tool
- **THEN** the expanded Output section renders identically to current
  behavior

#### Scenario: Compact mode uses native rendering

- **WHEN** a `read` or `grep` result is expanded in compact mode
- **THEN** the native Pi renderer draws the result exactly as before this
  change (prefixes included), with no anchor rail

### Requirement: Edit diff hashline label policy

The rich `edit` diff renderer SHALL parse hashline-annotated diff lines as
produced by pi-hashline-edit's `details.diff`:

- **added / context** lines: `+NN#HH:content` and `␣NN#HH:content`
  (prefix, padded line number, `#`, hash, `:`, content);
- **removed** lines: `-NN` followed by `hashLength + 2` spaces then content
  — the hash slot is **blank padding that replaces `#HH:` entirely**, so
  removed lines carry **no** `#` or `:`.

The renderer SHALL retain per-side line numbers for every entry. Added and
context lines expose an anchor label (`NN#HH`); removed lines do not (their
hash slot is empty). **Removed-line content MUST be stripped of its `-NN` +
padding prefix at parse time**: upstream emits removed lines as
`-<padded NN><hashLength + 2 spaces><content>`, but the parser's
`HASHLINE_ANCHOR_LINE_PATTERN` requires `#`/`:`, so today removed lines fall to
the generic `-` branch and keep the entire number + padding inside
`entry.content` — duplicating the gutter number and misaligning removals
against cleanly-parsed context/add rows in every layout, ungated by any
config. When the diff is hashline-annotated, the parser SHALL derive the
exact blank-hash pad width from sibling anchor lines in the same diff (all
`+NN#HH:`/`␣NN#HH:` lines share one hash length, so `pad = hashLength + 2`
is knowable — default 2→4 spaces) and recognize the removed-line shape with
an **exact-width** match `^-<padded NN> {pad}<content>` (NOT a greedy
` {4,6}` range: the pad and a removed line's real leading indentation are
contiguous space runs, and a greedy range match strips real indentation from
indented removed content). Parse the old-side number, keep only the real
content in `entry.content`, with **no** `hashlineAnchorContent` (removed lines
expose no anchor label). Whole-file replacements (no preceding context
anchors) MUST still get correct old-side numbers. Elision lines — a run of
spaces followed by `...` (upstream emits `(lineNumWidth + 2)` spaces, NO
digits: `` ` ${"".padStart(lineNumWidth, " ")} ...` ``; the earlier
`␣NN␣...` shape was a transcription error) — are hashline-specific non-line
entries and SHALL be recognized as meta rows (today they fall through as
context line entries whose content is leftover spaces + `...`, inflating
`stats.context`).

Label policy, computed at render time with the live layout mode and config:

- **Collapsed, split, and compact (`renderCompact`) layouts**: the gutter
  SHALL show real line numbers and content SHALL be plain — no anchor labels,
  no `NN#HH:` prefixes, and no leftover number/padding from the diff prefix.
  (**Summary** layout, chosen below the minimum diff width, renders only
  aggregate `(+A -D)` stats via `buildDiffSummaryText` — it has no gutter and
  no per-line content, so no label policy applies.)
- **Expanded unified layout**: the gutter SHALL show the anchor label
  (`NN#HH`) for added/context entries that carry one, falling back to line
  numbers for removed lines and entries without an anchor; the gutter width
  MUST be computed with the same per-render flag so it accommodates the
  widest visible label.
- **`hashlineAnchors: "off"`**: anchor labels MUST NOT appear in any layout,
  regardless of payload.

Entries without hashline data (standard unified diffs, built-in edit tool)
MUST render exactly as before in all layouts.

#### Scenario: Collapsed rich diff shows line numbers

- **WHEN** an `edit` result with a hashline diff payload is rendered
  collapsed
- **THEN** the gutter shows numeric line numbers and no `#HH` labels appear

#### Scenario: Expanded unified diff shows anchor labels

- **WHEN** the same `edit` result is expanded in unified layout
- **THEN** added/context entries show `NN#HH` gutter labels aligned to the
  widest label, and removed entries show their old-side line number (no
  anchor)

#### Scenario: Split layout keeps line numbers even when expanded

- **WHEN** an `edit` result with a hashline diff payload is expanded and the
  terminal is wide enough for split layout
- **THEN** both panes show numeric line numbers, not anchor labels

#### Scenario: Narrow-width expanded diff falls back to compact presentation with plain content

- **WHEN** an `edit` result with a hashline diff payload is expanded but the
  terminal is too narrow for unified/split, forcing compact presentation
- **THEN** content renders plainly with line numbers and no inline `NN#HH:`
  prefixes

#### Scenario: Off disables anchor labels in diffs

- **WHEN** `hashlineAnchors` is `"off"` and an `edit` result with a hashline
  diff payload is expanded in unified layout
- **THEN** the gutter shows numeric line numbers

#### Scenario: Standard diff unaffected

- **WHEN** an `edit` result carries a conventional unified diff without
  hashline annotations
- **THEN** all layouts render exactly as before this change

#### Scenario: Hashline diff without hunk headers

- **WHEN** a hashline diff payload has no `@@` hunk headers (implicit hunks)
- **THEN** per-side line numbers are seeded from the parsed anchor line
  numbers and the label policy applies identically

#### Scenario: Removed-line content is stripped

- **WHEN** a hashline diff payload contains a removed line emitted as
  `-<padded NN><hashLength + 2 spaces><content>` (e.g. `-21    const x = 20;`)
- **THEN** the parsed entry's `content` is exactly the real file content
  (`const x = 20;`), the old-side line number is carried in the gutter
  metadata, and no number/padding remains in the rendered content cell

### Requirement: Compact-mode edit diff stats fallback

When compact mode needs `(+A -D)` stats for an `edit` result, the existing
details-diff parser (`countEditDiffStats` → `parseDiff`) already scans the
**same** `result.details.diff` string that any re-scan would read, with the
same `+`/`-`/`+++`/`---` classification rules. A separate re-scan fallback
therefore has **no reachable effect**: if the structured parse yields zero
change lines, so does any re-scan of the identical string (verified
empirically — manual `^[+-](?!..)` counting on a real upstream diff returns
the same counts as `parseDiff`). The system SHALL instead apply an
**edit-only zero-suppression rule**: when the structured parse succeeds but
reports `added + removed === 0`, compact mode MUST omit the `(+A -D)` stats
for `edit` (showing no stats rather than a false `(+0 -0)`). The rule MUST
NOT apply to `write`, whose stats are computed from a real content
comparison (`countWriteDiffStats`) where zero is truthful — existing test
`tests/compact-mode.test.ts:748` asserts `write b.ts (+0 -0)` still shows.
Stats MUST remain omitted when the parse yields no usable stats at all
(missing/unparseable diff), preserving the existing unknown-stats behavior.
The system MUST NOT display `(+0 -0)` for an `edit` result whose details
diff actually contains change lines.

#### Scenario: Zero-change edit omits stats

- **WHEN** an `edit` result's structured details-diff parse succeeds and
  reports zero added and zero removed change lines
- **THEN** the compact summary shows no `(+A -D)` stats (no false
  `(+0 -0)` from a payload that parses to zero)

#### Scenario: Unknown stats stay unknown

- **WHEN** an `edit` result's details diff is missing or entirely unparseable
  (no countable change lines anywhere)
- **THEN** the summary omits stats rather than displaying `(+0 -0)`

### Requirement: `hashlineAnchors` configuration

The system SHALL provide a `hashlineAnchors` config option in
`claude-code-style.json` and the `/ccstyle` panel (Diff tab) with three
values:

- `"auto"` (default) — hashline rendering activates only when
  hashline-formatted output is strictly detected,
- `"on"` — lenient handling for `grep` bodies: unclassifiable non-anchor
  lines within an otherwise-anchored grep body (MALFORMED scaffolding —
  e.g. a corrupt `path:` variant) render as plain dimmed rows instead of
  degrading the whole body to plain. Note a bare all-anchor region with NO
  scaffolding already passes strict `"auto"` detection (nothing is missing
  to be tolerated), so `"on"` differs from `"auto"` only for malformed
  scaffolding lines. This leniency is a config-driven, post-detection
  policy gated on `toolName === "grep"` (consistent with detection itself
  never depending on tool name alone) — it is never applied to `read`
  bodies, since a scaffolding-less grep body is textually indistinguishable
  from a read body. For `read`, `"on"` behaves identically to `"auto"`.
- `"off"` — all hashline-specific rendering is disabled; every output uses
  the plain code paths (no read/grep anchor rail, no diff anchor labels).

The option SHALL be part of the live-resolved display config, and config
changes MUST take effect on the next render — including invalidating
already-rendered cached diff rows whose label policy depends on the option.
Unknown/invalid values MUST fall back to `"auto"`, and the option MUST
survive config round-trips (load → panel edit → save) without being dropped.

#### Scenario: Default auto behavior

- **WHEN** no `hashlineAnchors` key exists in the config
- **THEN** hashline-formatted outputs render with anchor rails and plain
  outputs render plainly

#### Scenario: On tolerates malformed grep scaffolding

- **WHEN** `hashlineAnchors` is `"on"` and a `grep` body has valid anchor
  lines plus a scaffolding line that matches no structure grammar (e.g. a
  corrupt `path:` variant)
- **THEN** the anchor region is rail-rendered with the malformed line
  rendered as a plain dimmed row (whereas `"auto"` would reject the whole
  body as plain). A bare all-anchor region with no scaffolding at all
  passes under both `"auto"` and `"on"` (no delta).

#### Scenario: Off disables everything

- **WHEN** `hashlineAnchors` is `"off"` and a hashline-formatted `read`
  result is expanded in mode `on`
- **THEN** the Output section renders the raw text (prefixes included)
  through the existing plain path

#### Scenario: Live toggle repaints

- **WHEN** the user changes `hashlineAnchors` in `/ccstyle` while a hashline
  `read` result and a hashline `edit` diff are on screen
- **THEN** both visible renderings switch between anchor-aware and plain
  styles without a `/reload`

#### Scenario: Config round-trip preserves the option

- **WHEN** `hashlineAnchors` is set via the panel and the config file is
  subsequently loaded and saved again
- **THEN** the value persists unchanged
