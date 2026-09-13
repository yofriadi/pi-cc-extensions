import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";
import { config } from "../extensions/config/config.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";

initTheme("dark");

function install() {
	const events = new Map<string, Function>();
	const messages: (string | undefined)[] = [];
	const ui = {
		setWorkingMessage(message?: string) {
			messages.push(message);
		},
	} as any;
	workingMessageExtension({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const ctx = { hasUI: true, ui };
	return { events, messages, ctx };
}

test("working message appends token count, speed, and elapsed time while streaming", async (t) => {
	// Mocked Date starts at epoch 0 (falsy "no anchor yet" sentinel), so tests
	// tick before the first delta and only in exact 1000ms refresh steps.
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx);
	// No tokens yet and under the timer threshold: keep Pi's default "Working...".
	assert.equal(messages.at(-1), undefined);

	t.mock.timers.tick(1000);

	const delta = "This is a streaming response body long enough to count some tokens.";
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		ctx,
	);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } },
		ctx,
	);
	// First render lands on the anchor millisecond: basis === 0, no speed yet.
	assert.doesNotMatch(messages.at(-1) ?? "", /tok\/s/);

	// The 1s refresh tick re-renders past the anchor: the speed segment appears.
	t.mock.timers.tick(1000);
	const working = messages.at(-1);
	assert.match(working ?? "", /^Working\.\.\. \(↓ \d+ tokens · [\d.]+ tok\/s · \d+s\)$/);

	await events.get("turn_end")?.({}, ctx);
	assert.equal(messages.at(-1), undefined, "turn end restores default without a completion line");
	assert.equal(
		messages.some((message) => message?.startsWith("✻ Turn took")),
		false,
	);

	// Shutdown remains idempotent (undefined = Pi's default message).
	await events.get("session_shutdown")?.({}, ctx);
	assert.equal(messages.at(-1), undefined);
});

test("token count accumulates across deltas and resets on the next turn", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	const first = messages.at(-1) ?? "";
	assert.match(first, /↓ 1 tokens/);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

	// text_end provides the full block; it must replace, not double-count, deltas.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

	// A second text block accumulates independently by contentIndex.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: {} } },
		ctx,
	);
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 4 tokens/);

	// Provider usage replaces the live chars/4 estimate when available.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "text", text: "abcdefgh" },
						{ type: "text", text: "abcdefgh" },
					],
					usage: { output: 37 },
				},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 37 tokens/);

	// A new turn resets both estimated and provider counts.
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	assert.equal(messages.at(-1), undefined);
});

// 摘要行会被外层消息顶出视口：fullscreen 离开底部时才镜像摘要文案。
test("compact 活动回合：fullscreen 离开底部才镜像摘要，regular 不替换", async () => {
	const previousMode = config.mode;
	config.mode = "compact";
	// 官方 fullscreen 惰性 Proxy：requestRender 每次 get 返回新函数。
	const tui: any = {
		mode: "fullscreen",
		isFollowingOutput: false,
		get requestRender() {
			return () => {};
		},
	};
	setToolMouseTui(tui);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo" } }],
		};
		const assistant = new AssistantMessageComponent(message as any, true) as any;
		assistant.updateContent(message);

		const { events, messages, ctx } = install();
		const pushDelta = () =>
			events.get("message_update")?.(
				{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
				ctx,
			);

		await events.get("turn_start")?.({}, ctx);
		const mirrored = messages.at(-1) ?? "";
		assert.match(
			mirrored,
			/^Running\.\.\.(?: · [\d.]+m?s)?, bash×1/,
			`离开底部时应镜像摘要文案: ${mirrored}`,
		);
		assert.doesNotMatch(mirrored, /click to show more/, `不带展开入口: ${mirrored}`);
		assert.doesNotMatch(mirrored, /^Working\.\.\./, `不再走 Pi 默认文案: ${mirrored}`);

		// token 段仍附加在摘要后面；回合时长由摘要行自带，不叠 agent 计时。
		await pushDelta();
		const withTokens = messages.at(-1) ?? "";
		assert.match(withTokens, /bash×1 · ↓ 1 tokens/, `摘要后接 token: ${withTokens}`);

		// 跟回底部：摘要行重新可见，不镜像。
		tui.isFollowingOutput = true;
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "在底部时不镜像");

		// regular：没有“离开底部”信号，即使不在底部也不替换。
		tui.mode = "regular";
		tui.isFollowingOutput = false;
		// 非惰性 Proxy：requestRender 固定，不再每次 get 返回新函数。
		Object.defineProperty(tui, "requestRender", {
			value: () => {},
			configurable: true,
			writable: true,
		});
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "regular 不替换");

		// 最终回答接手：回合收尾（清空镜像），回到 fullscreen 离开底部也不再显示摘要。
		assistant.updateContent({
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "done" }],
		});
		tui.mode = "fullscreen";
		Object.defineProperty(tui, "requestRender", {
			get: () => () => {},
			configurable: true,
		});
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "回合结束后回落默认");
	} finally {
		hooks.shutdown();
		setToolMouseTui(null);
		config.mode = previousMode;
	}
});

