import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./diff-text.ts";

export type DiffLineKind = "add" | "remove" | "context";
export type DiffEntryKind = "line" | "omission" | "meta" | "hunk" | "file";

export interface DiffLineEntry {
	kind: "line";
	lineKind: DiffLineKind;
	oldLineNumber: number | null;
	newLineNumber: number | null;
	fallbackLineNumber: string;
	content: string;
	hashlineAnchorContent?: string;
	raw: string;
	hunkIndex: number;
}

export interface DiffOmissionEntry {
	kind: "omission";
	raw: string;
	hunkIndex: number;
}

export interface DiffMetaEntry {
	kind: Exclude<DiffEntryKind, "line" | "omission">;
	raw: string;
	hunkIndex: number;
}

export type ParsedDiffEntry = DiffLineEntry | DiffOmissionEntry | DiffMetaEntry;

export interface ParsedDiff {
	entries: ParsedDiffEntry[];
	stats: DiffStats;
}

export interface DiffStats {
	added: number;
	removed: number;
	context: number;
	hunks: number;
	files: number;
	lines: number;
}

const CANONICAL_LINE_PATTERN = /^([+\- ])(\s*\d+)\|(.*)$/;
const HASHLINE_ANCHOR_LINE_PATTERN = /^([+\- ])(\s*\d+)#([A-Za-z0-9]+| {2}):(.*)$/;
// Pi still emits space-separated numbered rows, unlike OMP's pipe-delimited format.
const PI_LINE_PATTERN = /^([+\- ])(\s*\d+)\s(.*)$/;
const PI_OMISSION_LINE_PATTERN = /^ {3,}\.\.\.$/;
// Strict hashline gate: only the upstream alphabet, hash slots 2–4 long. The
// loose pattern above still parses legacy shapes for label rendering, but this
// one decides whether removed-line stripping/elision detection may activate.
const HASHLINE_STRICT_ANCHOR_PATTERN = /^([+\- ])(\s*\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):(.*)$/;
// Hashline elision rows: spaces-only prefix then `...` — no digits (upstream
// emits `(lineNumWidth + 2)` spaces; an earlier `␣NN␣...` reading was wrong).
const HASHLINE_ELISION_LINE_PATTERN = /^ +\.\.\.$/;
const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const MIN_LINE_NUMBER_WIDTH = 2;

function toParsedDiffLine(
	prefix: string,
	lineNumber: string,
	content: string,
): {
	lineKind: DiffLineKind;
	lineNumber: string;
	content: string;
} {
	const normalizedLineNumber = lineNumber.trim();
	if (prefix === "+") {
		return { lineKind: "add", lineNumber: normalizedLineNumber, content };
	}
	if (prefix === "-") {
		return { lineKind: "remove", lineNumber: normalizedLineNumber, content };
	}
	return { lineKind: "context", lineNumber: normalizedLineNumber, content };
}

const hashlineRemovedPatterns = new Map<number, RegExp>();

function hashlineRemovedPattern(pad: number): RegExp {
	let pattern = hashlineRemovedPatterns.get(pad);
	if (!pattern) {
		pattern = new RegExp(`^-(\\s*\\d+) {${pad}}(.*)$`);
		hashlineRemovedPatterns.set(pad, pattern);
	}
	return pattern;
}

/**
 * Hashline-annotated diff gate: ≥1 strict-alphabet anchor line, no `@@` hunk
 * headers, no `diff --git`/`+++ `/`--- ` file headers. Upstream
 * generateDiffString emits none of those, so standard unified diffs whose
 * content merely looks anchor-shaped can never trigger the strip.
 */
function isHashlineAnnotatedDiff(diffText: string): boolean {
	let hasStrictAnchor = false;
	for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
		if (HASHLINE_STRICT_ANCHOR_PATTERN.test(rawLine)) {
			hasStrictAnchor = true;
			continue;
		}
		if (
			rawLine.startsWith("@@") ||
			rawLine.startsWith("diff --git") ||
			rawLine.startsWith("--- ") ||
			rawLine.startsWith("+++ ")
		) {
			return false;
		}
	}
	return hasStrictAnchor;
}

/**
 * Removed-line blank-slot pad width, derived from the diff's own added/context
 * anchors: all upstream anchors share one hash length, so pad = hashLength + 2
 * (default hash length 2 → 4 spaces).
 */
function hashlineRemovedPadWidth(diffText: string): number {
	for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
		const match = rawLine.match(HASHLINE_STRICT_ANCHOR_PATTERN);
		if (match) {
			return (match[3] ?? "").length + 2;
		}
	}
	return 4;
}

