import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ModelInfo,
  OpenCodeEvent,
  SessionInboxCompaction,
  SessionInfo,
  SessionMessageInfo,
  TokenUsageInfo,
  V2Event,
} from "@opencode/client";
import { Plugin } from "@opencode/plugin";

/** The interface a published plugin module exports from its default entry. */
export type DefinedPlugin = Plugin.Plugin;
/** The setup(context) function inside Plugin.define. */
export type PluginSetup = Plugin.Plugin["setup"];

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixtures: string[] = [];

export const LOCATION = "/fixtures/workspace";
export const OTHER_LOCATION = "/fixtures/other-workspace";

/** Worker model limit 260_000 input → 75% threshold = 195_000 tokens. */
export const THRESHOLD_USAGE: TokenUsageInfo = {
  input: 190_000,
  output: 0,
  reasoning: 0,
  cache: { read: 10_000, write: 0 },
};
export const BELOW_USAGE: TokenUsageInfo = {
  input: 190_000,
  output: 0,
  reasoning: 0,
  cache: { read: 4_000, write: 0 },
};

export function workerModel(): ModelInfo {
  return {
    id: "worker",
    modelID: "worker",
    providerID: "worker-provider",
    name: "Fixture Worker",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 400_000, input: 260_000, output: 128_000 },
  };
}

export function childSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "child-1",
    parentID: "root-1",
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "ordinary child",
    location: { directory: LOCATION },
    ...overrides,
  };
}

export function assistantEntry(
  overrides: Partial<Extract<SessionMessageInfo, { type: "assistant" }>> = {},
): SessionMessageInfo {
  return {
    id: "assistant-1",
    type: "assistant",
    agent: "worker",
    model: { providerID: "worker-provider", id: "worker" },
    content: [],
    time: { created: 1, completed: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

let eventCounter = 0;

export function stepEnded(
  sessionID: string,
  assistantMessageID: string,
  options: { tokens?: TokenUsageInfo; finish?: "stop" | "error" } = {},
): V2Event {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    created: 1,
    type: "session.step.ended",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    location: { directory: LOCATION },
    data: {
      sessionID,
      assistantMessageID,
      finish: options.finish ?? "stop",
      cost: 0,
      tokens: options.tokens ?? THRESHOLD_USAGE,
    },
  };
}

export function compactionStarted(sessionID: string, inputID: string): V2Event {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    created: 1,
    type: "session.compaction.started",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    location: { directory: LOCATION },
    data: { sessionID, reason: "auto", recent: "recent-1", inputID },
  };
}

export function compactionEnded(sessionID: string): V2Event {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    created: 1,
    type: "session.compaction.ended",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    location: { directory: LOCATION },
    data: { sessionID, reason: "auto", text: "fixture checkpoint", recent: "recent-1" },
  };
}

export function compactionFailed(sessionID: string, inputID: string): V2Event {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    created: 1,
    type: "session.compaction.failed",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    location: { directory: LOCATION },
    data: {
      sessionID,
      reason: "auto",
      error: { type: "fixture_error", message: "fixture compaction failure" },
      inputID,
    },
  };
}

export function sessionDeleted(sessionID: string): V2Event {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    created: 1,
    type: "session.deleted",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 2 },
    location: { directory: LOCATION },
    data: { sessionID },
  };
}

export type CompactionMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: ReadonlyArray<Record<string, unknown>>;
};

/** Shape of the `compaction` hook input the plugin registered for. */
export type CompactionHookInput = {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
  system: ReadonlyArray<Record<string, unknown>>;
  readonly messages: ReadonlyArray<CompactionMessage>;
  options: Record<string, unknown>;
  readonly tools: Record<string, unknown>;
  result?: {
    summary: string;
    providerState?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    tokens?: unknown;
  };
};

export function compactionInput(
  sessionID: string,
  messages: CompactionMessage[] = [
    { role: "user", content: [{ type: "text", text: "fixture user request" }] },
    { role: "assistant", content: [{ type: "text", text: "fixture assistant reply" }] },
  ],
): CompactionHookInput {
  return {
    sessionID,
    agent: "worker",
    model: { providerID: "worker-provider", id: "worker" },
    system: [{ type: "text", text: "fixture system" }],
    messages,
    options: {},
    tools: {},
  };
}

export type GenerateBehavior =
  | { kind: "text"; text: string }
  | { kind: "reject"; error: Error }
  | { kind: "gate"; gate: Promise<void>; text: string };

export type CompactLog = {
  sessionID: string;
  id: string | undefined;
  delivery: "steer" | "queue" | undefined;
  signal: AbortSignal | undefined;
};
export type GenerateLog = {
  prompt: string;
  model: { providerID: string; id: string; variant?: string } | null | undefined;
  signal: AbortSignal | undefined;
};

export type Harness = {
  push: (event: V2Event) => void;
  compactionHooks: Array<(input: never) => Promise<void> | void>;
  disposeCount: () => number;
  logs: { compact: CompactLog[]; generate: GenerateLog[] };
  knobs: { getGates: Map<string, Promise<void>>; generate: GenerateBehavior };
  registerSession: (session: SessionInfo, extraMessages?: SessionMessageInfo[]) => void;
  removeSession: (sessionID: string) => void;
  finishCompaction: (sessionID: string) => void;
  appendMessage: (sessionID: string, message: SessionMessageInfo) => void;
  waitFor: (predicate: () => boolean, description: string) => Promise<void>;
  tick: () => Promise<void>;
  cleanup: () => Promise<void>;
};