// Pi 的 ctx 失效后 getter 会抛错；定时器里逃逸的异常会直接终止 Pi 进程 (#41)。
test("refresh timer stops quietly once the captured ctx goes stale", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { events, messages } = install();
	let stale = false;
	let probes = 0;
	const ctx = {
		get hasUI() {
			probes++;
			if (stale)
				throw new Error("This extension ctx is stale after session replacement or reload.");
			return true;
		},
		get ui() {
			if (stale) throw new Error("stale");
			return { setWorkingMessage: (message?: string) => messages.push(message) };
		},
	};

	await events.get("turn_start")?.({}, ctx);
	stale = true;
	assert.doesNotThrow(() => t.mock.timers.tick(1_000));
	const probesAfterStale = probes;
	t.mock.timers.tick(5_000);
	assert.equal(probes, probesAfterStale, "loop must stop after the stale probe");

	// 失效窗口内到达的事件也不应抛错或重新拉起循环。
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	await events.get("turn_start")?.({}, ctx);
	await events.get("session_shutdown")?.({}, ctx);
});

test("speed equals tokens over the window since the first content delta", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	// Time-to-first-token: two seconds pass before any content delta. The
	// window must start at the delta, not the turn.
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000); // t=2000

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } },
		ctx,
	);
	// 400 chars / 4 = 100 tokens; anchor lands on this millisecond, so the
	// synchronous render has basis === 0 and omits the speed segment.
	assert.doesNotMatch(messages.at(-1) ?? "", /tok\/s/);
	assert.match(messages.at(-1) ?? "", /↓ 100 tokens/);

	// One second of generation: the refresh tick re-renders at t=3000.
	t.mock.timers.tick(1000);
	// 100 tokens over a 1.0s window → 100 tok/s (integer form at ≥ 100). A
	// turn-anchored window would give 100/3.0s = "33.3 tok/s" instead.
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 3s)");
});

test("speed freezes at response end while elapsed keeps ticking", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } },
		ctx,
	); // anchor at t=1000, 100 tokens, no speed yet
	t.mock.timers.tick(1000); // t=2000: refresh renders over a 1s window
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 2s)");

	// done at t=2000 carrying usage consistent with the live count: the
	// recomposed message is identical and the equality skip fires (frozen
	// basis already equals the streaming basis).
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: { content: [], usage: { output: 100 } },
			},
		},
		ctx,
	);

	// Tools execute for several seconds; every refresh tick re-renders.
	t.mock.timers.tick(1000); // t=3000
	t.mock.timers.tick(1000); // t=4000
	t.mock.timers.tick(1000); // t=5000
	// tok/s frozen at the response's final average; elapsed advanced 2s → 5s.
	// Without the freeze, the basis would grow to 4s and decay to 25 tok/s.
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 5s)");
});

test("speed freezes when the response errors while elapsed keeps ticking", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } },
		ctx,
	);
	t.mock.timers.tick(1000); // t=2000: 100 tok/s visible
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 2s)");

	// error at t=2000 carries the partial assistant message with usage: the
	// speed freezes at its final average exactly as for done.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "error",
				error: { content: [], usage: { output: 100 } },
			},
		},
		ctx,
	);

	t.mock.timers.tick(1000); // t=3000
	t.mock.timers.tick(1000); // t=4000
	t.mock.timers.tick(1000); // t=5000
	// Removing the freeze from the error branch would decay to 25 tok/s.
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 5s)");
});

