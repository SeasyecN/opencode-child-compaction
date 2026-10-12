// @bun
// src/config.ts
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";

class SummarizationConfigError extends Error {
  configPath;
  name = "SummarizationConfigError";
  constructor(configPath, cause) {
    super(`Cannot initialize child compaction: create or fix ${configPath}. ` + 'It must be readable JSON containing only "providerID" and "modelID", both nonblank strings. ' + "Restart OpenCode after fixing the file.", { cause });
    this.configPath = configPath;
  }
}
async function loadSummarizationConfig(configUrl) {
  const configPath = fileURLToPath(configUrl);
  let value;
  try {
    value = JSON.parse(await readFile(configUrl, "utf8"));
  } catch (error) {
    if (error instanceof Error)
      throw new SummarizationConfigError(configPath, error);
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("providerID" in value) || typeof value.providerID !== "string" || value.providerID.trim() === "" || !("modelID" in value) || typeof value.modelID !== "string" || value.modelID.trim() === "" || Object.keys(value).length !== 2) {
    throw new SummarizationConfigError(configPath);
  }
  return { providerID: value.providerID, modelID: value.modelID };
}

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
  const summarizeConfig = await loadSummarizationConfig(new URL("../config.json", import.meta.url));
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
          providerID: summarizeConfig.providerID,
          modelID: summarizeConfig.modelID,
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
