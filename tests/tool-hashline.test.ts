import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	classifyHashlineBody,
	classifyHashlineLines,
	formatRail,
	formatRailWidth,
	getHashlineOutputStyler,
	type HashlineOutputStyler,
	stripPrefix,
} from "../extensions/renderer/tool/hashline.ts";
import { hashlineToolIoOptions } from "../extensions/renderer/default-mode.ts";
import { ExpandedToolIoView, textFromResult } from "../extensions/renderer/tool/result.ts";
import { config } from "../extensions/config/config.ts";

initTheme("dark");

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

const plain = (lines: string[]): string[] =>
	lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));

const READ_BODY = [
	" 8#VR:function hello() {",
	' 9#KT:  console.log("world");',
	"10#PM:}",
	"[Showing lines 8-10 of 400. Use offset=11 to continue.]",
].join("\n");

const GREP_BODY = [
	"src/a.ts:",
	" 9#VR:foo()",
	"    ...",
	"40#KT:bar()",
	"---",
	"src/b.ts:",
	" 3#PM:baz()",
	"---",
	"1 match in 2 files.",
].join("\n");

function kinds(text: string): string[] {
	return (classifyHashlineBody(text) ?? []).map((item) => item.kind);
}

test("classifies a plain hashline read body", () => {
	assert.deepEqual(kinds(READ_BODY), ["anchor", "anchor", "anchor", "advisory"]);
});

test("classifies a real grep body with scaffolding", () => {
	const classified = classifyHashlineBody(GREP_BODY);
	assert.ok(classified, "grep body classifies");
	assert.deepEqual(
		classified.map((item) => item.kind),
		[
			"structure", // src/a.ts:
			"anchor",
			"structure", //     ...
			"anchor",
			"structure", // ---
			"structure", // src/b.ts:
			"anchor",
			"structure", // ---
			"structure", // 1 match in 2 files.
		],
	);
	const anchors = classified.filter((item) => item.kind === "anchor");
	assert.deepEqual(
		anchors.map((item) => `${item.line}#${item.hash}`),
		["9#VR", "40#KT", "3#PM"],
	);
});

test("tolerates bracketed advisories", () => {
	const body = [
		"1#VR:one",
		"[Showing lines 1-10 of 400 (12.0 KB limit). Use offset=11 to continue.]",
		"[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]",
	].join("\n");
	assert.deepEqual(kinds(body), ["anchor", "advisory", "advisory"]);
});

test("rejects raw/plain and mixed bodies", () => {
	assert.equal(classifyHashlineBody("const a = 1;\nconst b = 2;"), null);
	assert.equal(classifyHashlineBody(`${READ_BODY}\nplain prose line`), null, "mixed body");
});

test("rejects out-of-alphabet and short hashes", () => {
	assert.equal(classifyHashlineBody("12#AB:content"), null, "A/B not in alphabet");
	assert.equal(classifyHashlineBody("12#Z:content"), null, "1-char hash");
	assert.equal(classifyHashlineBody("12#VRSNX:content"), null, "5-char hash");
	assert.deepEqual(kinds("12#VRSN:content"), ["anchor"], "4-char hash is legal");
});

test("rejects empty, advisory-only, and structure-only bodies", () => {
	assert.equal(classifyHashlineBody(""), null);
	assert.equal(classifyHashlineBody("\n\n"), null);
	assert.equal(
		classifyHashlineBody("[Showing lines 1-2 of 3. Use offset=3 to continue.]"),
		null,
		"advisory only",
	);
	assert.equal(
		classifyHashlineBody("src/a.ts:\n---\n2 matches in 1 file."),
		null,
		"structure only",
	);
});

test("read-style result with a details object classifies via its raw content only", () => {
	const result = {
		content: [{ type: "text", text: READ_BODY }],
		details: { truncation: "none", snapshotId: "snap-1", nextOffset: 11 },
		isError: false,
	};
	const raw = textFromResult(result);
	assert.ok(classifyHashlineBody(raw), "raw content classifies");
	const expanded = textFromResult(result, true);
	assert.match(expanded, /Details:/, "expanded body carries the Details suffix");
	assert.equal(
		classifyHashlineBody(expanded),
		null,
		"details-augmented body must never reach the classifier",
	);
});

test("rail helpers: width, right-aligned label, prefix strip", () => {
	const classified = classifyHashlineBody(READ_BODY)!;
	assert.equal(formatRailWidth(classified), 5, "10#PM is the widest label");
	assert.equal(formatRail(classified[0]!, 5), " 8#VR");
	assert.equal(formatRail(classified[2]!, 5), "10#PM");
	assert.equal(stripPrefix(" 9#KT:  indented();"), "  indented();");
	assert.equal(stripPrefix("plain line"), "plain line");
});

