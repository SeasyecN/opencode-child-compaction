# OpenCode Child Compaction

An OpenCode plugin that summarizes eligible child sessions when a completed
assistant turn reaches an adaptive context threshold. It uses OpenCode's native
session summarize operation and is designed for child sessions only.

## Behavior

The plugin listens for `message.updated` events. It considers an event only
when the message is:

- an assistant message;
- completed, with `time.completed` set; and
- not a compaction summary, with `summary !== true`.

For a qualifying message, it reads the provider and model metadata for the
model that produced that message. Missing provider or model metadata causes
the event to be skipped.

### Session scope

After the threshold check, the plugin fetches the session and compacts it only
when:

- the session has a `parentID`; and
- its title does not start with `magic-context-`.

Root sessions and sessions with titles starting with `magic-context-` are
excluded. User messages, incomplete assistant messages, and compaction summary
messages are also ignored by the event filter.

## Adaptive threshold

The threshold is calculated from the limits of the model that produced the
completed assistant message:

```text
effective input limit = limit.input
                         or (limit.context - limit.output)
threshold = floor(effective input limit * 0.75)
```

The plugin compacts when the measured usage is greater than or equal to that
threshold. Measured usage is:

```text
usage = input + cache.read + cache.write
```

Missing cache-read or cache-write values count as zero. Only `input`,
`cache.read`, and `cache.write` contribute to this decision.

## Summarization target

When an eligible session reaches the threshold, the plugin calls OpenCode's
native `session.summarize` operation with the target from the editable
`config.json` in the plugin repository/package root, next to `package.json`.
For a local repository checkout, the path is:

```text
config.json
```

When installed as a package (for example in `node_modules` via npm or a local `.tgz`), the configuration file is located at the root of the installed package:

```text
node_modules/@seasyecn/opencode-child-compaction/config.json
```

The initial configuration is:

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

The plugin reads the file from disk once during initialization, relative to
its entry point (both `src/index.ts` and `dist/index.js` resolve the same root
file), independent of the working directory. After editing `config.json`,
quit and restart OpenCode. Later config edits do **not** require rebuilding the
plugin. There is no hot reload or fallback target. A missing, unreadable, or
invalid file fails initialization with an error naming the config path and
required fields.

> **Package Upgrade Note:** Because `config.json` resides directly in the package root, upgrading or reinstalling the package (such as via `npm update`, `npm install`, or installing a newer `.tgz`) will unpack new package files and overwrite `config.json` with the package default. Keep a note or backup of your custom configuration before upgrading.

The per-request `auto: true` flag enables OpenCode's native continuation after
the summary is created. It applies only to this explicit child-session
summarize call; it does not enable global automatic compaction.

The selected provider/model must be available in OpenCode.
The plugin does not configure the provider, endpoint, credentials, or model.

## Repeated and concurrent events

There is no one-time latch per session. After an in-flight operation finishes,
including when it fails, a later qualifying completed assistant event can
trigger another summarize call if the threshold is still reached.

While a summarize operation is pending, duplicate events for the same session
are ignored. The in-flight marker is per session and is cleared when the
operation finishes, so separate sessions can be processed independently.

## Installation

> **Notice:** The public npm registry currently hosts an older `0.1.0` release without configurable model support. This new configurable build is version `0.1.1` and is currently local and **not yet published** to the npm registry. Installing `@seasyecn/opencode-child-compaction` directly from npm will fetch the older `0.1.0` release. For using this configurable `0.1.1` release, follow **Local tarball (`.tgz`) installation** or **Local development**.

### Local tarball (`.tgz`) installation (pre-publication)

1. Pack the repository to create the distribution archive:

```sh
npm pack
```

This runs `prepack` (building `dist/index.js`) and creates `seasyecn-opencode-child-compaction-0.1.1.tgz` containing `dist/index.js`, `config.json`, `package.json`, and `README.md`.

2. Install the tarball into a chosen directory (for example, OpenCode's configuration directory `~/.config/opencode`):

```sh
cd ~/.config/opencode
npm install /path/to/seasyecn-opencode-child-compaction-0.1.1.tgz
```

*(Do not register `file:///...tgz` directly in the OpenCode `plugin` array; Bun imports `.tgz` archives as file paths rather than ESM plugin modules).*

3. Register the file URL pointing to the installed `dist/index.js` in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "file:///path/to/node_modules/@seasyecn/opencode-child-compaction/dist/index.js"
  ]
}
```

Merge this entry with any other registered plugins.

4. Edit the target model in the installed package's configuration file as needed:

```text
node_modules/@seasyecn/opencode-child-compaction/config.json
```

5. Restart OpenCode to load the plugin.

### Published package (after registry publication of 0.1.1)

*Note: The public npm registry currently has version 0.1.0. Do not use this method for the configurable release until version 0.1.1 is published to npm.*

Once `0.1.1` is published to the registry, install the package from npm:

```sh
npm install @seasyecn/opencode-child-compaction
```

Register the package name in the existing `plugin` array in
`~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@seasyecn/opencode-child-compaction"
  ]
}
```

Merge this entry with any other registered plugins. Restart OpenCode after
changing the registration.

### Local development (from source)

From the project root, install dependencies and build the plugin:

```sh
cd opencode-child-compaction
bun install
bun run build
```

Register the built entry point in the existing `plugin` array in
`~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "file:///path/to/opencode-child-compaction/dist/index.js"
  ]
}
```

Merge this entry with any other registered plugins. Restart OpenCode after
changing the registration.

For this child-only design, keep global compaction disabled. The plugin enables
native continuation only on its explicit summarize request:

```json
{
  "compaction": {
    "auto": false
  }
}
```

The plugin does not change the global compaction setting. Configure the
provider/model selected in `config.json` through the normal OpenCode provider
configuration before using the plugin.

## Development

Run the project checks from the project root:

```sh
bun run build
bun run test
bun run typecheck
```

## Uninstall

1. Remove the plugin entry (`@seasyecn/opencode-child-compaction`, tarball path/URL, or `file:///.../dist/index.js`)
   from the `plugin` array in `~/.config/opencode/opencode.json`.
2. Restart OpenCode.
3. Remove the package, tarball, or repository files separately if they are no longer needed.

## Limitations

- The trigger is a completed assistant-message event. It is not a preflight
  hard request block, so it does not prevent a request from being sent before
  compaction is started.
- Compaction is skipped when the completed message's provider/model metadata
  is unavailable or its calculated threshold is not reached.
- The summarize target comes from `config.json`; that model must be
  configured for native summarization to work.
- Only child sessions are handled. Root sessions and titles beginning with
  `magic-context-` are excluded.
