# OpenCode Child Compaction

An OpenCode V2 plugin that compacts eligible child sessions when a completed
assistant turn reaches an adaptive context threshold, writing the summary with
a dedicated summarization model instead of the child's own model.

Built against `@opencode/plugin@2.0.30` for OpenCode `2.0.30`. The V1 plugin
API (`@opencode-ai/plugin`) is not supported by this release.

## Behavior

The plugin subscribes to the server event stream and considers
`session.step.ended` events. An event qualifies only when the step produced a
completed assistant message that is still visible in the session context, and
the message's model has known limits.

### Session scope

- Only child sessions (a session with a `parentID`) are compacted.
- Titles starting with `magic-context-` are excluded, so Magic Context children
  are never touched.
- Sessions outside the plugin's own location directory are ignored.

### Adaptive threshold

The threshold is calculated from the limits of the model that produced the
completed assistant message:

```text
effective input limit = limit.input
                        or (limit.context - limit.output)
threshold = floor(effective input limit * 0.75)
```

The plugin compacts when the measured usage is greater than or equal to that
threshold. Measured usage is the step's effective input budget:

```text
usage = tokens.input + tokens.cache.read + tokens.cache.write
```

Only these fields contribute to the decision; the 75% ratio reserves the
remaining quarter of the input budget for prompt growth.

## Scheduling and deduplication

For each qualifying event the plugin submits one compaction request through
`ctx.session.compact({ sessionID, id, delivery: "steer" })`. The `id` is
generated per pending operation, so repeated submissions are idempotent on the
server side.

OpenCode returns the admitted compaction inbox item, not a finished summary:
admission is not completion. The in-flight marker for a child is held until a
public, terminal compaction event proves the outcome —
`session.compaction.ended`, `session.compaction.failed`,
`session.inbox.cancelled`, an execution interruption after the compaction
started, or `session.deleted`. Until then, duplicate step events for the same
child are ignored. After a failure the marker is released, so a later
qualifying event can schedule the compaction again. Different children are
processed concurrently; the event loop never waits on one child's work.

## Summarization model

`compact()` in OpenCode 2 does not accept a model override, and the plugin
does not write messages or database state directly. Instead it uses the
documented V2 extension point: a `compaction` session hook. When the host runs
a compaction that matches one of this plugin's pending requests, the hook
serializes the transcript being summarized, calls `ctx.generate.text()` with
the target from `config.json`, and sets `event.result`:

```ts
await ctx.session.hook("compaction", async (event) => {
  event.result = { summary: await summarize(event.messages) };
})
```

Setting `result` records the compaction and makes the host skip its native
compaction model call. The plugin sets only the fields the OpenCode 2.0.30
schema allows for a completed compaction result: `summary` plus a `metadata`
annotation identifying the summarizer:

```json
{
  "summary": "…",
  "metadata": { "childCompaction": { "providerID": "openai", "modelID": "gpt-5.6-luna" } }
}
```

Compactions the plugin did not schedule (manual compaction of a parent
session, auto compaction, other plugins' requests) pass through the hook
untouched, so only this plugin's child compactions use the custom model. A
summary failure fails that compaction attempt instead of silently falling back
to another model. Resuming the child after compaction remains the host's
decision, exactly as with a native model-generated summary.

The target model is read from `config.json` in the plugin repository/package
root, next to `package.json`:

```text
config.json
```

When installed as a package (for example in `node_modules` via npm or a local
`.tgz`), the configuration file is located at the root of the installed
package:

```text
node_modules/@seasyecn/opencode-child-compaction/config.json
```

The shipped default is:

```json
{
  "providerID": "openai",
  "modelID": "gpt-5.6-luna"
}
```

`providerID` is the OpenCode provider identifier, and `modelID` is the model
identifier within that provider. The file must contain only these two fields,
both nonblank strings. The chosen provider/model must already be available in
OpenCode; this file does not configure endpoints or credentials.

The plugin reads the file once during `setup`, relative to its bundled entry
point and independent of the working directory. After editing `config.json`,
restart OpenCode (or reload the plugin) so a new `setup` reads the edit. A
missing, unreadable, or invalid file fails plugin initialization with an error
naming the config path and required fields.

> **Package upgrade note:** `config.json` lives in the package root, so
> upgrading or reinstalling the package (npm update/install, a newer `.tgz`)
> overwrites it with the package default. Back up custom settings before
> upgrading.

## Installation

> The npm registry currently hosts the V1-based `0.1.0`/`0.1.1` releases.
> Version `0.2.0` (this release) is not published yet; until then, install
> from a local tarball or a local checkout.

### Local tarball (pre-publication)

1. Pack the repository to create the distribution archive:

```sh
npm pack
```

This runs `prepack` (building `dist/index.js`) and creates
`seasyecn-opencode-child-compaction-0.2.0.tgz` containing `dist/index.js`,
`config.json`, `package.json`, and `README.md`.

2. Install the tarball into OpenCode's configuration directory:

```sh
cd ~/.config/opencode
npm install /path/to/seasyecn-opencode-child-compaction-0.2.0.tgz
```

3. Register the package in the `plugins` array (the V2 configuration key, not
   the V1 `plugin` key) in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "@seasyecn/opencode-child-compaction"
  ]
}
```

Alternatively, register the built entrypoint directly:

```json
{
  "plugins": [
    "file:///path/to/node_modules/@seasyecn/opencode-child-compaction/dist/index.js"
  ]
}
```

4. Edit the summarization target in the installed package's `config.json` if
   the default does not suit your setup, then restart OpenCode to load the
   plugin.

### Published package

Once `0.2.0` is published to the registry:

```sh
npm install @seasyecn/opencode-child-compaction
```

Register `@seasyecn/opencode-child-compaction` in the `plugins` array of
`opencode.json` as above and restart OpenCode after changing registration.

### Local development (from source)

```sh
cd opencode-child-compaction
bun install
bun run build
```

Register the built entry point:

```json
{
  "plugins": [
    "file:///path/to/opencode-child-compaction/dist/index.js"
  ]
}
```

Restart OpenCode after changing the registration.

## Development

Run the project checks from the project root:

```sh
bun run test
bun run typecheck
bun run build
bun pm pack --dry-run
```

The test suite drives the real plugin `setup` with a mock plugin context: it
consumes the event stream the plugin subscribes to, runs the registered
`compaction` hook, and asserts scheduling, deduplication, cleanup, and the
configured summary target — all offline, with no real model calls.

## Uninstall

1. Remove the plugin entry (`@seasyecn/opencode-child-compaction`, tarball, or
   `file:///.../dist/index.js`) from the `plugins` array in
   `~/.config/opencode/opencode.json`.
2. Restart OpenCode.
3. Remove the package, tarball, or repository files separately if they are no
   longer needed.

## Limitations

- The trigger is a completed assistant-step event. It is not a preflight
  request block, so it does not prevent a request from being sent before
  compaction starts.
- Compaction is skipped when the completed message's model metadata is
  unavailable, the effective input limit cannot be resolved, or the calculated
  threshold is not reached.
- Only child sessions are handled. Root sessions and titles beginning with
  `magic-context-` are excluded.
- The summary target comes from `config.json`; that provider/model must be
  configured and available in OpenCode.
- This release targets OpenCode 2 V2 plugins and pins `@opencode/plugin`
  `2.0.30`; it does not load under the V1 plugin API of OpenCode 1.x.
