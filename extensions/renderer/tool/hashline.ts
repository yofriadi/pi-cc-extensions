/**
 * Hashline (`LINE#HASH:` anchor) detection and rail styling.
 *
 * pi-hashline-edit overrides pi's read/edit (and optionally grep) tools and
 * prefixes every content line with a `NN#HH:` anchor (alphabet
 * `ZPMQVRWSNKTXJBYH`, length 2–4). Detection is purely textual: a body
 * qualifies only when at least one line is an anchor and every line
 * classifies as anchor, grep scaffolding, or a bracketed advisory. Anchors
 * are opaque labels — hashes are never recomputed.
 *
 * Verified upstream shapes:
 * - read: every line is `NN#HH:content` (empty lines carry a hash too), plus
 *   optional bracketed advisories.
 * - grep: per-file blocks — `<path>:`, hashline regions separated by a
 *   `    ...` range separator, `---` file separators, and an
 *   `N match(es) in M file(s).` summary. There are NO per-line match markers.
 */

/** `NN#HH:content` — optional left-padded line number, strict-alphabet hash, 2–4 chars. */
export const HASHLINE_ANCHOR_LINE_PATTERN = /^(\s*\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):(.*)$/;

// Bracketed, verb-led read advisories. Upstream emits no `Truncated`-led
// advisory; grep truncation is the lowercase ` (truncated at L)` summary suffix.
const HASHLINE_ADVISORY_LINE_PATTERN =
	/^\[(?:Showing\b|Line \d+ exceeds\b|Offset \d+\b|Non-UTF-8\b).*\]$/;

// Grep range separator: upstream emits a constant 4-space `    ...`, but anchor
// left-padding is region-end-width-relative, NOT separator-aligned, so any run
// of one or more spaces is accepted.
const HASHLINE_RANGE_SEPARATOR_PATTERN = /^ +\.\.\.$/;

// `N match(es) in M file(s).` — singular/plural on both words, optional truncation suffix.
const HASHLINE_SUMMARY_LINE_PATTERN =
	/^\d+ match(?:es)? in \d+ files?\.(?: \(truncated at \d+\))?$/;

