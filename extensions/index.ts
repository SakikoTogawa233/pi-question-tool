/**
 * pi-question-tool — interactive question & questionnaire tools for pi.
 *
 * Registers two tools the LLM can call to ask the user for structured input:
 *
 *   question      — a single question with an option list (plus a free-text
 *                   "Type something." fallback).
 *   questionnaire — one or more questions, with a tab bar for navigating
 *                   between questions and a summary submit screen.
 *
 * Both tools build a full custom TUI via `ctx.ui.custom()` and return the
 * selected answers to the model.
 *
 * Install:  pi install npm:pi-question-tool
 * Try it:   pi -e ./extensions/index.ts
 *
 * The implementation is adapted from the official pi extension examples
 * (`examples/extensions/question.ts` and `questionnaire.ts`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ===========================================================================
// Shared helpers
// ===========================================================================

/** Render helper shared by both tools: word-wrap a string with an ANSI prefix. */
function makeWrappers(renderWidth: number, clickRows: ReturnType<typeof createClickRows>) {
	function addWrapped(lines: string[], text: string) {
		lines.push(...wrapTextWithAnsi(text, renderWidth));
	}
	function addWrappedWithPrefix(lines: string[], prefix: string, text: string) {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= renderWidth) {
			addWrapped(lines, prefix + text);
			return;
		}
		const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
		const continuationPrefix = " ".repeat(prefixWidth);
		for (let i = 0; i < wrapped.length; i++) {
			lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
		}
	}
	function addOption(lines: string[], prefix: string, label: string, description: string | undefined, onClick: () => void) {
		const startRow = lines.length;
		addWrappedWithPrefix(lines, prefix, label);
		if (description) addWrappedWithPrefix(lines, "     ", description);
		clickRows.addRows(startRow, lines.length, onClick);
	}
	return { addWrapped, addWrappedWithPrefix, addOption };
}

function createClickRows() {
	const actions = new Map<number, { startColumn: number; endColumn: number; action: () => void }[]>();
	function addColumnRange(row: number, startColumn: number, endColumn: number, action: () => void) {
		const ranges = actions.get(row) ?? [];
		ranges.push({ startColumn, endColumn, action });
		actions.set(row, ranges);
	}
	return {
		addColumnRange,
		clear: () => actions.clear(),
		addRows(startRow: number, endRow: number, action: () => void) {
			for (let row = startRow; row < endRow; row++) addColumnRange(row, 0, Infinity, action);
		},
		handleMouse(event: TuiMouseEvent) {
			if (event.button !== "left" || event.x < 0 || event.x >= event.width) return undefined;
			const target = actions.get(event.y)?.find((range) => event.x >= range.startColumn && event.x < range.endColumn);
			if (!target) return undefined;
			if (event.type === "press") return { handled: true, focus: true };
			if (event.type !== "click") return undefined;
			target.action();
			return { handled: true, render: true };
		},
	};
}

// ===========================================================================
// question tool — single question, options + free text
// ===========================================================================

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

