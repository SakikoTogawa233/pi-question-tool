# pi-question-tool

[npm](https://www.npmjs.com/package/pi-question-tool) · [source](https://github.com/SakikoTogawa233/pi-question-tool)

Interactive **question** and **questionnaire** tools for the
[pi coding agent](https://github.com/badlogic/pi-mono).

Adds two tools the model can call when it needs structured input from you:

- **`question`** — ask a single question with a list of options (plus a
  free-text "Type something." fallback).
- **`questionnaire`** — ask one or more questions. A single question shows a
  plain option list; multiple questions show a tab bar for navigating between
  them, then a summary submit screen.

Each tool renders a full-screen custom TUI. Answers are returned to the model
as tool results, so the agent can act on your choices.

In Pi's fullscreen terminal mode (Pi 1.2+), click an option's label or description to select it, including `Type something.`. While typing, click another option to discard the draft and select that answer. Click `Press Enter or click here to submit` to send a completed questionnaire. Keyboard controls work in both fullscreen and regular mode; regular mode leaves the mouse to the terminal for scrollback. Question tabs are clickable too. Click Submit to open the summary, then click it again to submit once every question is answered. The submit hint stays visible but dimmed while questions are unanswered. Text entry still uses the keyboard.

The implementation is adapted from the official pi extension examples
([`question.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/question.ts)
and
[`questionnaire.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts))
and bundled as an installable pi package.

## Install

```sh
pi install npm:pi-question-tool
```

Or add it manually to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["npm:pi-question-tool"]
}
```

To try it without installing:

```sh
git clone https://github.com/SakikoTogawa233/pi-question-tool.git
pi -e ./pi-question-tool/extensions/index.ts
```

## Tools

### `question`

Ask one question and let the user pick an option (or type a free-text answer).

Parameters:

| Field | Type | Description |
|---|---|---|
| `question` | `string` | The question to ask |
| `options` | `Array<{ label, description? }>` | Options to choose from |

The option list always ends with a `Type something.` entry so the user can
answer outside the offered options. Keys: **↑↓** navigate · **Enter** select ·
**Esc** cancel (back from the editor, or cancel the whole question).

### `questionnaire`

Ask one or more questions.

Parameters:

| Field | Type | Description |
|---|---|---|
| `questions` | `Array<Question>` | Questions to ask |

Each `Question`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier for this question |
| `label` | `string?` | Short tab label (defaults to `Q1`, `Q2`, …) |
| `prompt` | `string` | The full question text |
| `options` | `Array<{ value, label, description? }>` | Available options |
| `allowOther` | `boolean?` | Allow the `Type something.` option (default `true`) |

For a single question it behaves like `question`. For multiple questions a tab
bar appears at the top with a `Submit` tab. Keys: **Tab/←→** navigate questions
· **↑↓** select an option · **Enter** confirm · **Esc** cancel. Selecting an
option auto-advances to the next question; the `Submit` tab lists every answer
and requires all questions answered before submitting.

## Result details

Both tools attach a structured `details` object to the tool result in addition
to the human-readable content, so other extensions or renderers can inspect the
answers:

- `question` → `{ question, options: string[], answer: string | null, wasCustom? }`
- `questionnaire` → `{ questions, answers: Array<{ id, value, label, wasCustom, index? }>, cancelled }`

## Develop

No build step — pi loads TypeScript extensions directly.

```sh
npm install         # dev deps (typescript, pi types, pi-tui types)
npm run typecheck   # tsc --noEmit
pi -e ./extensions/index.ts   # run pi with your working copy
```

## CI/CD

`.github/workflows/release.yml` publishes to npm on a `v*` tag push using the
`NPM_TOKEN` repository secret, and publishes a `canary` prerelease on every
push to `main`. `.github/workflows/ci.yml` runs the typecheck on every push and
pull request.

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) (tested with >= 0.83)
- Node 20+ (pi's own requirement)
- An interactive TTY (the tools require TUI mode; in print/RPC/JSON mode they
  return an error result instead of prompting)

## License

MIT
