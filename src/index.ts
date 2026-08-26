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

type SubagentStats = {
  calls: number;
  turns: number;
  tools: number;
  totalTokens: number;
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
  subagents: SubagentStats;
};

type BenchData = BenchReport | { error: string; prompt: string };

const CONTENT_DELTAS = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
]);

let running = false;
let manualOpen = false;
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
let sub: SubagentStats = { calls: 0, turns: 0, tools: 0, totalTokens: 0 };
const toolStart = new Map<string, number>();
// Resolved by turn_start once the dispatched run actually begins.
let resolveStart: (() => void) | null = null;

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
  sub = { calls: 0, turns: 0, tools: 0, totalTokens: 0 };
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
  const resolve = resolveStart;
  resolveStart = null;
  resolve?.();
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

/**
 * Subagents run as separate pi processes; their internal turns/tools/tokens never
 * surface on the parent session's event bus. The only view the parent has is the
 * `subagent` tool's own `tool_execution_end` result, whose `details` carries the
 * child's aggregated progress. This is a defensive, best-effort reader — it never
 * throws and yields 0 when the shape differs.
 */
function sumSubagent(result: any): SubagentStats {
  const s: SubagentStats = { calls: 0, turns: 0, tools: 0, totalTokens: 0 };
  const details = result?.details;
  if (!details || typeof details !== "object") return s;
  const items = Array.isArray(details.results)
    ? details.results
    : Array.isArray(details.progress)
      ? details.progress
      : [details];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const u = it.usage;
    if (u && (typeof u.input === "number" || typeof u.output === "number")) {
      s.totalTokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0);
    } else if (typeof it.tokens === "number") {
      s.totalTokens += it.tokens;
    }
    if (typeof it.toolCount === "number") s.tools += it.toolCount;
    if (typeof it.turnCount === "number") s.turns += it.turnCount;
    s.calls++;
  }
  return s;
}

function handleToolEnd(event: ToolExecutionEndEvent) {
  if (!running) return;
  const start = toolStart.get(event.toolCallId);
  if (start !== undefined) {
    toolTimeMs += Date.now() - start;
    toolStart.delete(event.toolCallId);
  }
  toolCount++;
  if (event.toolName === "subagent") {
    const s = sumSubagent(event.result);
    sub.calls += s.calls;
    sub.turns += s.turns;
    sub.tools += s.tools;
    sub.totalTokens += s.totalTokens;
  }
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
    subagents: { ...sub },
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
  if (d.subagents.calls > 0) {
    lines.push(
      theme.fg("muted", "🧩 subagents: ") +
        theme.bold(String(d.subagents.calls)) +
        theme.fg("muted", " calls, ") +
        theme.bold(String(d.subagents.turns)) +
        theme.fg("muted", " turns, ") +
        theme.bold(String(d.subagents.tools)) +
        theme.fg("muted", " tools, ") +
        theme.bold(String(d.subagents.totalTokens)) +
        theme.fg("muted", " tokens"),
    );
  }
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
          error:
            "Bench already running (auto run or a manual /bench-start window is open).",
        });
        return;
      }

      resetState();
      manualOpen = false;
      running = true;
      prompt = text;
      t0 = Date.now();

      // pi.sendUserMessage is fire-and-forget (returns void): the run begins on a
      // later microtask, so calling ctx.waitForIdle() right after returns early
      // (the session is still idle) and the report would be built too soon.
      // Gate on turn_start (run began) — a 60s guard so a dispatch that never
      // starts (auth/model failure) reports the error instead of hanging.
      const started = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      try {
        pi.sendUserMessage(text);
        const began = await Promise.race([
          started.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 60_000),
          ), // ponytail: dispatch-failure guard, replace with a real failure signal if pi exposes one
        ]);
        if (!began) {
          pi.appendEntry("bench-report", {
            prompt: text,
            error:
              "Bench run never began (no turn started) — check provider/model auth and retry.",
          });
          return;
        }
        await ctx.waitForIdle(); // run is active now; waits until it fully settles
      } finally {
        running = false;
      }
      pi.appendEntry("bench-report", buildReport());
    },
  });

  // Manual window: open with /bench-start, close with /bench-end. Use this when a
  // run spawns async work that outlives the main agent (e.g. subagents) — the auto
  // /bench stops at the main agent's settle, but here YOU decide when it's done.
  pi.registerCommand("bench-start", {
    description: "Start a manual benchmark window (optionally send a prompt)",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (running) {
        ctx.ui.notify(
          "Bench already running (auto run or a manual /bench-start window is open).",
          "warning",
        );
        return;
      }
      resetState();
      manualOpen = true;
      running = true;
      prompt = text || "(manual window)";
      t0 = Date.now();
      if (text) {
        // Fire-and-forget: do not wait for the run, the user ends it with /bench-end.
        pi.sendUserMessage(text);
      }
      ctx.ui.notify(
        text
          ? "Bench started — /bench-end when done."
          : "Bench window open — /bench-end when done.",
        "info",
      );
    },
  });

  pi.registerCommand("bench-end", {
    description: "End the manual benchmark window and print the report",
    handler: async (_args, ctx) => {
      if (!manualOpen) {
        ctx.ui.notify(
          "No manual benchmark window is open (/bench-start).",
          "warning",
        );
        return;
      }
      manualOpen = false;
      running = false;
      pi.appendEntry("bench-report", buildReport());
    },
  });

  pi.registerEntryRenderer("bench-report", renderReport);
}
