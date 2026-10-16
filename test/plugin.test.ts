import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  BELOW_USAGE,
  OTHER_LOCATION,
  THRESHOLD_USAGE,
  assistantEntry,
  compactionEnded,
  compactionFailed,
  compactionInput,
  compactionStarted,
  createHarness,
  fixtureModule,
  childSession,
  removeFixtures,
  sessionDeleted,
  stepEnded,
  type CompactionHookInput,
  type DefinedPlugin,
  type Harness,
} from "./support";

let plugin: DefinedPlugin;
let harness: Harness;

beforeAll(async () => {
  const module = await fixtureModule({
    entry: "src",
    config: { providerID: "fixture-provider", modelID: "fixture-model" },
  });
  plugin = module.default;
});

afterAll(async () => {
  await removeFixtures();
});

async function fresh(): Promise<Harness> {
  return (harness = await createHarness((context) => plugin.setup(context)));
}

function invokeCompactionHook(input: CompactionHookInput): Promise<void> {
  const hook = harness.compactionHooks[0];
  if (!hook) throw new Error("fixture: compaction hook was not registered");
  return hook(input as never) as Promise<void>;
}

test("an eligible child at threshold schedules one compaction with a steer delivery and idempotent id", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");

  const submission = context.logs.compact[0];
  expect(submission?.sessionID).toBe("child-1");
  expect(submission?.id).toStartWith("msg_");
  expect(submission?.delivery).toBe("steer");
  expect(context.compactionHooks.length).toBe(1);
});

test("the compaction hook summarizes with the configured model and a legal result shape", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  // The hook must run while the scheduled compaction is the admitted, running one.
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");

  const input = compactionInput("child-1");
  await invokeCompactionHook(input);

  const generate = context.logs.generate[0];
  expect(generate?.model).toEqual({ providerID: "fixture-provider", id: "fixture-model" });
  expect(generate?.prompt).toContain("fixture user request");
  expect(generate?.prompt).toContain("fixture assistant reply");
  expect(input.result?.summary).toBe("fixture summary");
  expect(input.result?.metadata).toEqual({
    childCompaction: { providerID: "fixture-provider", modelID: "fixture-model" },
  });
  expect(Object.keys(input.result ?? {}).every((key) =>
    ["summary", "providerState", "metadata", "tokens"].includes(key),
  )).toBe(true);
});

test("the compaction hook leaves compactions it did not schedule untouched", async () => {
  const context = await fresh();
  const input = compactionInput("unrelated-1");
  await invokeCompactionHook(input);
  expect(input.result).toBeUndefined();
  expect(context.logs.generate.length).toBe(0);
});

test("a generate failure fails the hook and a failed compaction releases the session", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");

  context.knobs.generate = { kind: "reject", error: new Error("provider down") };
  const input = compactionInput("child-1");
  const hooked = invokeCompactionHook(input);
  hooked.catch(() => {});
  await expect(hooked).rejects.toThrow("failed or was cancelled");
  expect(input.result).toBeUndefined();

  context.push(compactionFailed("child-1", context.logs.compact[0]?.id ?? ""));
  context.finishCompaction("child-1");
  context.knobs.generate = { kind: "text", text: "fixture summary" };
  context.appendMessage("child-1", { ...assistantEntry({ id: "child-1-assistant-2" }) });
  context.push(stepEnded("child-1", "child-1-assistant-2"));
  await context.waitFor(() => context.logs.compact.length === 2, "compaction after failure release");
});

test("compaction admission is not completion: deduplication holds until the terminal event", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");

  context.push(stepEnded("child-1", "child-1-assistant-2"));
  await context.tick();
  expect(context.logs.compact.length).toBe(1);

  context.push(compactionStarted("child-1", context.logs.compact[0]?.id ?? ""));
  context.push(compactionEnded("child-1"));
  context.finishCompaction("child-1");
  context.appendMessage("child-1", { ...assistantEntry({ id: "child-1-assistant-3" }) });
  context.push(stepEnded("child-1", "child-1-assistant-3"));
  await context.waitFor(() => context.logs.compact.length === 2, "compaction after release");
});

test("duplicate step-ended events for one child trigger a single compaction", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");
  await context.tick();
  expect(context.logs.compact.length).toBe(1);
});