export async function createHarness(setup: PluginSetup): Promise<Harness> {
  const queue: OpenCodeEvent[] = [];
  const drains: Array<() => void> = [];
  const knobs: Harness["knobs"] = { getGates: new Map(), generate: { kind: "text", text: "fixture summary" } };
  const logs: Harness["logs"] = { compact: [], generate: [] };
  const compactionHooks: Harness["compactionHooks"] = [];
  const sessions = new Map<string, SessionInfo>();
  const contexts = new Map<string, SessionMessageInfo[]>();
  let disposals = 0;
  function push(event: OpenCodeEvent): void {
    if (drains.length > 0) drains.splice(0, 1)[0]?.();
    queue.push(event);
  }

  function subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpenCodeEvent> {
    async function* stream(): AsyncGenerator<OpenCodeEvent> {
      while (true) {
        if (queue.length === 0) {
          if (options?.signal?.aborted) return;
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            drains.push(() => {
              options?.signal?.removeEventListener("abort", onAbort);
              resolve();
            });
          });
          if (options?.signal?.aborted && queue.length === 0) return;
        }
        const event = queue.shift();
        if (event === undefined) return;
        yield event;
      }
    }
    return stream();
  }

  const sessionApi = {
    get: async (input: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) => {
      const gate = knobs.getGates.get(input.sessionID);
      if (gate) await gate;
      requestOptions?.signal?.throwIfAborted();
      const session = sessions.get(input.sessionID);
      if (!session) throw new Error(`fixture: unknown session ${input.sessionID}`);
      return session;
    },
    context: async (input: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) => {
      requestOptions?.signal?.throwIfAborted();
      return [...(contexts.get(input.sessionID) ?? [])];
    },
    compact: async (
      input: { sessionID: string; id?: string; delivery?: "steer" | "queue" },
      requestOptions?: { signal?: AbortSignal },
    ): Promise<SessionInboxCompaction> => {
      requestOptions?.signal?.throwIfAborted();
      logs.compact.push({
        sessionID: input.sessionID,
        id: input.id,
        delivery: input.delivery,
        signal: requestOptions?.signal,
      });
      const admitted: SessionInboxCompaction = {
        id: input.id ?? `admitted-${logs.compact.length}`,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "compaction",
        payload: {},
        delivery: input.delivery ?? "steer",
      };
      contexts.get(input.sessionID)?.push({
        type: "compaction",
        id: admitted.id,
        status: "running",
        time: { created: Date.now() },
        reason: "auto",
        summary: "",
        recent: "recent-1",
      });
      return admitted;
    },
    hook: async (_name: string, callback: (input: never) => Promise<void> | void) => {
      compactionHooks.push(callback);
      return {
        dispose: async () => {
          disposals += 1;
          const index = compactionHooks.indexOf(callback);
          if (index >= 0) compactionHooks.splice(index, 1);
        },
      };
    },
  };

  const modelApi = {
    list: async (input?: { location?: { directory?: string } }) => ({
      location: { directory: input?.location?.directory ?? LOCATION },
      data: [workerModel()],
    }),
  };

  const generateApi = {
    text: async (
      input: { prompt: string; model?: { providerID: string; id: string; variant?: string } | null },
      requestOptions?: { signal?: AbortSignal },
    ) => {
      logs.generate.push({ prompt: input.prompt, model: input.model, signal: requestOptions?.signal });
      const behavior = knobs.generate;
      requestOptions?.signal?.throwIfAborted();
      if (behavior.kind === "reject") throw behavior.error;
      if (behavior.kind === "gate") await behavior.gate;
      requestOptions?.signal?.throwIfAborted();
      return { text: behavior.text };
    },
  };

  const ctx = {
    location: {
      directory: LOCATION,
      workspaceID: undefined,
      project: { id: "project-1", directory: LOCATION, canonical: LOCATION },
    },
    event: { subscribe },
    session: sessionApi,
    model: modelApi,
    generate: generateApi,
  } as unknown as Plugin.Context;

  const cleanup = (await setup(ctx)) ?? (async () => {});

  async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  return {
    push,
    compactionHooks,
    disposeCount: () => disposals,
    logs,
    knobs,
    registerSession: (session, extraMessages = []) => {
      sessions.set(session.id, session);
      contexts.set(session.id, [assistantEntry({ id: `${session.id}-assistant-1` }), ...extraMessages]);
    },
    removeSession: (sessionID) => {
      sessions.delete(sessionID);
      contexts.delete(sessionID);
    },
    finishCompaction: (sessionID) => {
      const list = contexts.get(sessionID);
      if (!list) return;
      const index = list.findLastIndex((message) => message.type === "compaction" && message.status === "running");
      if (index >= 0) list.splice(index, 1);
    },
    appendMessage: (sessionID, message) => {
      contexts.get(sessionID)?.push(message);
    },
    waitFor,
    tick,
    cleanup: async () => {
      await cleanup();
    },
  };
}

export async function fixtureModule(options: {
  entry: "src" | "dist";
  config?: unknown;
}): Promise<{ default: DefinedPlugin; configPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "child-compaction-fixture-"));
  fixtures.push(root);
  await cp(join(REPO_ROOT, options.entry), join(root, options.entry), { recursive: true });
  await symlink(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  const configPath = join(root, "config.json");
  if (options.config !== undefined) await writeFile(configPath, JSON.stringify(options.config));
  const module = await import(pathToFileURL(join(root, options.entry, options.entry === "src" ? "index.ts" : "index.js")).href);
  return { ...module as { default: DefinedPlugin }, configPath, root };
}

export async function removeFixtures(): Promise<void> {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
