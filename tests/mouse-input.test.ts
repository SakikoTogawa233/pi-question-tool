import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import registerExtension from "../extensions/index.ts";

type InteractiveComponent = Component & Required<Pick<Component, "handleInput" | "handleMouse">>;
type ToolResult = {
	content: { type: string; text: string }[];
	details: {
		answer?: string | null;
		wasCustom?: boolean;
		cancelled?: boolean;
		answers?: { id: string; value: string; label: string; wasCustom: boolean; index?: number }[];
	};
};
type ToolDef = {
	name: string;
	execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<ToolResult>;
};

const tools = new Map<string, ToolDef>();
registerExtension({ registerTool: (tool: ToolDef) => tools.set(tool.name, tool) } as never);

const theme = {
	fg: (_colour: string, text: string) => text,
	bg: (_colour: string, text: string) => text,
	bold: (text: string) => text,
};
const keys = { down: "\x1b[B", up: "\x1b[A", enter: "\r", escape: "\x1b", tab: "\t", left: "\x1b[D" };

/** Run the real custom UI factory and keep its promise pending until it calls done. */
function open(tool: string, params: unknown, customTheme = theme) {
	let component!: InteractiveComponent;
	let completions = 0;
	let renderRequests = 0;
	const tui = {
		terminal: { rows: 40, columns: 80 },
		requestRender: () => { renderRequests++; },
	};
	const result = tools.get(tool)!.execute("mouse-test", params, undefined, undefined, {
		mode: "tui",
		ui: {
			setWorkingVisible: () => {},
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => InteractiveComponent) =>
				new Promise((resolve) => {
					component = factory(tui, customTheme, {}, (value) => {
						completions++;
						resolve(value);
					});
				}),
		},
	});
	assert.ok(component, "execute must invoke the custom UI factory");
	let width = 80;
	let lines: string[] = [];
	return {
		component,
		result,
		get completions() { return completions; },
		get renderRequests() { return renderRequests; },
		render(nextWidth = width) {
			width = nextWidth;
			tui.terminal.columns = width;
			lines = component.render(width);
			return lines;
		},
		input(data: string) { component.handleInput(data); },
		mouse(y: number, overrides: Partial<TuiMouseEvent> = {}) {
			const event: TuiMouseEvent = {
				type: "click", button: "left", x: 1, y,
				screenX: 1, screenY: y, width, height: lines.length,
				shift: false, alt: false, ctrl: false, clickCount: 1,
				...overrides,
			};
			return component.handleMouse(event);
		},
	};
}

function row(lines: string[], text: string) {
	const index = lines.findIndex((line) => stripVTControlCharacters(line).includes(text));
	assert.notEqual(index, -1, `Expected rendered text: ${text}\n${lines.join("\n")}`);
	return index;
}

// Locate visible option blocks, rather than reproducing the wrapping algorithm.
function optionRows(lines: string[], number: number) {
	const start = row(lines, `${number}. `);
	const end = row(lines, `${number + 1}. `);
	return Array.from({ length: end - start }, (_, offset) => start + offset);
}

const options = [
	{ label: "First choice with a long label that wraps", description: "First description also occupies several narrow rows" },
	{ label: "Second choice with another long label that wraps", description: "Second description continues across several lines with a final tailword" },
];
const cases = [
	{
		tool: "question",
		params: { question: "Pick one?", options },
		selected: (result: ToolResult, index: number) => {
			assert.equal(result.details.answer, options[index].label);
			assert.equal(result.details.wasCustom, false);
			assert.equal(result.content[0].text, `User selected: ${index + 1}. ${options[index].label}`);
		},
		custom: (result: ToolResult, text: string) => {
			assert.equal(result.details.answer, text);
			assert.equal(result.details.wasCustom, true);
			assert.equal(result.content[0].text, `User wrote: ${text}`);
		},
		cancelled: (result: ToolResult) => {
			assert.equal(result.details.answer, null);
			assert.equal(result.content[0].text, "User cancelled the selection");
		},
	},
	{
		tool: "questionnaire",
		params: { questions: [{ id: "choice", prompt: "Pick one?", options: options.map((option, index) => ({ ...option, value: `value-${index}` })) }] },
		selected: (result: ToolResult, index: number) => {
			assert.equal(result.details.cancelled, false);
			assert.deepEqual(result.details.answers, [{ id: "choice", value: `value-${index}`, label: options[index].label, wasCustom: false, index: index + 1 }]);
			assert.equal(result.content[0].text, `Q1: user selected: ${index + 1}. ${options[index].label}`);
		},
		custom: (result: ToolResult, text: string) => {
			assert.equal(result.details.cancelled, false);
			assert.deepEqual(result.details.answers, [{ id: "choice", value: text, label: text, wasCustom: true, index: undefined }]);
			assert.equal(result.content[0].text, `Q1: user wrote: ${text}`);
		},
		cancelled: (result: ToolResult) => {
			assert.equal(result.details.cancelled, true);
			assert.deepEqual(result.details.answers, []);
			assert.equal(result.content[0].text, "User cancelled the questionnaire");
		},
	},
];

