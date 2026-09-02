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
native `session.summarize` operation with this fixed target:

```text
providerID: openai
modelID: gpt-5.6-luna
```

The `openai/gpt-5.6-luna` model must be configured and available in OpenCode.
The plugin does not configure the provider, endpoint, credentials, or model.

## Repeated and concurrent events

There is no one-time latch per session. After an in-flight operation finishes,
including when it fails, a later qualifying completed assistant event can
trigger another summarize call if the threshold is still reached.

While a summarize operation is pending, duplicate events for the same session
are ignored. The in-flight marker is per session and is cleared when the
operation finishes, so separate sessions can be processed independently.

## Installation

From the project root, install dependencies and build the plugin:

```sh
cd /home/xmz/src/opencode-plugins/opencode-child-compaction
bun install
bun run build
```

Register the built entry point in the existing `plugin` array in
`~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "file:///home/xmz/src/opencode-plugins/opencode-child-compaction/dist/index.js"
  ]
}
```

Merge this entry with any other registered plugins. Restart OpenCode after
changing the registration.

For this child-only design, also keep global compaction disabled:

```json
{
  "compaction": {
    "auto": false
  }
}
```

The plugin does not change the global compaction setting. Configure
`openai/gpt-5.6-luna` through the normal OpenCode provider configuration before
using the plugin.

## Development

Run the project checks from the project root:

```sh
bun run build
bun run test
bun run typecheck
```

## Uninstall

1. Remove the `file:///home/xmz/src/opencode-plugins/opencode-child-compaction/dist/index.js`
   entry from the `plugin` array in `~/.config/opencode/opencode.json`.
2. Restart OpenCode.
3. Remove the project files separately if they are no longer needed.

## Limitations

- The trigger is a completed assistant-message event. It is not a preflight
  hard request block, so it does not prevent a request from being sent before
  compaction is started.
- Compaction is skipped when the completed message's provider/model metadata
  is unavailable or its calculated threshold is not reached.
- The summarize target is fixed to `openai/gpt-5.6-luna`; that model must be
  configured for native summarization to work.
- Only child sessions are handled. Root sessions and titles beginning with
  `magic-context-` are excluded.