function parseCanonicalDiffLine(
	line: string,
	allowPiFormat: boolean,
	hashlineRemovedPad: number | null,
): {
	lineKind: DiffLineKind;
	lineNumber: string;
	content: string;
	hashlineAnchorContent?: string;
} | null {
	const hashlineAnchorMatch = line.match(HASHLINE_ANCHOR_LINE_PATTERN);
	if (hashlineAnchorMatch) {
		const lineNumber = hashlineAnchorMatch[2] ?? "";
		const hash = hashlineAnchorMatch[3] ?? "";
		const content = hashlineAnchorMatch[4] ?? "";
		const parsed = toParsedDiffLine(hashlineAnchorMatch[1] ?? " ", lineNumber, content);
		return {
			...parsed,
			hashlineAnchorContent: `${lineNumber.trim()}#${hash}:${content}`,
		};
	}

	if (hashlineRemovedPad !== null) {
		// Upstream removed lines carry a BLANK hash slot: `-<padded NN>` plus
		// exactly (hashLength + 2) spaces, with no `#`/`:` at all. Match that pad
		// width EXACTLY — the pad and a removed line's real leading indentation
		// are contiguous space runs, and a greedy range would strip true indent
		// from indented removed content.
		const removedMatch = line.match(hashlineRemovedPattern(hashlineRemovedPad));
		if (removedMatch) {
			return toParsedDiffLine("-", removedMatch[1] ?? "", removedMatch[2] ?? "");
		}
	}

	const match =
		line.match(CANONICAL_LINE_PATTERN) ?? (allowPiFormat ? line.match(PI_LINE_PATTERN) : null);
	return match ? toParsedDiffLine(match[1] ?? " ", match[2] ?? "", match[3] ?? "") : null;
}