// ===========================================================================
// questionnaire tool — single or multiple questions, tab navigation
// ===========================================================================

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface QuestionItem {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: QuestionItem[];
	answers: Answer[];
	cancelled: boolean;
}

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function questionnaireErrorResult(
	message: string,
	questions: QuestionItem[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function (pi: ExtensionAPI) {
	// ----- question ---------------------------------------------------------

	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [...params.options, { label: "Type something.", isOther: true }];

			// Hide the working spinner while the question UI is open: a tall custom UI
			// pushes the spinner above the viewport, and its 80ms ticks trigger a full
			// screen redraw each time (pi-tui #4785) — visible as violent flicker.
			ctx.ui.setWorkingVisible(false);
			const result = await ctx.ui
				.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
					(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;
					let cachedWidth: number | undefined;
					const clickRows = createClickRows();

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						clickRows.clear();
						tui.requestRender();
					}

					function selectOption(index: number) {
						const selected = allOptions[index];
						if (!selected) return;
						optionIndex = index;
						if (selected.isOther) {
							if (editMode) return;
							editMode = true;
							refresh();
						} else {
							editMode = false;
							editor.setText("");
							done({ answer: selected.label, wasCustom: false, index: index + 1 });
						}
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							selectOption(optionIndex);
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;
						clickRows.clear();

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const { addWrapped, addWrappedWithPrefix, addOption } = makeWrappers(renderWidth, clickRows);

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						addWrappedWithPrefix(lines, " ", theme.fg("text", params.question));
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
							const color = selected || (isOther && editMode) ? "accent" : "text";

							addOption(
								lines, prefix, theme.fg(color, label),
								opt.description ? theme.fg("muted", opt.description) : undefined,
								() => selectOption(i),
							);
						}

						if (editMode) {
							lines.push("");
							addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter to submit • Click an option to switch • Esc to go back"));
						} else {
							addWrappedWithPrefix(lines, " ", theme.fg("dim", "↑↓ navigate • Enter/click to select • Esc to cancel"));
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
							clickRows.clear();
						},
						handleInput,
						handleMouse: clickRows.handleMouse,
					};
				},
				)
				.finally(() => ctx.ui.setWorkingVisible(true));

			// Build simple options list for details
			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});

	// ----- questionnaire ----------------------------------------------------

	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return questionnaireErrorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return questionnaireErrorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: QuestionItem[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			// See the question tool for why the working spinner is hidden while open.
			ctx.ui.setWorkingVisible(false);
			const result = await ctx.ui
				.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;
				const clickRows = createClickRows();
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					clickRows.clear();
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): QuestionItem | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function selectOption(index: number) {
					const q = currentQuestion();
					const opt = currentOptions()[index];
					if (!q || !opt) return;
					optionIndex = index;
					if (opt.isOther) {
						if (inputMode) return;
						inputMode = true;
						inputQuestionId = q.id;
						editor.setText("");
						refresh();
						return;
					}
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					saveAnswer(q.id, opt.value, opt.label, false, index + 1);
					advanceAfterAnswer();
				}

				function activateTab(index: number) {
					if (index === currentTab) {
						if (index === questions.length && allAnswered()) submit(false);
						return;
					}
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					currentTab = index;
					optionIndex = 0;
					refresh();
				}

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							activateTab((currentTab + 1) % totalTabs);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							activateTab((currentTab - 1 + totalTabs) % totalTabs);
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						selectOption(optionIndex);
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					cachedWidth = width;
					clickRows.clear();

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();
					const { addWrapped, addWrappedWithPrefix, addOption } = makeWrappers(renderWidth, clickRows);

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const prefix = renderWidth > 1 ? " " : "";
						const tabWidth = renderWidth - prefix.length;
						lines.push(prefix);
						function addTab(text: string, onClick?: () => void) {
							for (const [index, fragment] of wrapTextWithAnsi(text, tabWidth).entries()) {
								let row = lines.length - 1;
								let start = visibleWidth(lines[row]);
								const length = visibleWidth(fragment);
								if (index > 0 || start + length > renderWidth) {
									lines.push(prefix);
									row++;
									start = prefix.length;
								}
								lines[row] += fragment;
								if (onClick) clickRows.addColumnRange(row, start, start + length, onClick);
							}
						}
						addTab("← ");
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							addTab(styled, () => activateTab(i));
							addTab(" ");
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						addTab(submitStyled, () => activateTab(questions.length));
						addTab(" →");
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addOption(
								lines, prefix, theme.fg(color, label),
								opt.description ? theme.fg("muted", opt.description) : undefined,
								() => selectOption(i),
							);
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(lines, " ", theme.fg("text", q.prompt));
						lines.push("");
						// Keep options available while editing
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter to submit • Click an option to switch • Esc to cancel"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(lines, " ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(lines, " ", summary);
							}
						}
						lines.push("");
						const canSubmit = allAnswered();
						if (!canSubmit) {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(lines, " ", theme.fg("warning", `Unanswered: ${missing}`));
							lines.push("");
						}
						const startRow = lines.length;
						addWrappedWithPrefix(lines, " ", theme.fg(canSubmit ? "success" : "dim", "Press Enter or click here to submit"));
						if (canSubmit) {
							clickRows.addRows(startRow, lines.length, () => {
								if (allAnswered()) submit(false);
							});
						}
					} else if (q) {
						addWrappedWithPrefix(lines, " ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? "Tab/←→/click navigate • ↑↓ select • Enter/click confirm • Esc cancel"
							: "↑↓ navigate • Enter/click select • Esc cancel";
						addWrappedWithPrefix(lines, " ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
						clickRows.clear();
					},
					handleInput,
					handleMouse: clickRows.handleMouse,
				};
				})
				.finally(() => ctx.ui.setWorkingVisible(true));

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as QuestionItem[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