test("lenient mode tolerates malformed scaffolding only in grep bodies", () => {
	const corrupt = `${GREP_BODY}\ncorrupt scaffolding line`;
	assert.equal(classifyHashlineBody(corrupt), null, "strict rejects malformed line");
	const lenient = classifyHashlineBody(corrupt, { grepLenient: true });
	assert.ok(lenient, "lenient tolerates malformed line");
	assert.equal(lenient![lenient!.length - 1]!.kind, "plain");
	assert.ok(
		lenient!.some((item) => item.kind === "anchor"),
		"precondition keeps anchors",
	);
	assert.equal(
		classifyHashlineBody("no anchors here at all", { grepLenient: true }),
		null,
		"zero anchors still rejects",
	);
});

test("styler maps view body lines and renders the Details tail as plain rows", () => {
	const styler = getHashlineOutputStyler("read", false);
	const lines = [...READ_BODY.split("\n"), "Details:", "{ truncation: null }"];
	const rows = styler(lines);
	assert.ok(rows, "styler classifies the expanded body");
	assert.equal(rows!.length, lines.length, "one row per body line");
	assert.deepEqual(
		rows!.map((row) => row.rail),
		[" 8#VR", " 9#KT", "10#PM", "", "", ""],
		"rail labels right-aligned at the body rail width",
	);
	assert.equal(rows![0]!.content, "function hello() {", "anchor prefix stripped");
	assert.equal(rows![3]!.content, READ_BODY.split("\n")[3], "advisory keeps its raw line");
	assert.equal(rows![4]!.content, "Details:");
	assert.equal(rows![5]!.content, "{ truncation: null }");
	assert.equal(styler(["const a = 1;"]), null, "plain body stays unstyled");
});

test("styler references are stable per toolName + leniency", () => {
	const readStrict = getHashlineOutputStyler("read", false);
	const readLenient = getHashlineOutputStyler("read", true);
	const grepStrict = getHashlineOutputStyler("grep", false);
	const grepLenient = getHashlineOutputStyler("grep", true);
	assert.equal(getHashlineOutputStyler("read", false), readStrict, "same key → same reference");
	assert.notEqual(readStrict, readLenient);
	assert.notEqual(grepStrict, grepLenient);
	assert.notEqual(readStrict, grepStrict);
});