for (const scenario of cases) {
	const { tool, params } = scenario;

	test(`${tool}: every wrapped label and description row selects the option`, async () => {
		const initial = open(tool, params);
		const lines = initial.render(22);
		const rows = optionRows(lines, 2);
		assert.ok(rows.length >= 5, "Exercise label and description continuations");
		assert.equal(rows.at(-1), row(lines, "tailword"));
		initial.input(keys.escape);
		await initial.result;
		for (const y of rows) {
			const ui = open(tool, params);
			ui.render(22);
			assert.deepEqual(ui.mouse(y, { type: "press" }), { handled: true, focus: true });
			assert.equal(ui.completions, 0, "Press must not select before click");
			assert.deepEqual(ui.mouse(y), { handled: true, render: true });
			assert.equal(ui.completions, 1);
			scenario.selected(await ui.result, 1);
		}
	});

	for (const [from, to] of [[22, 100], [100, 22]]) {
		test(`${tool}: resizing ${from} to ${to} replaces cached lines and click rows`, async () => {
			const ui = open(tool, params);
			const before = ui.render(from);
			const after = ui.render(to);
			assert.notDeepEqual(after, before);
			assert.notEqual(row(before, "2. "), row(after, "2. "));
			assert.deepEqual(ui.render(to), after);
			ui.mouse(row(after, "2. "));
			scenario.selected(await ui.result, 1);
		});
	}

	test(`${tool}: ignores non-left, hover, release, drag, wheel and non-option rows`, async () => {
		const ui = open(tool, params);
		const lines = ui.render();
		const y = row(lines, "2. ");
		const ignored: Partial<TuiMouseEvent>[] = [
			{ button: "right" }, { button: "middle" }, { button: "none" },
			{ type: "move" }, { type: "release" }, { type: "drag" },
			{ type: "wheel", button: "none", wheelDelta: 1 },
			{ x: -1 }, { x: 80 },
		];
		for (const event of ignored) assert.equal(ui.mouse(y, event), undefined);
		for (const blank of [0, row(lines, "Pick one?"), lines.indexOf(""), row(lines, "↑↓"), lines.length - 1, -1, lines.length]) {
			assert.equal(ui.mouse(blank), undefined);
		}
		assert.equal(ui.completions, 0);
		assert.deepEqual(ui.render(), lines, "Ignored events must not change selection");
		ui.input(keys.enter);
		scenario.selected(await ui.result, 0);
	});

	test(`${tool}: refresh and invalidate discard stale mouse targets until rendered`, async () => {
		const ui = open(tool, params);
		const lines = ui.render();
		const y = row(lines, "2. ");
		ui.input(keys.down);
		assert.ok(ui.renderRequests > 0);
		assert.equal(ui.mouse(y), undefined, "Keyboard refresh must clear old targets");
		ui.render();
		ui.component.invalidate();
		assert.equal(ui.mouse(y, { type: "press" }), undefined);
		assert.equal(ui.mouse(y), undefined, "Invalidation must clear old targets");
		assert.equal(ui.completions, 0);
		ui.render();
		ui.mouse(y);
		scenario.selected(await ui.result, 1);
	});

	test(`${tool}: clicking custom text opens the real editor and submits typed text`, async () => {
		const ui = open(tool, params);
		ui.mouse(row(ui.render(), "Type something."));
		const editing = ui.render();
		row(editing, "Your answer:");
		assert.equal(ui.completions, 0);
		ui.input("  a custom answer  ");
		row(ui.render(), "a custom answer");
		ui.input(keys.enter);
		scenario.custom(await ui.result, "a custom answer");
	});

	test(`${tool}: clicking a wrapped option while editing discards the draft and selects it`, async () => {
		const initial = open(tool, params);
		const rows = optionRows(initial.render(22), 2);
		initial.input(keys.escape);
		await initial.result;
		for (const y of rows) {
			const ui = open(tool, params);
			ui.mouse(row(ui.render(22), "Type something."));
			ui.input("discard this draft");
			row(ui.render(), "Your answer:");
			assert.deepEqual(ui.mouse(y, { type: "press" }), { handled: true, focus: true });
			assert.equal(ui.completions, 0);
			assert.deepEqual(ui.mouse(y), { handled: true, render: true });
			scenario.selected(await ui.result, 1);
		}
	});

	test(`${tool}: clicking custom text again keeps the current draft`, async () => {
		const ui = open(tool, params);
		ui.mouse(row(ui.render(), "Type something."));
		ui.input("keep this draft");
		ui.mouse(row(ui.render(), "Type something."));
		row(ui.render(), "keep this draft");
		ui.input(keys.enter);
		scenario.custom(await ui.result, "keep this draft");
	});

	test(`${tool}: Escape from custom text discards it and restores option clicks`, async () => {
		const ui = open(tool, params);
		ui.mouse(row(ui.render(), "Type something."));
		ui.input("discard this");
		ui.render();
		ui.input(keys.escape);
		assert.equal(ui.completions, 0, "Editor Escape must not cancel the tool");
		const lines = ui.render();
		assert.ok(!lines.some((line) => line.includes("Your answer:") || line.includes("discard this")));
		ui.mouse(row(lines, "2. "));
		scenario.selected(await ui.result, 1);
	});

	test(`${tool}: mouse and keyboard option selection return identical results`, async () => {
		const mouse = open(tool, params);
		mouse.mouse(row(mouse.render(), "2. "));
		const keyboard = open(tool, params);
		keyboard.render();
		keyboard.input(keys.down);
		keyboard.input(keys.down);
		keyboard.input(keys.up);
		keyboard.render();
		keyboard.input(keys.enter);
		assert.deepEqual(await mouse.result, await keyboard.result);
	});

	test(`${tool}: keyboard can enter custom text and cancel after leaving the editor`, async () => {
		const ui = open(tool, params);
		ui.render();
		ui.input(keys.down);
		ui.input(keys.down);
		ui.input(keys.enter);
		row(ui.render(), "Your answer:");
		ui.input("unused");
		ui.input(keys.escape);
		assert.equal(ui.completions, 0);
		ui.render();
		ui.input(keys.escape);
		scenario.cancelled(await ui.result);
	});
}

