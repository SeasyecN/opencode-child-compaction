import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import {
  compactionInput,
  createHarness,
  fixtureModule,
  removeFixtures,
  stepEnded,
  type Harness,
} from "./support";
import { childSession } from "./support";

afterEach(async () => {
  await removeFixtures();
});

const distEntry = join(import.meta.dir, "..", "dist", "index.js");

async function summaryTarget(entry: "src" | "dist"): Promise<{
  harness: Harness;
  model: Harness["logs"]["generate"][number]["model"];
}> {
  const module = await fixtureModule({
    entry,
    config: { providerID: "custom-provider", modelID: "custom-model" },
  });
  const harness = await createHarness((context) => module.default.setup(context));
  harness.registerSession(childSession());
  harness.push(stepEnded("child-1", "child-1-assistant-1"));
  await harness.waitFor(() => harness.logs.compact.length === 1, "compaction submission");

  const input = compactionInput("child-1");
  const hook = harness.compactionHooks[0];
  if (!hook) throw new Error("fixture: compaction hook was not registered");
  await hook(input as never);
  return { harness, model: harness.logs.generate[0]?.model };
}

for (const entry of ["src", "dist"] as const) {
  const entryFile = join(import.meta.dir, "..", entry, entry === "src" ? "index.ts" : "index.js");
  const available = existsSync(entryFile);

  test(`${entry} sends the configured provider and model to the summary generator`, async () => {
    if (!available) return;
    const { harness, model } = await summaryTarget(entry);
    await harness.cleanup();
    expect(model).toEqual({ providerID: "custom-provider", id: "custom-model" });
  });

  test(`${entry} keeps the loaded target and reads edits only when setup runs again`, async () => {
    if (!available) return;
    const module = await fixtureModule({
      entry,
      config: { providerID: "first-provider", modelID: "first-model" },
    });
    const original = await createHarness((context) => module.default.setup(context));

    // First instance keeps its setup-time target even after the file changes.
    await writeFile(module.configPath, JSON.stringify({ providerID: "second-provider", modelID: "second-model" }));
    original.registerSession(childSession());
    original.push(stepEnded("child-1", "child-1-assistant-1"));
    await original.waitFor(() => original.logs.compact.length === 1, "original compaction");
    const firstInput = compactionInput("child-1");
    await original.compactionHooks[0]?.(firstInput as never);
    expect(firstInput.result?.summary).toBe("fixture summary");
    expect(original.logs.generate[0]?.model).toEqual({ providerID: "first-provider", id: "first-model" });

    // A fresh setup reads the edited file.
    const restarted = await createHarness((context) => module.default.setup(context));
    restarted.registerSession(childSession({ id: "child-2" }));
    restarted.push(stepEnded("child-2", "child-2-assistant-1"));
    await restarted.waitFor(() => restarted.logs.compact.length === 1, "restarted compaction");
    const secondInput = compactionInput("child-2");
    await restarted.compactionHooks[0]?.(secondInput as never);
    expect(restarted.logs.generate[0]?.model).toEqual({ providerID: "second-provider", id: "second-model" });

    await original.cleanup();
    await restarted.cleanup();
  });

  const invalidConfigs = [
    undefined,
    "{",
    "null",
    "[]",
    "{}",
    '{"providerID":"p"}',
    '{"providerID":3,"modelID":"m"}',
    '{"providerID":"p","modelID":false}',
    '{"providerID":"  ","modelID":"m"}',
    '{"providerID":"p","modelID":"\\t"}',
    '{"providerID":"p","modelID":"m","extra":true}',
  ] as const;
  for (const config of invalidConfigs) {
    test(`${entry} rejects initialization when config is ${config ?? "missing"}`, async () => {
      const module = await fixtureModule({ entry, config });
      // setup reads config.json before touching any API, so an empty context is safe here.
      const initialization = module.default.setup({} as unknown as Plugin.Context);
      await expect(initialization).rejects.toThrow(module.configPath);
      await expect(initialization).rejects.toThrow("providerID");
      await expect(initialization).rejects.toThrow("modelID");
    });
  }
}

test("the shipped dist entrypoint exists for packaging", () => {
  expect(existsSync(distEntry)).toBe(true);
});