test("ExpandedToolIoView renders the anchor rail with wrapped continuation rows", () => {
	const styler = getHashlineOutputStyler("read", false);
	const long = "x".repeat(300);
	const body = ["1#VR:short", `2#KT:${long}`, "3#PM:tail"].join("\n");
	const view = new ExpandedToolIoView(theme, "path: a.ts", body, false, 4000, 4000, true, {
		styleOutputLines: styler,
	});
	const rows = plain(view.render(120));
	const railRows = rows.filter((line) => line.includes("#"));
	assert.ok(railRows.some((line) => line.trimEnd().endsWith("1#VR short")));
	assert.ok(
		railRows.some((line) => /2#KT x+$/.test(line.trimEnd())),
		"first wrapped row keeps its rail label",
	);
	const continuation = rows.filter((line) => / {6}x+$/.test(line) && !line.includes("#"));
	assert.ok(continuation.length > 0, "wrapped continuations carry a blank rail");
	assert.ok(rows.some((line) => line.trimEnd().endsWith("3#PM tail")));
	// Output body rows never gain the │ continuation glyph.
	for (const line of rows) {
		if (line.includes("#") || /x{10,}/.test(line)) {
			assert.ok(!line.includes("│"), `no tree glyph on output rows: ${JSON.stringify(line)}`);
		}
	}
});

test("ExpandedToolIoView renders structure rows without a rail and keeps Details visible", () => {
	const styler = getHashlineOutputStyler("grep", false);
	const body = [...GREP_BODY.split("\n"), "Details:", "{ matches: 1 }"].join("\n");
	const view = new ExpandedToolIoView(theme, "path: query", body, false, 4000, 4000, true, {
		styleOutputLines: styler,
	});
	const rows = plain(view.render(120));
	assert.ok(
		rows.some((line) => line.trim() === "src/a.ts:"),
		"path header kept",
	);
	assert.ok(
		rows.some((line) => /^\s+\.\.\.$/.test(line) && !line.includes("#")),
		"range separator kept",
	);
	assert.ok(
		rows.some((line) => line.trim() === "---"),
		"file separator kept",
	);
	assert.ok(
		rows.some((line) => line.trim() === "1 match in 2 files."),
		"summary kept",
	);
	assert.ok(
		rows.some((line) => line.trim() === "Details:"),
		"Details suffix stays visible",
	);
	const pathRow = rows.find((line) => line.trim() === "src/a.ts:")!;
	const anchorRow = rows.find((line) => line.includes("9#VR"))!;
	assert.ok(
		pathRow.trimEnd().length < anchorRow.trimEnd().length,
		"structure rows start at the body edge, anchor content is rail-indented",
	);
});

test("show-more pre-decision agrees with the rendered body at the rail-narrowed width", () => {
	const styler = getHashlineOutputStyler("read", false);
	// Content of 153 chars: 1 wrapped row at full body width, 2 rows once the
	// rail narrows the content column — so only the rail path crosses the limit.
	const filler = "y".repeat(153);
	const body = [`1#VR:${filler}`, `2#KT:${filler}`].join("\n");
	const limited = new ExpandedToolIoView(theme, "", body, false, 2, 2, true, {
		styleOutputLines: styler,
	});
	const rows = plain(limited.render(120));
	assert.match(rows.join("\n"), /\+2 more lines/, "footer drawn at rail-narrowed width");
	assert.equal(limited.matchShowMoreLine(rows[rows.length - 1]!), "output");
	assert.deepEqual(
		limited.showMoreHeaderLineIndexes(),
		[{ section: "output", line: rows.length - 1 }],
		"show-more header row recorded",
	);
	assert.equal(
		plain(limited.render(120)).length,
		rows.length,
		"steady-state render hits the content cache",
	);

	const roomy = new ExpandedToolIoView(theme, "", body, false, 4000, 4000, true, {
		styleOutputLines: styler,
	});
	const roomyRows = plain(roomy.render(120));
	assert.doesNotMatch(roomyRows.join("\n"), /more lines/, "no footer when everything fits");
	assert.equal(roomy.matchShowMoreLine("… +9 more lines"), null);
});

test("non-hashline bodies render identically with and without a styler", () => {
	const body = "const a = 1;\nconst b = 2;";
	const withStyler = new ExpandedToolIoView(theme, "", body, false, 40, 40, true, {
		styleOutputLines: getHashlineOutputStyler("read", false),
	});
	const withoutStyler = new ExpandedToolIoView(theme, "", body, false, 40, 40, true);
	assert.deepEqual(
		plain(withStyler.render(120)),
		plain(withoutStyler.render(120)),
		"styler must not alter plain rendering",
	);
});

test("setContent invalidates on styler identity change even with identical bodies", () => {
	let calls = 0;
	const counting: typeof getHashlineOutputStyler extends (...args: any) => infer R ? R : never = (
		lines: string[],
	) => {
		calls++;
		return getHashlineOutputStyler("read", false)(lines);
	};
	const alternate: typeof counting = (lines: string[]) => {
		calls += 1000;
		return getHashlineOutputStyler("grep", true)(lines);
	};
	const view = new ExpandedToolIoView(theme, "", READ_BODY, false, 40, 40, true, {
		styleOutputLines: counting,
	});
	view.render(120);
	const baseline = calls;
	view.render(120);
	assert.equal(calls, baseline, "same styler reference → cache hit");
	view.setContent("", READ_BODY, false, 40, 40, true, { styleOutputLines: alternate });
	view.render(120);
	assert.equal(calls, baseline + 2000, "different styler reference → invalidated and restyled");
	// Explicit clear on a recycled non-hashline view.
	view.setContent("", "plain output", false, 40, 40, true, { styleOutputLines: null });
	view.render(120);
	assert.equal(calls, baseline + 2000, "cleared styler no longer runs");
});

test("classifyHashlineLines accepts hash lengths 2-4 and region padding", () => {
	assert.deepEqual(kinds("  9#VR:padded"), ["anchor"]);
	assert.deepEqual(kinds("  40#VRSN:wide"), ["anchor"]);
	assert.equal(classifyHashlineBody("   "), null, "whitespace-only is not a hashline body");
	assert.deepEqual(classifyHashlineLines([]), null, "empty body has no anchors");
});

test("config normalization keeps hashlineAnchors valid and round-trips", () => {
	const previous = config.hashlineAnchors;
	try {
		config.hashlineAnchors = "on";
		assert.equal(config.hashlineAnchors, "on");
	} finally {
		config.hashlineAnchors = previous;
	}
});

test("hashlineAnchors off skips the styler; auto gates on detection; on is grep-lenient", () => {
	// Drive the REAL wiring helper (exported for tests) so this cannot stay
	// green if the policy in default-mode diverges.
	const readResult = {
		content: [{ type: "text", text: READ_BODY }],
		details: { truncation: null, snapshotId: "s", nextOffset: 11 },
	};
	const grepResult = {
		content: [{ type: "text", text: GREP_BODY }],
		details: { matches: 1, files: 2, truncated: false },
	};
	const bashResult = { content: [{ type: "text", text: READ_BODY }] };
	const malformedGrep = {
		content: [{ type: "text", text: `${GREP_BODY}\ncorrupt scaffolding` }],
		details: { matches: 1, files: 2, truncated: false },
	};
	const previous = config.hashlineAnchors;
	try {
		config.hashlineAnchors = "auto";
		const readBag = hashlineToolIoOptions("read", readResult, false);
		assert.ok(readBag.styleOutputLines, "auto wires a classified read body");
		assert.ok(
			hashlineToolIoOptions("grep", grepResult, false).styleOutputLines,
			"auto wires a classified grep body",
		);
		assert.equal(
			hashlineToolIoOptions("grep", malformedGrep, false).styleOutputLines,
			null,
			"auto rejects malformed scaffolding",
		);
		assert.equal(
			hashlineToolIoOptions("bash", bashResult, false).styleOutputLines,
			null,
			"other tools explicitly clear the styler",
		);
		assert.equal(
			hashlineToolIoOptions("read", readResult, true).styleOutputLines,
			null,
			"error results always render exactly as before",
		);
		config.hashlineAnchors = "on";
		assert.ok(
			hashlineToolIoOptions("grep", malformedGrep, false).styleOutputLines,
			"on is lenient for grep scaffolding",
		);
		config.hashlineAnchors = "off";
		assert.equal(
			hashlineToolIoOptions("read", readResult, false).styleOutputLines,
			null,
			"off short-circuits read wiring with an explicit clear",
		);
		assert.equal(
			hashlineToolIoOptions("grep", grepResult, false).styleOutputLines,
			null,
			"off short-circuits grep wiring with an explicit clear",
		);
	} finally {
		config.hashlineAnchors = previous;
	}
});

test("recycled styled view loses its styler through setContent with the off-config bag", () => {
	// Build a styled view the way the wiring does under auto...
	const view = new ExpandedToolIoView(theme, "", READ_BODY, false, 40, 40, true, {
		styleOutputLines: getHashlineOutputStyler("read", false),
	});
	const railRows = plain(view.render(120)).filter((line) => line.includes("#"));
	assert.ok(railRows.length > 0, "hashline view shows rail rows");

	// ...then live-toggle off and re-run the REAL wiring through the same
	// recycle path renderExpandedToolResult takes: the off bag MUST clear the
	// stale styler (setContent treats undefined as "keep", null as "clear").
	const previous = config.hashlineAnchors;
	config.hashlineAnchors = "off";
	try {
		const offBag = hashlineToolIoOptions(
			"read",
			{
				content: [{ type: "text", text: READ_BODY }],
				details: { truncation: null },
			},
			false,
		);
		assert.equal(offBag.styleOutputLines, null, "off wiring produces an explicit clear");
		view.setContent("", READ_BODY, false, 40, 40, true, offBag);
	} finally {
		config.hashlineAnchors = previous;
	}
	const recycled = plain(view.render(120));
	// Off renders the RAW prefixes (plain text) — assert the rail style is gone:
	// no right-aligned `NN#HH ` label column, and the `#VR:` colon form remains.
	assert.ok(
		recycled.some((line) => line.includes("8#VR:")),
		"raw prefixes are plain text again after the off toggle",
	);
	assert.ok(
		!recycled.some((line) => /\d#\w{2} \S/.test(line) && !line.includes(":")),
		"no anchor-rail rows survive the off toggle",
	);

	// Non-hashline tool reuse takes the same explicit-clear path.
	view.setContent(
		"",
		"plain output",
		false,
		40,
		40,
		true,
		hashlineToolIoOptions("bash", {}, false),
	);
	const reused = plain(view.render(120));
	assert.ok(reused.some((line) => line.includes("plain output")));
	assert.ok(!reused.some((line) => line.includes("#")), "no rail rows leak onto the reuse");
});

test("recycled view clears the styler when reused for a non-hashline tool", () => {
	const view = new ExpandedToolIoView(theme, "", READ_BODY, false, 40, 40, true, {
		styleOutputLines: getHashlineOutputStyler("read", false),
	});
	const railRows = plain(view.render(120)).filter((line) => line.includes("#"));
	assert.ok(railRows.length > 0, "hashline view shows rail rows");
	// Recycle via setContent with an empty options bag (non-hashline tool path).
	view.setContent("", "plain output", false, 40, 40, true, {});
	const recycled = plain(view.render(120));
	assert.ok(recycled.some((line) => line.includes("plain output")));
	assert.ok(!recycled.some((line) => line.includes("#")), "no rail rows leak onto the reuse");
});