const multiParams = {
	questions: [
		{ id: "scope", label: "Scope", prompt: "Choose scope?", options: [{ value: "small", label: "Small" }], allowOther: false },
		{ id: "priority", label: "Priority", prompt: "Choose priority?", options: [{ value: "later", label: "Later" }] },
	],
};

test("questionnaire: autoadvances, gates final submission, and clicks wrapped submit hints", async () => {
	const ui = open("questionnaire", multiParams);
	ui.render();
	ui.input(keys.tab);
	ui.input(keys.tab);
	let lines = ui.render();
	row(lines, "Ready to submit");
	assert.equal(ui.mouse(row(lines, "Unanswered: Scope, Priority")), undefined);

	ui.input(keys.enter);
	assert.equal(ui.completions, 0);

	ui.input(keys.tab); // back to Scope
	lines = ui.render();
	assert.ok(!lines.some((line) => line.includes("Type something.")), "allowOther: false must hide custom entry");
	ui.mouse(row(lines, "1. Small"));
	assert.equal(ui.completions, 0);
	assert.equal(ui.mouse(row(lines, "1. Small")), undefined, "Autoadvance must discard the previous page's targets");
	lines = ui.render();
	row(lines, "Choose priority?");
	ui.input(keys.tab);
	lines = ui.render();
	assert.equal(ui.mouse(row(lines, "Unanswered: Priority")), undefined);
	ui.input(keys.enter);
	assert.equal(ui.completions, 0, "One answer is not sufficient to submit");

	ui.input(keys.left);
	lines = ui.render();
	ui.mouse(row(lines, "1. Later"));
	lines = ui.render(22);
	row(lines, "Ready to submit");
	row(lines, "Scope: Small");
	row(lines, "Priority: Later");
	assert.equal(ui.completions, 0, "Last answer must open summary, not submit");
	// At this width the action wraps; the continuation must be clickable too.
	const submitContinuation = row(lines, "here to submit");
	assert.deepEqual(ui.mouse(submitContinuation, { type: "press" }), { handled: true, focus: true });
	assert.equal(ui.completions, 0);
	assert.deepEqual(ui.mouse(submitContinuation), { handled: true, render: true });
	const result = await ui.result;
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers, [
		{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 },
		{ id: "priority", value: "later", label: "Later", wasCustom: false, index: 1 },
	]);
	assert.equal(result.content[0].text, "Scope: user selected: 1. Small\nPriority: user selected: 1. Later");
});