// Grep per-file header `<path>:` — non-empty, no `#`, no leading whitespace.
const HASHLINE_FILE_HEADER_PATTERN = /^[^\s#][^#]*:$/;

export type HashlineLineKind = "anchor" | "structure" | "advisory" | "plain";

export interface HashlineLine {
	kind: HashlineLineKind;
	/** Trimmed line-number digits (anchor lines only). */
	line?: string;
	/** Hash characters between `#` and `:` (anchor lines only). */
	hash?: string;
	/** Content after the anchor prefix (anchor lines only). */
	content?: string;
}

export interface HashlineClassifyOptions {
	/**
	 * Lenient mode (config `hashlineAnchors: "on"` for grep): unclassifiable
	 * non-anchor lines render as plain rows instead of rejecting the body.
	 * A bare all-anchor region already passes strict classification, so
	 * leniency only matters for malformed scaffolding lines.
	 */
	grepLenient?: boolean;
}

function classifyHashlineLine(line: string): HashlineLine | null {
	const anchor = line.match(HASHLINE_ANCHOR_LINE_PATTERN);
	if (anchor) {
		return {
			kind: "anchor",
			line: (anchor[1] ?? "").trim(),
			hash: anchor[2] ?? "",
			content: anchor[3] ?? "",
		};
	}
	if (HASHLINE_ADVISORY_LINE_PATTERN.test(line)) {
		return { kind: "advisory" };
	}
	if (
		line.trim() === "" ||
		HASHLINE_RANGE_SEPARATOR_PATTERN.test(line) ||
		line === "---" ||
		HASHLINE_SUMMARY_LINE_PATTERN.test(line) ||
		HASHLINE_FILE_HEADER_PATTERN.test(line)
	) {
		return { kind: "structure" };
	}
	return null;
}

function splitHashlineBodyLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * Classify a hashline candidate body, line by line. Returns null unless at
 * least one anchor line exists and every line classifies — strictly as
 * anchor/structure/advisory, or (lenient mode only) with unclassifiable
 * non-anchor lines tolerated as `plain`.
 */
export function classifyHashlineLines(
	lines: readonly string[],
	options: HashlineClassifyOptions = {},
): HashlineLine[] | null {
	const grepLenient = options.grepLenient === true;
	const classified: HashlineLine[] = [];
	let anchorCount = 0;
	for (const line of lines) {
		const item = classifyHashlineLine(line);
		if (item) {
			if (item.kind === "anchor") anchorCount++;
			classified.push(item);
			continue;
		}
		if (!grepLenient) return null;
		classified.push({ kind: "plain" });
	}
	if (anchorCount === 0) return null;
	return classified;
}

/** Body-level classifier over raw text. Never feed it a Details-augmented body. */
export function classifyHashlineBody(
	text: string,
	options: HashlineClassifyOptions = {},
): HashlineLine[] | null {
	return classifyHashlineLines(splitHashlineBodyLines(text), options);
}

/** Widest `NN#HH` label among anchor lines — the fixed rail column width. */
export function formatRailWidth(lines: readonly HashlineLine[]): number {
	let width = 0;
	for (const item of lines) {
		if (item.kind !== "anchor") continue;
		const length = `${item.line ?? ""}#${item.hash ?? ""}`.length;
		if (length > width) width = length;
	}
	return width;
}

/** Right-aligned rail label for one anchor line. */
export function formatRail(line: HashlineLine, width: number): string {
	const label = `${line.line ?? ""}#${line.hash ?? ""}`;
	return label.length >= width ? label : label.padStart(width, " ");
}

/** Strip the `NN#HH:` anchor prefix; non-anchor lines pass through unchanged. */
export function stripPrefix(line: string): string {
	const anchor = line.match(HASHLINE_ANCHOR_LINE_PATTERN);
	return anchor ? (anchor[3] ?? "") : line;
}

export interface HashlineOutputRow {
	/** Right-aligned `NN#HH` rail label, or "" for full-width plain rows. */
	rail: string;
	content: string;
}

export type HashlineOutputStyler = (lines: string[]) => HashlineOutputRow[] | null;

/**
 * Style expanded-view body lines. `textFromResult(result, expanded=true)`
 * appends a `Details:` block after the content; everything from the first
 * bare `Details:` line renders as plain rows, so the suffix stays visible
 * without defeating classification of the hashline head.
 */
function styleHashlineLines(lines: string[], grepLenient: boolean): HashlineOutputRow[] | null {
	const detailsIndex = lines.indexOf("Details:");
	const head = detailsIndex >= 0 ? lines.slice(0, detailsIndex) : lines;
	const tail = detailsIndex >= 0 ? lines.slice(detailsIndex) : null;
	const classified = classifyHashlineLines(head, { grepLenient });
	if (!classified || classified.length !== head.length) return null;
	const railWidth = formatRailWidth(classified);
	const rows: HashlineOutputRow[] = [];
	for (let index = 0; index < classified.length; index++) {
		const item = classified[index]!;
		if (item.kind === "anchor") {
			rows.push({ rail: formatRail(item, railWidth), content: item.content ?? "" });
		} else {
			rows.push({ rail: "", content: head[index] ?? "" });
		}
	}
	if (tail) {
		for (const line of tail) rows.push({ rail: "", content: line });
	}
	return rows;
}

const hashlineOutputStylers = new Map<string, HashlineOutputStyler>();

/**
 * Module-level stable stylers keyed by toolName + leniency. Steady-state
 * renders must pass the SAME reference so ExpandedToolIoView's identity
 * cache holds; a config toggle changes which reference is passed, firing
 * the invalidation. Never construct a fresh closure per render.
 */
export function getHashlineOutputStyler(
	toolName: string,
	grepLenient: boolean,
): HashlineOutputStyler {
	const key = `${toolName} ${grepLenient ? "lenient" : "strict"}`;
	let styler = hashlineOutputStylers.get(key);
	if (!styler) {
		styler = (lines: string[]) => styleHashlineLines(lines, grepLenient);
		hashlineOutputStylers.set(key, styler);
	}
	return styler;
}
