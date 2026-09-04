// @bun
// src/decision.ts
var MAGIC_CONTEXT_TITLE_PREFIX = "magic-context-";
var COMPACTION_THRESHOLD_RATIO = 0.75;
function calculateContextUsage(usage) {
  return usage.input + (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0);
}
function resolveCompactionThreshold(limit) {
  if (!limit)
    return;
  const effectiveInputLimit = limit.input ?? limit.context - limit.output;
  return Math.floor(effectiveInputLimit * COMPACTION_THRESHOLD_RATIO);
}
function reachesContextThreshold(usage, threshold) {
  return usage >= threshold;
}
function isEligibleChildSession(session) {
  return session.parentID !== undefined && !session.title.startsWith(MAGIC_CONTEXT_TITLE_PREFIX);
}
function isCompletedNonCompactionAssistantMessage(message) {
  return message.role === "assistant" && message.time.completed !== undefined && message.summary !== true;
}

// src/index.ts
var SUMMARIZE_PROVIDER = "openai";
var SUMMARIZE_MODEL = "gpt-5.6-luna";
function isAssistantMessage(message) {
  return message.role === "assistant";
}
function shouldCompact(message) {
  return isAssistantMessage(message) && isCompletedNonCompactionAssistantMessage(message);
}
function toModelLimit(model) {
  const modelWithOptionalInput = model;
  const input = modelWithOptionalInput.limit.input;
  return {
    context: modelWithOptionalInput.limit.context,
    output: modelWithOptionalInput.limit.output,
    ...input === undefined ? {} : { input }
  };
}
async function resolveModelLimit(client, providerID, modelID) {
  const response = await client.config.providers();
  if (!response.data)
    return;
  const provider = response.data.providers.find((entry) => entry.id === providerID);
  const model = provider?.models[modelID];
  return model ? toModelLimit(model) : undefined;
}
var ChildCompactionPlugin = async ({ client }) => {
  const inFlightSessions = new Set;
  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated" || !shouldCompact(event.properties.info))
        return;
      const message = event.properties.info;
      if (inFlightSessions.has(message.sessionID))
        return;
      const usage = calculateContextUsage(message.tokens);
      const modelLimit = await resolveModelLimit(client, message.providerID, message.modelID);
      const threshold = resolveCompactionThreshold(modelLimit);
      if (threshold === undefined || !reachesContextThreshold(usage, threshold))
        return;
      if (inFlightSessions.has(message.sessionID))
        return;
      inFlightSessions.add(message.sessionID);
      try {
        const sessionResponse = await client.session.get({ path: { id: message.sessionID } });
        const session = sessionResponse.data;
        if (!isEligibleChildSession(session))
          return;
        const summarizeBody = {
          providerID: SUMMARIZE_PROVIDER,
          modelID: SUMMARIZE_MODEL,
          auto: true
        };
        await client.session.summarize({
          path: { id: message.sessionID },
          body: summarizeBody
        });
      } finally {
        inFlightSessions.delete(message.sessionID);
      }
    }
  };
};
var src_default = ChildCompactionPlugin;
export {
  src_default as default,
  ChildCompactionPlugin
};
