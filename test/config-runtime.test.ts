import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(entry: "src" | "dist", config: string | undefined) {
  const root = await mkdtemp(join(tmpdir(), "child-compaction-config-"));
  roots.push(root);
  await cp(new URL(`../${entry}/`, import.meta.url), join(root, entry), { recursive: true });
  const configPath = join(root, "config.json");
  if (config !== undefined) await writeFile(configPath, config);
  const module: { readonly default: Plugin } = await import(
    pathToFileURL(join(root, entry, entry === "src" ? "index.ts" : "index.js")).href
  );
  return { plugin: module.default, configPath };
}

function inputFor(requests: unknown[]): PluginInput {
  const client = createOpencodeClient({
    baseUrl: "http://fixture.invalid",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/config/providers") {
        return Response.json({ providers: [{ id: "worker-provider", models: {
          worker: { limit: { context: 400_000, input: 260_000, output: 128_000 } },
        } }] });
      }
      if (path === "/session/child-1" && request.method === "GET") {
        return Response.json({ id: "child-1", parentID: "root", title: "ordinary child" });
      }
      if (path === "/session/child-1/summarize" && request.method === "POST") {
        const body: unknown = await request.json();
        requests.push(body);
        return Response.json(true);
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
    },
  });
  return {
    client,
    project: { id: "project", worktree: tmpdir(), time: { created: 1 } },
    directory: tmpdir(),
    worktree: tmpdir(),
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://fixture.invalid"),
    $,
  };
}

const completedEvent = {
  type: "message.updated",
  properties: { info: {
    id: "msg-1", sessionID: "child-1", role: "assistant",
    time: { created: 1, completed: 2 }, parentID: "user-1",
    modelID: "worker", providerID: "worker-provider", mode: "default",
    path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
    tokens: { input: 200_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } },
} satisfies Event;

for (const entry of ["src", "dist"] as const) {
  test(`${entry} uses configured provider/model when an eligible event arrives`, async () => {
    // Given an isolated plugin outside cwd and a target different from the old constants.
    const { plugin } = await fixture(entry, JSON.stringify({ providerID: "custom-provider", modelID: "custom-model" }));
    const requests: unknown[] = [];
    const hooks = await plugin(inputFor(requests));
    // When a completed eligible child event reaches the threshold.
    await hooks.event?.({ event: completedEvent });
    // Then the real SDK sends the configured target on the wire.
    expect(requests).toEqual([{ providerID: "custom-provider", modelID: "custom-model", auto: true }]);
  });

  test(`${entry} reads edits without rebuilding when reinitialized`, async () => {
    // Given an initialized plugin whose isolated config is subsequently edited.
    const { plugin, configPath } = await fixture(entry, JSON.stringify({ providerID: "first-provider", modelID: "first-model" }));
    const requests: unknown[] = [];
    const input = inputFor(requests);
    const original = await plugin(input);
    await writeFile(configPath, JSON.stringify({ providerID: "second-provider", modelID: "second-model" }));
    // When existing and newly initialized hooks handle qualifying events, without a build.
    const restarted = await plugin(input);
    await original.event?.({ event: completedEvent });
    await restarted.event?.({ event: completedEvent });
    // Then existing hooks retain their target and new hooks read the edited file.
    expect(requests).toEqual([
      { providerID: "first-provider", modelID: "first-model", auto: true },
      { providerID: "second-provider", modelID: "second-model", auto: true },
    ]);
  });

  const invalidConfigs = [
    undefined, "{", "null", "[]", "{}",
    '{"providerID":"p"}', '{"providerID":3,"modelID":"m"}',
    '{"providerID":"p","modelID":false}',
    '{"providerID":"  ","modelID":"m"}',
    '{"providerID":"p","modelID":"\\t"}',
    '{"providerID":"p","modelID":"m","extra":true}',
  ] as const;
  for (const config of invalidConfigs) {
    test(`${entry} rejects initialization when config is ${config ?? "missing"}`, async () => {
      // Given a missing or invalid isolated config.
      const { plugin, configPath } = await fixture(entry, config);
      // When initialization runs, then it fails with the path and required fields.
      const initialization = plugin(inputFor([]));
      await expect(initialization).rejects.toThrow(configPath);
      await expect(initialization).rejects.toThrow("providerID");
      await expect(initialization).rejects.toThrow("modelID");
    });
  }
}
