import type {
  ExtensionAPI,
  EntryRenderer,
  MessageEndEvent,
  MessageUpdateEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

type TurnStat = {
  turnStart: number;
  firstDelta: number | null;
  output: number;
  genMs: number | null;
  ttftMs: number | null;
};

type BenchReport = {
  prompt: string;
  totalMs: number;
  turns: number;
  ttft: { avg: number; min: number; max: number };
  genRate: number; // tokens/sec
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  cost: number;
  tools: { count: number; totalMs: number };
};

type BenchData = BenchReport | { error: string; prompt: string };

const CONTENT_DELTAS = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
]);

let running = false;
let t0 = 0;
let prompt = "";
let turnCount = 0;
let cur: TurnStat | null = null;
const ttfts: number[] = [];
let genMsSum = 0;
let outputSum = 0;

let tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};
let cost = 0;
let toolCount = 0;
let toolTimeMs = 0;
const toolStart = new Map<string, number>();

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
  return Math.round(ms) + "ms";
}

function resetState() {
  turnCount = 0;
  cur = null;
  ttfts.length = 0;
  genMsSum = 0;
  outputSum = 0;
  tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  cost = 0;
  toolCount = 0;
  toolTimeMs = 0;
  toolStart.clear();
}

function handleTurnStart() {
  if (!running) return;
  turnCount++;
  cur = {
    turnStart: Date.now(),
    firstDelta: null,
    output: 0,
    genMs: null,
    ttftMs: null,
  };
}

function handleMessageUpdate(event: MessageUpdateEvent) {
  if (!running || !cur) return;
  const type = event.assistantMessageEvent.type;
  if (CONTENT_DELTAS.has(type) && cur.firstDelta === null) {
    cur.firstDelta = Date.now();
  }
}

function handleMessageEnd(event: MessageEndEvent) {
  if (!running || !cur) return;
  const msg = event.message;
  if (msg.role !== "assistant") return;
  const u: Usage | undefined = "usage" in msg ? msg.usage : undefined;
  const now = Date.now();
  if (u) {
    tokens.input += u.input ?? 0;
    tokens.output += u.output ?? 0;
    tokens.cacheRead += u.cacheRead ?? 0;
    tokens.cacheWrite += u.cacheWrite ?? 0;
    tokens.totalTokens += u.totalTokens ?? 0;
    cost += u.cost?.total ?? 0;
  }
  if (cur.firstDelta !== null) {
    cur.output = u?.output ?? 0;
    cur.genMs = now - cur.firstDelta;
    cur.ttftMs = cur.firstDelta - cur.turnStart;
    ttfts.push(cur.ttftMs);
    outputSum += cur.output;
    genMsSum += cur.genMs;
  }
  cur = null;
}

function handleToolStart(event: ToolExecutionStartEvent) {
  if (!running) return;
  toolStart.set(event.toolCallId, Date.now());
}

function handleToolEnd(event: ToolExecutionEndEvent) {
  if (!running) return;
  const start = toolStart.get(event.toolCallId);
  if (start !== undefined) {
    toolTimeMs += Date.now() - start;
    toolStart.delete(event.toolCallId);
  }
  toolCount++;
}

function buildReport(): BenchReport {
  const ttftAvg = ttfts.length
    ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length
    : 0;
  const ttftMin = ttfts.length ? Math.min(...ttfts) : 0;
  const ttftMax = ttfts.length ? Math.max(...ttfts) : 0;
  const sec = genMsSum / 1000;
  return {
    prompt,
    totalMs: Date.now() - t0,
    turns: turnCount,
    ttft: { avg: ttftAvg, min: ttftMin, max: ttftMax },
    genRate: sec > 0 ? outputSum / sec : 0,
    tokens: { ...tokens },
    cost,
    tools: { count: toolCount, totalMs: toolTimeMs },
  };
}

const renderReport: EntryRenderer<BenchData> = (entry, _options, theme) => {
  const d = entry.data;
  if (!d) return undefined;

  if ("error" in d) {
    return new Text(theme.fg("error", "⚠ pi-bench: " + d.error), 0, 0);
  }

  const t = d.tokens;
  const lines = [
    theme.bold("📊 pi-bench"),
    theme.fg("muted", "Prompt: ") + d.prompt,
    theme.fg("muted", "⏱ wall: ") +
      theme.bold(fmtMs(d.totalMs)) +
      theme.fg("dim", " (" + d.turns + " turns)"),
    theme.fg("muted", "🤖 latency to model: ") +
      theme.bold(fmtMs(d.ttft.avg)) +
      theme.fg(
        "dim",
        " (min " + fmtMs(d.ttft.min) + " / max " + fmtMs(d.ttft.max) + ")",
      ),
    theme.fg("muted", "⚡ generation: ") +
      theme.bold(d.genRate.toFixed(1)) +
      theme.fg("muted", " tok/s"),
    theme.fg("muted", "🔢 tokens: ") +
      theme.fg("accent", String(t.input)) +
      theme.fg("muted", " in / ") +
      theme.fg("accent", String(t.output)) +
      theme.fg("muted", " out / ") +
      theme.fg("accent", String(t.cacheWrite)) +
      theme.fg("muted", " cache / ") +
      theme.bold(String(t.totalTokens)) +
      theme.fg("muted", " total") +
      (d.cost > 0 ? theme.fg("dim", " (cost $" + d.cost.toFixed(4) + ")") : ""),
    theme.fg("muted", "🧰 tools: ") +
      theme.bold(String(d.tools.count)) +
      theme.fg("muted", " calls, ") +
      theme.bold(fmtMs(d.tools.totalMs)),
  ];
  return new Text(lines.join("\n"), 0, 0);
};

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", () => handleTurnStart());
  pi.on("message_update", (event) => handleMessageUpdate(event));
  pi.on("message_end", (event) => handleMessageEnd(event));
  pi.on("tool_execution_start", (event) => handleToolStart(event));
  pi.on("tool_execution_end", (event) => handleToolEnd(event));

  pi.registerCommand("bench", {
    description: "Run a prompt and benchmark tokens / latency / tool time",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        pi.appendEntry("bench-report", {
          prompt: "",
          error: "Usage: /bench <prompt>",
        });
        return;
      }
      if (running) {
        pi.appendEntry("bench-report", {
          prompt: text,
          error: "Bench already running — finish the current one first.",
        });
        return;
      }

      resetState();
      running = true;
      prompt = text;
      t0 = Date.now();

      try {
        pi.sendUserMessage(text);
      } catch (err) {
        running = false;
        pi.appendEntry("bench-report", {
          prompt: text,
          error: `Failed to start bench: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      await ctx.waitForIdle();
      running = false;
      pi.appendEntry("bench-report", buildReport());
    },
  });

  pi.registerEntryRenderer("bench-report", renderReport);
}