test("questionnaire: custom answer autoadvances and keyboard submits the same summary", async () => {
	const ui = open("questionnaire", multiParams);
	ui.render();
	ui.input(keys.enter);
	let lines = ui.render();
	ui.mouse(row(lines, "Type something."));
	lines = ui.render();
	ui.input("  now please  ");
	ui.input(keys.enter);
	lines = ui.render();
	row(lines, "Priority: (wrote) now please");
	assert.equal(ui.completions, 0);
	ui.input(keys.enter);
	const result = await ui.result;
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers, [
		{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 },
		{ id: "priority", value: "now please", label: "now please", wasCustom: true, index: undefined },
	]);
	assert.equal(result.content[0].text, "Scope: user selected: 1. Small\nPriority: user wrote: now please");
});

test("questionnaire: choosing an option while editing exits the editor before autoadvancing", async () => {
	const params = { questions: multiParams.questions.map((q) => ({ ...q, allowOther: true })) };
	const ui = open("questionnaire", params);
	ui.mouse(row(ui.render(), "Type something."));
	ui.input("discard this draft");
	ui.mouse(row(ui.render(), "1. Small"));
	let lines = ui.render();
	row(lines, "Choose priority?");
	assert.ok(!lines.some((line) => line.includes("Your answer:") || line.includes("discard this draft")));
	ui.mouse(row(lines, "Type something."));
	lines = ui.render();
	assert.ok(!lines.some((line) => line.includes("discard this draft")));
	ui.input("discard this too");
	ui.mouse(row(ui.render(), "1. Later"));
	lines = ui.render();
	row(lines, "Ready to submit");
	assert.ok(!lines.some((line) => line.includes("Your answer:") || line.includes("discard this")));
	assert.equal(ui.completions, 0);
	ui.input(keys.enter);
	assert.deepEqual((await ui.result).details.answers, [
		{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 },
		{ id: "priority", value: "later", label: "Later", wasCustom: false, index: 1 },
	]);
});

function clickTab(ui: ReturnType<typeof open>, text: string, width?: number) {
	const lines = ui.render(width);
	const y = row(lines, text);
	const plain = stripVTControlCharacters(lines[y]);
	const x = visibleWidth(plain.slice(0, plain.indexOf(text)));
	return ui.mouse(y, { x });
}

for (const width of [80, 22]) {
	test(`questionnaire: clickable tabs navigate and gate repeated Submit clicks at width ${width}`, async () => {
		const ui = open("questionnaire", multiParams);
		assert.deepEqual(clickTab(ui, "Priority", width), { handled: true, render: true });
		row(ui.render(), "Choose priority?");
		assert.equal(ui.completions, 0);
		clickTab(ui, "Submit");
		row(ui.render(), "Unanswered: Scope,");
		clickTab(ui, "Submit");
		assert.equal(ui.completions, 0, "Repeated Submit clicks cannot submit unanswered questions");
		clickTab(ui, "Scope");
		row(ui.render(), "Choose scope?");
		ui.mouse(row(ui.render(), "1. Small"));
		clickTab(ui, "Submit");
		row(ui.render(), "Unanswered: Priority");
		clickTab(ui, "Submit");
		assert.equal(ui.completions, 0, "Repeated Submit clicks cannot submit partial answers");
		clickTab(ui, "Priority");
		ui.mouse(row(ui.render(), "1. Later"));
		row(ui.render(), "Ready to submit");
		clickTab(ui, "Scope");
		clickTab(ui, "Submit");
		assert.equal(ui.completions, 0, "First Submit click navigates without submitting");
		assert.deepEqual(clickTab(ui, "Submit"), { handled: true, render: true });
		assert.equal(ui.completions, 1);
		assert.equal((await ui.result).details.cancelled, false);
	});
}