test("different children proceed concurrently without blocking each other", async () => {
  const context = await fresh();
  const gate = Promise.withResolvers<void>();
  context.registerSession(childSession({ id: "child-a" }));
  context.registerSession(childSession({ id: "child-b" }));
  context.knobs.getGates.set("child-a", gate.promise);

  context.push(stepEnded("child-a", "child-a-assistant-1"));
  context.push(stepEnded("child-b", "child-b-assistant-1"));
  await context.waitFor(() => context.logs.compact.some((call) => call.sessionID === "child-b"), "child-b compaction");
  expect(context.logs.compact.some((call) => call.sessionID === "child-a")).toBe(false);

  gate.resolve();
  await context.waitFor(() => context.logs.compact.length === 2, "child-a compaction after gate release");
});

test("parent, Magic Context, below-threshold, incomplete, foreign-directory, and errored steps are excluded", async () => {
  const context = await fresh();

  const rootSession = childSession({ id: "root-1", title: "ordinary root" });
  delete (rootSession as { parentID?: string }).parentID;
  context.registerSession(rootSession);
  context.registerSession(childSession({ id: "magic-1", title: "magic-context-abc" }));
  context.registerSession(childSession());
  context.registerSession(childSession({ id: "late-1" }), [
    { ...{ id: "late-1-assistant-2" }, type: "assistant", agent: "worker", model: { providerID: "worker-provider", id: "worker" }, content: [], time: { created: 1 } },
  ]);
  context.registerSession(childSession({ id: "dir-2", location: { directory: OTHER_LOCATION } }));

  context.push(stepEnded("root-1", "root-1-assistant-1"));
  context.push(stepEnded("magic-1", "magic-1-assistant-1"));
  context.push(stepEnded("child-1", "assistant-below", { tokens: BELOW_USAGE }));
  context.push(stepEnded("late-1", "late-1-assistant-2"));
  context.push(stepEnded("dir-2", "dir-2-assistant-1"));
  context.push(stepEnded("child-1", "assistant-errored", { finish: "error" }));
  await context.tick();

  expect(context.logs.compact.length).toBe(0);
  expect(context.logs.generate.length).toBe(0);
});

test("cache read and write tokens count toward the threshold", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1", {
    tokens: { input: 95_000, output: 0, reasoning: 0, cache: { read: 99_000, write: 1_000 } },
  }));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");
});

test("below-threshold usage with cache tokens stays under the 75% budget", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1", { tokens: { input: THRESHOLD_USAGE.input, output: 0, reasoning: 0, cache: { read: 4_999, write: 0 } } }));
  await context.tick();
  expect(context.logs.compact.length).toBe(0);
});

test("session deletion releases pending deduplication without a terminal compaction event", async () => {
  const context = await fresh();
  const gate = Promise.withResolvers<void>();
  context.registerSession(childSession({ id: "child-gone" }));
  context.knobs.getGates.set("child-gone", gate.promise);
  context.push(stepEnded("child-gone", "child-gone-assistant-1"));
  await context.tick();
  context.push(sessionDeleted("child-gone"));
  gate.resolve();
  await context.tick();
  expect(context.logs.compact.length).toBe(0);

  context.registerSession(childSession({ id: "child-2" }));
  context.push(stepEnded("child-2", "child-2-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction after deleted child");
});

test("cleanup aborts in-flight summaries, disposes registrations, and stops processing", async () => {
  const context = await fresh();
  context.registerSession(childSession());
  context.push(stepEnded("child-1", "child-1-assistant-1"));
  await context.waitFor(() => context.logs.compact.length === 1, "compaction submission");

  const stuckGate = new Promise<void>(() => {});
  context.knobs.generate = { kind: "gate", gate: stuckGate, text: "late summary" };
  const hooked = invokeCompactionHook(compactionInput("child-1"));
  hooked.catch(() => {});
  await context.waitFor(() => context.logs.generate.length === 1, "generate dispatch");

  await context.cleanup();
  expect(context.logs.generate[0]?.signal?.aborted).toBe(true);
  expect(context.disposeCount()).toBeGreaterThan(0);

  context.push(stepEnded("child-1", "child-1-assistant-2"));
  await context.tick();
  expect(context.logs.compact.length).toBe(1);
});