test("no speed for a response that ends without any content delta", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000

	// A response starts and ends without any content delta, but its final
	// message carries usage.output: tokens render, the speed never does.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "start", partial: {} } },
		ctx,
	);
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: { content: [], usage: { output: 42 } },
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 42 tokens/);
	assert.doesNotMatch(messages.at(-1) ?? "", /tok\/s/);

	// Refresh ticks keep rendering; a turn-anchored bogus speed must not
	// appear later either (dropping the firstDeltaTime guard would render
	// 42.0 tok/s at every tick).
	t.mock.timers.tick(1000); // t=2000
	t.mock.timers.tick(1000); // t=3000
	assert.equal(messages.at(-1), "Working... (↓ 42 tokens · 3s)");
});

test("speed resets between responses within a turn and across turns", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } },
		ctx,
	);
	t.mock.timers.tick(1000); // t=2000: 100 tok/s visible
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 2s)");

	// (a) A second response starts within the turn (tool result → next LLM
	// call): the window is discarded until a new delta arrives.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "start", partial: {} } },
		ctx,
	);
	t.mock.timers.tick(1000); // t=3000: elapsed-only row, no tokens or speed
	assert.equal(messages.at(-1), "Working... (3s)");

	// The new delta re-anchors: same token count, window restarts at t=3000.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400) } },
		ctx,
	);
	assert.doesNotMatch(messages.at(-1) ?? "", /tok\/s/);
	t.mock.timers.tick(1000); // t=4000: fresh 1s window → 100 tok/s again
	// A stale anchor would keep the old window: 100/3.0s = "33.3 tok/s".
	assert.equal(messages.at(-1), "Working... (↓ 100 tokens · 100 tok/s · 4s)");

	// (b) A new turn clears the measurement entirely.
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx); // t=4000, elapsed clock restarts
	assert.equal(messages.at(-1), undefined);
	t.mock.timers.tick(1000); // t=5000
	t.mock.timers.tick(1000); // t=6000
	t.mock.timers.tick(1000); // t=7000: 3s elapsed, no tokens, no speed
	assert.equal(messages.at(-1), "Working... (3s)");
});

test("tool-call deltas anchor timing and stream usage into the token count", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000

	// A tool-call stream: the first toolcall_delta anchors the window before
	// any text/thinking delta and before any usage arrives.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"name":"bash"',
				partial: {},
			},
		},
		ctx,
	);
	assert.equal(messages.at(-1), undefined, "no tokens yet and under the timer threshold");

	t.mock.timers.tick(1000); // t=2000
	t.mock.timers.tick(1000); // t=3000: elapsed-only row
	// Without streamed usage neither the token nor the speed segment appears
	// (tool-call content never feeds the chars/4 estimate).
	assert.equal(messages.at(-1), "Working... (3s)");

	// usage.output rides a later toolcall_delta partial — the common case.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: ',"command":"ls"}',
				partial: { usage: { output: 150 } },
			},
		},
		ctx,
	);
	// Window [1000, 3000] = 2s: 150 tokens / 2.0s = 75.0 tok/s (one decimal
	// below 100). Anchoring at the usage-carrying delta instead would give
	// basis === 0 and no speed segment at all.
	assert.equal(messages.at(-1), "Working... (↓ 150 tokens · 75.0 tok/s · 3s)");
});

test("unchanged composed message skips redundant setWorkingMessage calls", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx); // t=0
	t.mock.timers.tick(1000); // t=1000
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	); // ↓ 1 tokens · 1s (anchor millisecond, no speed)
	const renders = messages.length;
	assert.equal(messages.at(-1), "Working... (↓ 1 tokens · 1s)");

	// done lands on the same mocked millisecond with usage matching the live
	// estimate: the recomposed text is identical, so the equality skip must
	// suppress the setWorkingMessage call.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: { content: [{ type: "text", text: "abcd" }], usage: { output: 1 } },
			},
		},
		ctx,
	);
	assert.equal(messages.length, renders, "identical done render is skipped");

	// A stray post-done message_update in the same millisecond recomposes the
	// same text again — still no additional setWorkingMessage call. (A refresh
	// tick cannot serve here: ticks advance the clock by exactly 1s and flip
	// the second-floored elapsed text.)
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "", partial: {} } },
		ctx,
	);
	assert.equal(messages.length, renders, "unchanged stray update is skipped");
	assert.equal(messages.at(-1), "Working... (↓ 1 tokens · 1s)");
});
