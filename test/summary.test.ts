import { expect, test } from "bun:test";
import type { SessionCompaction } from "@opencode/plugin/promise/session";
import { buildSummaryPrompt } from "../src/summary";

function transcript(values: unknown[]): SessionCompaction["messages"] {
  return values as unknown as SessionCompaction["messages"];
}

test("keeps user and assistant text and reasoning, filters system messages", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      { role: "system", content: [{ type: "text", text: "secret-system-prompt" }] },
      { role: "user", content: [{ type: "text", text: "user-request" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "reasoning-trace" }, { type: "text", text: "assistant-reply" }] },
    ]),
  );

  expect(prompt).toContain("user-request");
  expect(prompt).toContain("assistant-reply");
  expect(prompt).toContain("reasoning-trace");
  expect(prompt).not.toContain("secret-system-prompt");
});

test("records tool calls and content tool results, redacting inline data URIs", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call-1", name: "read", input: { path: "src/a.ts" } },
          {
            type: "tool-result",
            id: "call-1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "file-contents" },
                { type: "file", mime: "image/png", name: "shot.png", uri: "data:image/png;base64,QUJD" },
              ],
            },
          },
        ],
      },
    ]),
  );

  expect(prompt).toContain('"name":"read"');
  expect(prompt).toContain("src/a.ts");
  expect(prompt).toContain("file-contents");
  expect(prompt).toContain("[inline attachment omitted]");
  expect(prompt).not.toContain("QUJD");
  expect(prompt).toContain("shot.png");
});

test("passes non-content tool results through as data", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      {
        role: "tool",
        content: [{ type: "tool-result", id: "call-2", name: "list", result: { type: "json", value: { entries: 3 } } }],
      },
    ]),
  );

  expect(prompt).toContain('"type":"json"');
  expect(prompt).toContain('"entries":3');
});

test("describes media parts by filename and media type without bytes", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      {
        role: "user",
        content: [{ type: "media", media: { mediaType: "image/jpeg" }, filename: "photo.jpg" }],
      },
    ]),
  );

  expect(prompt).toContain('"type":"attachment"');
  expect(prompt).toContain("image/jpeg");
  expect(prompt).toContain("photo.jpg");
});

test("keeps prior provider checkpoints as checkpoint entries", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      {
        role: "assistant",
        content: [{ type: "compaction", provider: "openai", text: "prior-checkpoint" }],
      },
    ]),
  );

  expect(prompt).toContain('"type":"checkpoint"');
  expect(prompt).toContain("prior-checkpoint");
});

test("refuses to summarize an opaque provider checkpoint with no text", () => {
  const summarize = () =>
    buildSummaryPrompt(
      transcript([
        {
          role: "assistant",
          content: [{ type: "compaction", provider: "openai", text: null }],
        },
      ]),
    );

  expect(summarize).toThrow("cannot be summarized as text");
});

test("drops effort markers and instructs the model to write a resume checkpoint", () => {
  const prompt = buildSummaryPrompt(
    transcript([
      { role: "assistant", content: [{ type: "effort" }] },
    ]),
  );

  expect(prompt).toContain("Objective");
  expect(prompt).toContain('"role":"assistant"');
  expect(prompt).not.toContain('"type":"effort"');
});
