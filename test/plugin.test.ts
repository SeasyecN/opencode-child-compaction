import { expect, test } from "bun:test";
import type { AssistantMessage, Event, Session } from "@opencode-ai/sdk";
import type { ModelLimit } from "../src/decision";
import { ChildCompactionPlugin } from "../src/index";

type ProviderFixture = {
  readonly providers: readonly {
    readonly id: string;
    readonly models: Readonly<Record<string, { readonly limit: ModelLimit }>>;
  }[];
};

type ClientDouble = {
  readonly session: {
    readonly get: (input: { readonly path: { readonly id: string } }) => Promise<{ readonly data: Session }>;
    readonly summarize: (input: { readonly path: { readonly id: string }; readonly body: { readonly providerID: string; readonly modelID: string; readonly auto?: boolean } }) => Promise<unknown>;
  };
  readonly config: {
    readonly providers: () => Promise<{ readonly data?: ProviderFixture }>;
  };
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg-1",
    sessionID: "child-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "user-1",
    modelID: "worker",
    providerID: "openai",
    mode: "default",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 200_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function event(message: AssistantMessage): Event {
  return { type: "message.updated", properties: { info: message } };
}

function session(title = "ordinary child"): Session {
  return { id: "child-1", projectID: "project", directory: "/tmp", parentID: "root", title, version: "1", time: { created: 1, updated: 2 } };
}

const providerFixture = {
  providers: [
    {
      id: "openai",
      models: {
        worker: { limit: { context: 400_000, input: 260_000, output: 128_000 } },
        small: { limit: { context: 400_000, input: 100_000, output: 128_000 } },
        fallback: { limit: { context: 400_000, output: 128_000 } },
      },
    },
  ],
} satisfies ProviderFixture;

async function hooksFor(
  sessionValue: Session,
  summarize: ClientDouble["session"]["summarize"] = async () => undefined,
  providers: ProviderFixture = providerFixture,
) {
  const client: ClientDouble = {
    session: { get: async () => ({ data: sessionValue }), summarize },
    config: { providers: async () => ({ data: providers }) },
  };
  return ChildCompactionPlugin({ client } as Parameters<typeof ChildCompactionPlugin>[0]);
}

test("parent session is excluded", async () => {
  let count = 0;
  const rootSession: Session = {
    id: "child-1",
    projectID: "project",
    directory: "/tmp",
    title: "ordinary child",
    version: "1",
    time: { created: 1, updated: 2 },
  };
  const hooks = await hooksFor(rootSession, async () => { count += 1; });
  await hooks.event?.({ event: event(assistant()) });
  expect(count).toBe(0);
});

test("Magic Context child is excluded", async () => {
  let count = 0;
  const hooks = await hooksFor(session("magic-context-123"), async () => { count += 1; });
  await hooks.event?.({ event: event(assistant()) });
  expect(count).toBe(0);
});

test("below threshold is excluded", async () => {
  let count = 0;
  const hooks = await hooksFor(session(), async () => { count += 1; });
  await hooks.event?.({ event: event(assistant({ tokens: { input: 194_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })) });
  expect(count).toBe(0);
});

test("completed model input limit controls the threshold", async () => {
  let count = 0;
  const hooks = await hooksFor(session(), async () => { count += 1; });
  await hooks.event?.({
    event: event(assistant({
      providerID: "openai",
      modelID: "small",
      tokens: { input: 75_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })),
  });
  expect(count).toBe(1);
});

test("missing model metadata skips compaction", async () => {
  let count = 0;
  const hooks = await hooksFor(
    session(),
    async () => { count += 1; },
    { providers: [{ id: "other", models: {} }] },
  );
  await hooks.event?.({ event: event(assistant()) });
  expect(count).toBe(0);
});

test("eligible child summarizes repeatedly after each settled call", async () => {
  const calls: Array<{ readonly providerID: string; readonly modelID: string; readonly auto?: boolean }> = [];
  const hooks = await hooksFor(session(), async (input) => { calls.push(input.body); });
  await hooks.event?.({ event: event(assistant()) });
  await hooks.event?.({ event: event(assistant({ id: "msg-2" })) });
  expect(calls).toEqual([
    { providerID: "openai", modelID: "gpt-5.6-luna", auto: true },
    { providerID: "openai", modelID: "gpt-5.6-luna", auto: true },
  ]);
});

test("eligible child requests native auto-continuation after summarize", async () => {
  const requests: Array<Parameters<ClientDouble["session"]["summarize"]>[0]["body"]> = [];
  const hooks = await hooksFor(session(), async (input) => { requests.push(input.body); });
  await hooks.event?.({ event: event(assistant()) });
  expect(requests[0]?.auto).toBe(true);
});

test("cache-read contributes to threshold", async () => {
  let count = 0;
  const hooks = await hooksFor(session(), async () => { count += 1; });
  await hooks.event?.({ event: event(assistant({ tokens: { input: 14_811, output: 0, reasoning: 0, cache: { read: 185_189, write: 0 } } })) });
  expect(count).toBe(1);
});

test("compaction summary is excluded", async () => {
  let count = 0;
  const hooks = await hooksFor(session(), async () => { count += 1; });
  await hooks.event?.({ event: event(assistant({ summary: true })) });
  expect(count).toBe(0);
});

test("user messages are excluded", async () => {
  const hooks = await hooksFor(session());
  const userEvent = { type: "message.updated", properties: { info: { role: "user" } } } as Event;
  await hooks.event?.({ event: userEvent });
});

test("concurrent duplicate events summarize once while the first call is pending", async () => {
	let count = 0;
	const summarizeStarted = Promise.withResolvers<void>();
	const summarizeGate = Promise.withResolvers<void>();
	const hooks = await hooksFor(session(), async () => {
		count += 1;
		summarizeStarted.resolve();
		await summarizeGate.promise;
	});
	const first = hooks.event?.({ event: event(assistant()) });
	await summarizeStarted.promise;
	const second = hooks.event?.({ event: event(assistant({ id: "msg-2" })) });
	await second;
	expect(count).toBe(1);
	summarizeGate.resolve();
	await first;
});