function toNumber(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function anchorCanonicalLineCursors(
	kind: DiffLineKind,
	parsedNumber: number | null,
	oldLineCursor: number | null,
	newLineCursor: number | null,
	lineNumberDelta: number,
): { oldLineCursor: number | null; newLineCursor: number | null } {
	if (parsedNumber === null) {
		return { oldLineCursor, newLineCursor };
	}

	if (kind === "add") {
		return {
			oldLineCursor,
			newLineCursor: newLineCursor ?? parsedNumber,
		};
	}

	return {
		oldLineCursor: parsedNumber,
		newLineCursor: parsedNumber + lineNumberDelta,
	};
}

function classifyMetaLine(raw: string): DiffMetaEntry["kind"] {
	if (raw.startsWith("@@")) {
		return "hunk";
	}
	if (
		raw.startsWith("diff --git") ||
		raw.startsWith("index ") ||
		raw.startsWith("--- ") ||
		raw.startsWith("+++ ") ||
		raw.startsWith("rename from ") ||
		raw.startsWith("rename to ") ||
		raw.startsWith("new file mode ") ||
		raw.startsWith("deleted file mode ")
	) {
		return "file";
	}
	return "meta";
}

function pushParsedLineEntry(
	entries: ParsedDiffEntry[],
	lineKind: DiffLineKind,
	oldLineNumber: number | null,
	newLineNumber: number | null,
	fallbackLineNumber: string,
	rawLine: string,
	hunkIndex: number,
): void {
	entries.push({
		kind: "line",
		lineKind,
		oldLineNumber,
		newLineNumber,
		fallbackLineNumber,
		content: rawLine.slice(1),
		raw: rawLine,
		hunkIndex,
	});
}

function createOmissionEntry(raw: string, hunkIndex: number): DiffOmissionEntry {
	return {
		kind: "omission",
		raw,
		hunkIndex,
	};
}

function createMetaEntry(raw: string, hunkIndex: number): DiffMetaEntry {
	return {
		kind: classifyMetaLine(raw),
		raw,
		hunkIndex,
	};
}

function ensureImplicitHunk(currentHunk: number): number {
	return currentHunk > 0 ? currentHunk : 1;
}

export function parseDiff(diffText: string): ParsedDiff {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: 0,
		files: 0,
		lines: 0,
	};
	const entries: ParsedDiffEntry[] = [];

	if (!diffText.trim()) {
		return { entries, stats };
	}

	let hunkIndex = 0;
	let oldLineCursor: number | null = null;
	let newLineCursor: number | null = null;
	let lineNumberDelta = 0;
	let hasHunkHeader = false;

	// Hashline-annotated diffs (pi-hashline-edit details.diff): removed lines
	// carry a blank hash slot padded to hashLength + 2, and elisions are
	// spaces-only `...` rows. Both shapes are recognized only behind the gate.
	const hashlineAnnotated = isHashlineAnnotatedDiff(diffText);
	const hashlineRemovedPad = hashlineAnnotated ? hashlineRemovedPadWidth(diffText) : null;
	// Any anchor-shaped row (`NN#hash:`) marks the entire diff as hashline-format:
	// Pi's headerless rows always separate the number from content with a space,
	// so they can never be anchor-shaped themselves. Once such a row exists,
	// the Pi numeric-row fallback must stay off for the whole diff — numeric-
	// looking source text near anchors is content, not a Pi line number.
	const hashlineAnchorRows = diffText
		.replace(/\r/g, "")
		.split("\n")
		.some((line) => HASHLINE_ANCHOR_LINE_PATTERN.test(line));

	for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
		stats.lines++;

		const hunkMatch = rawLine.match(HUNK_HEADER_PATTERN);
		if (hunkMatch) {
			hasHunkHeader = true;
			hunkIndex++;
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			oldLineCursor = toNumber(hunkMatch[1]);
			newLineCursor = toNumber(hunkMatch[3]);
			lineNumberDelta = (newLineCursor ?? 0) - (oldLineCursor ?? 0);
			entries.push({ kind: "hunk", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			stats.files++;
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
			entries.push({ kind: "file", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
		}

		// Pi pads omitted context with a blank line number; it is not a source row.
		if (!hasHunkHeader && PI_OMISSION_LINE_PATTERN.test(rawLine)) {
			entries.push(createOmissionEntry(rawLine, hunkIndex));
			continue;
		}

		// Pi's headerless format is ambiguous both with numeric source text after
		// hunk headers and with hashline diffs — an anchor-shaped row means the format
		// is hashline, never Pi's space-separated numeric rows.
		const canonical = parseCanonicalDiffLine(
			rawLine,
			!hasHunkHeader && !hashlineAnchorRows,
			hashlineRemovedPad,
		);
		if (canonical) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);

			const parsedNumber = toNumber(canonical.lineNumber);
			const anchoredCursors = anchorCanonicalLineCursors(
				canonical.lineKind,
				parsedNumber,
				oldLineCursor,
				newLineCursor,
				lineNumberDelta,
			);
			oldLineCursor = anchoredCursors.oldLineCursor;
			newLineCursor = anchoredCursors.newLineCursor;

			const oldLineNumber = canonical.lineKind === "add" ? null : oldLineCursor;
			const newLineNumber = canonical.lineKind === "remove" ? null : newLineCursor;

			if (canonical.lineKind === "add") {
				stats.added++;
				if (newLineCursor !== null) {
					newLineCursor++;
				}
				lineNumberDelta++;
			} else if (canonical.lineKind === "remove") {
				stats.removed++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				lineNumberDelta--;
			} else {
				stats.context++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				if (newLineCursor !== null) {
					newLineCursor++;
				}
			}

			entries.push({
				kind: "line",
				lineKind: canonical.lineKind,
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: canonical.lineNumber,
				content: canonical.content,
				hashlineAnchorContent: canonical.hashlineAnchorContent,
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.removed++;
			const oldLineNumber = oldLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			lineNumberDelta--;
			pushParsedLineEntry(
				entries,
				"remove",
				oldLineNumber,
				null,
				oldLineNumber !== null ? `${oldLineNumber}` : "",
				rawLine,
				hunkIndex,
			);
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.added++;
			const newLineNumber = newLineCursor;
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			lineNumberDelta++;
			pushParsedLineEntry(
				entries,
				"add",
				null,
				newLineNumber,
				newLineNumber !== null ? `${newLineNumber}` : "",
				rawLine,
				hunkIndex,
			);
			continue;
		}
		// Hashline elisions — upstream emits (lineNumWidth + 2) spaces followed by
		// `...` with NO digits — are non-line entries. Without this they fall into
		// the context branch below and inflate stats.context. Standard diffs
		// (gate closed) keep the previous context-line behavior.
		if (hashlineRemovedPad !== null && HASHLINE_ELISION_LINE_PATTERN.test(rawLine)) {
			entries.push(createMetaEntry(rawLine, hunkIndex));
			continue;
		}

		if (rawLine.startsWith(" ")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.context++;
			const oldLineNumber = oldLineCursor;
			const newLineNumber = newLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			pushParsedLineEntry(
				entries,
				"context",
				oldLineNumber,
				newLineNumber,
				oldLineNumber !== null
					? `${oldLineNumber}`
					: newLineNumber !== null
						? `${newLineNumber}`
						: "",
				rawLine,
				hunkIndex,
			);
			continue;
		}

		entries.push(createMetaEntry(rawLine, hunkIndex));
	}

	if (stats.hunks === 0 && (stats.added > 0 || stats.removed > 0 || stats.context > 0)) {
		stats.hunks = 1;
	}
	if (stats.files === 0) {
		const patchStyleFileHeaders = entries.filter(
			(entry) => entry.kind === "file" && entry.raw.startsWith("+++ "),
		).length;
		if (patchStyleFileHeaders > 0) {
			stats.files = patchStyleFileHeaders;
		} else if (stats.hunks > 0) {
			stats.files = 1;
		}
	}

	return { entries, stats };
}

export function getHashlineAnchorLabel(entry: DiffLineEntry): string | undefined {
	if (!entry.hashlineAnchorContent) {
		return undefined;
	}
	const separatorIndex = entry.hashlineAnchorContent.indexOf(":");
	return separatorIndex >= 0
		? entry.hashlineAnchorContent.slice(0, separatorIndex)
		: entry.hashlineAnchorContent;
}

export function getLineNumberWidth(
	entries: ParsedDiffEntry[],
	showHashlineAnchors = false,
): number {
	let maxWidth = MIN_LINE_NUMBER_WIDTH;

	for (const entry of entries) {
		if (entry.kind !== "line") {
			continue;
		}

		if (showHashlineAnchors) {
			const anchorLabel = getHashlineAnchorLabel(entry);
			if (anchorLabel) {
				maxWidth = Math.max(maxWidth, visibleWidth(anchorLabel));
				continue;
			}
		}

		const candidates = [
			entry.oldLineNumber,
			entry.newLineNumber,
			toNumber(entry.fallbackLineNumber),
		].filter((value): value is number => value !== null);

		for (const candidate of candidates) {
			const digits = `${candidate}`.length;
			if (digits > maxWidth) {
				maxWidth = digits;
			}
		}
	}

	return maxWidth;
}

function formatLineNumber(value: number | null, fallback: string, width: number): string {
	if (value !== null) {
		return `${value}`.padStart(width, " ");
	}
	if (fallback.trim()) {
		return fallback.trim().slice(-width).padStart(width, " ");
	}
	return " ".repeat(width);
}

export function formatLineNumberLabel(
	entry: DiffLineEntry,
	value: number | null,
	fallback: string,
	width: number,
	showHashlineAnchors: boolean,
): string {
	const anchorLabel = showHashlineAnchors ? getHashlineAnchorLabel(entry) : undefined;
	if (anchorLabel) {
		return fitToWidth(anchorLabel, width);
	}
	return formatLineNumber(value, fallback, width);
}

export function getCompactLineRenderContent(
	entry: DiffLineEntry,
	showHashlineAnchors: boolean,
): string {
	return showHashlineAnchors && entry.hashlineAnchorContent
		? entry.hashlineAnchorContent
		: entry.content;
}

export function countDiffLineEntries(entries: readonly ParsedDiffEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "line") count++;
	}
	return count;
}

export function collectDiffStats(
	entries: ParsedDiffEntry[],
	fallbackHunks = 0,
	fallbackFiles = 0,
): DiffStats {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: fallbackHunks,
		files: fallbackFiles,
		lines: entries.length,
	};

	const hunkIndexes = new Set<number>();
	let explicitFileCount = 0;

	for (const entry of entries) {
		if (entry.kind === "line") {
			if (entry.lineKind === "add") {
				stats.added++;
			} else if (entry.lineKind === "remove") {
				stats.removed++;
			} else {
				stats.context++;
			}
			if (entry.hunkIndex > 0) {
				hunkIndexes.add(entry.hunkIndex);
			}
			continue;
		}

		if (entry.kind === "hunk" && entry.hunkIndex > 0) {
			hunkIndexes.add(entry.hunkIndex);
		}
		if (entry.kind === "file") {
			explicitFileCount++;
		}
	}

	if (hunkIndexes.size > 0) {
		stats.hunks = Math.max(stats.hunks, hunkIndexes.size);
	}
	if (explicitFileCount > 0) {
		stats.files = Math.max(stats.files, explicitFileCount);
	} else if (entries.length > 0) {
		stats.files = Math.max(stats.files, 1);
	}
	if (stats.hunks === 0 && entries.some((entry) => entry.kind === "line")) {
		stats.hunks = 1;
	}

	return stats;
}
