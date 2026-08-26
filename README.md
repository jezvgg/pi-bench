# pi-bench

A [pi coding agent](https://pi.dev/) extension that benchmarks a single prompt run and
prints a report card in the chat when the agent finishes.

`/bench <prompt>` sends the prompt, lets the agent work, then shows you not just the
answer but the numbers: tokens spent, latency to the model, generation throughput, tool
calls, and where the wall-clock time actually went.

> **🤖 Written by an AI agent** — this project (code, config, README, and docs) was
> written entirely by an AI coding agent, not by a human. Review the source before
> installing or relying on it.

## Install

```bash
pi install git:github.com/jezvgg/pi-bench
```

Then reload the session:

```text
/reload
```

You may also load it as a one-off:

```bash
pi -e git:github.com/jezvgg/pi-bench    # or a local checkout: pi -e ./src/index.ts
```

## Usage

```text
/bench refactor the auth middleware and add tests
```

When the agent finishes you get a card in the chat:

```text
📊 pi-bench
Prompt: refactor the auth middleware and add tests
⏱ wall: 42.10s (5 turns)
🤖 latency to model: 1800ms (min 500ms / max 3.2s)
⚡ generation: 65.0 tok/s
🔢 tokens: 12000 in / 4800 out / 1000 cache / 16800 total (cost $0.0421)
🧰 tools: 23 calls, 28.30s
```

### Manual window

`/bench` stops at the **main agent's** settle. If a run spawns async work that
outlives the main agent (e.g. subagents), that work isn't captured. Use a manual
window to bracket the whole workflow yourself:

```text
/bench-start refactor the auth middleware and add tests
... the agent (and any subagents) work ...
/bench-end
```

- `/bench-start [prompt]` opens the window (and sends the prompt if given,
  without waiting). `/bench-end` closes it and prints the report, wall = `start → end`.
- `/bench` and the manual window are mutually exclusive.

## Metrics

| Metric | Definition |
| -------- | ------------ |
| **wall** | `Date.now()` from `/bench` until the agent fully settles (retries, auto-compaction, queued continuations included). |
| **latency to model** | Time-to-first-token per assistant turn: `turn_start` → first content delta (`text`/`thinking`/`toolcall`). Reported as avg / min / max. |
| **generation rate** | Total output tokens ÷ total generation time (first delta → message finalized), in tok/s. |
| **tokens** | Sum of assistant-message `usage` across the run: input, output, cache write, total, plus cost. |
| **tools** | Number of `tool_execution_end` events, and total tool wall time = sum of each tool's own start→end duration. |

## How it works

The extension subscribes to the pi event lifecycle and accumulates state while the agent
runs:

- `turn_start` / `message_update` / `message_end` → turn timing, token usage, TTFT, gen rate.
- `tool_execution_start` / `tool_execution_end` → tool count and tool wall time.
- `sendUserMessage()` dispatches the run (fire-and-forget); the extension gates on `turn_start` (run began), then `waitForIdle()` waits for the agent to fully settle, and the report is built from the accumulated state right after.

The report is rendered with `appendEntry()` + `registerEntryRenderer()` — it lives in the
session transcript but is **not** part of the LLM context. Run results are not written to a
separate file.

## Notes / limitations

- Token counts reflect assistant-message `usage` only. Nested LLM work done *by* tools
  (e.g. a subagent call) is not included.
- Subagents run as **separate pi processes**, so their turns/tools/tokens never surface on
  the parent session's event bus. The `subagents:` card line is read best-effort from the
  `subagent` tool's result details and may be empty when the shape differs.
- If the model emits reasoning before text, the recorded latency is to the first reasoning
  token.
- The extension is meant for the interactive TUI; `/bench` is a session command.

## Development

```bash
npm install
npm run typecheck   # npx tsc --noEmit
```

## License

MIT