for (const width of [80, 22]) {
	test(`questionnaire: submit hint stays visible but inactive until all answers exist at width ${width}`, async () => {
		const ui = open("questionnaire", multiParams);
		const hint = width === 22 ? "here to submit" : "Press Enter or click here to submit";
		clickTab(ui, "Submit", width);
		let lines = ui.render();
		row(lines, "Unanswered:");
		assert.equal(ui.mouse(row(lines, hint)), undefined);
		ui.input(keys.enter);
		assert.equal(ui.completions, 0);
		clickTab(ui, "Scope");
		ui.mouse(row(ui.render(), "1. Small"));
		clickTab(ui, "Submit");
		lines = ui.render();
		row(lines, "Unanswered: Priority");
		assert.equal(ui.mouse(row(lines, hint)), undefined);
		assert.equal(ui.completions, 0);
		clickTab(ui, "Priority");
		ui.mouse(row(ui.render(), "1. Later"));
		lines = ui.render();
		assert.ok(!lines.some((line) => line.includes("Unanswered:")));
		assert.deepEqual(ui.mouse(row(lines, hint)), { handled: true, render: true });
		assert.equal((await ui.result).details.cancelled, false);
	});
}

test("questionnaire: tab hit regions follow wrapped Unicode labels, ANSI styling and resizing", async () => {
	const params = {
		questions: [
			{ ...multiParams.questions[0], label: "猫猫 Long first tab with tailword" },
			{ ...multiParams.questions[1], label: "Second" },
		],
	};
	const styledTheme = {
		fg: (_colour: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bg: (_colour: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
	const ui = open("questionnaire", params, styledTheme);
	clickTab(ui, "Second", 100);
	row(ui.render(), "Choose priority?");
	let lines = ui.render(22);
	for (const line of lines) assert.ok(visibleWidth(line) <= 22);
	const continuation = row(lines, "tailword");
	assert.equal(ui.mouse(continuation, { x: 0 }), undefined, "Left margin isn't a tab");
	assert.equal(ui.mouse(continuation, { x: 21 }), undefined, "Unused right padding isn't a tab");
	assert.equal(ui.mouse(continuation, { x: 1, button: "right" }), undefined);
	assert.equal(ui.mouse(continuation, { x: 1, type: "move" }), undefined);
	assert.deepEqual(ui.mouse(continuation, { x: 1, type: "press" }), { handled: true, focus: true });
	row(ui.render(), "Choose priority?");
	clickTab(ui, "tailword");
	row(ui.render(), "Choose scope?");
	clickTab(ui, "Second", 100);
	lines = ui.render();
	row(lines, "Choose priority?");
	const y = row(lines, "Second");
	const plain = stripVTControlCharacters(lines[y]);
	const x = visibleWidth(plain.slice(0, plain.indexOf("Second")));
	assert.deepEqual(ui.mouse(y, { x, type: "press" }), { handled: true, focus: true });
	ui.component.invalidate();
	assert.equal(ui.mouse(y, { x }), undefined, "Invalidation clears an actual tab target");
	ui.render();
	clickTab(ui, "猫猫");
	row(ui.render(), "Choose scope?");
	ui.input(keys.escape);
	assert.equal((await ui.result).details.cancelled, true);
});

test("questionnaire: tab clicks exit custom entry without leaking the draft", async () => {
	const ui = open("questionnaire", multiParams);
	clickTab(ui, "Priority");
	ui.mouse(row(ui.render(), "Type something."));
	ui.input("discard this draft");
	clickTab(ui, "Priority");
	row(ui.render(), "discard this draft"); // current question tab keeps the editor open
	clickTab(ui, "Scope");
	let lines = ui.render();
	row(lines, "Choose scope?");
	assert.ok(!lines.some((line) => line.includes("Your answer:") || line.includes("discard this draft")));
	clickTab(ui, "Priority");
	ui.mouse(row(ui.render(), "Type something."));
	lines = ui.render();
	assert.ok(!lines.some((line) => line.includes("discard this draft")));
	clickTab(ui, "Submit");
	row(ui.render(), "Unanswered: Scope, Priority");
	ui.input(keys.escape);
	assert.equal((await ui.result).details.cancelled, true);
});

test("questionnaire: cancelling the summary retains partial answers without submitting", async () => {
	const ui = open("questionnaire", multiParams);
	ui.mouse(row(ui.render(), "1. Small"));
	ui.input(keys.tab);
	row(ui.render(), "Unanswered: Priority");
	ui.input(keys.escape);
	const result = await ui.result;
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.answers, [{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 }]);
	assert.equal(result.content[0].text, "User cancelled the questionnaire");
});
