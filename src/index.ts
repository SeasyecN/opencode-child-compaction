import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { AssistantMessage, Message, Model, Session } from "@opencode-ai/sdk";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2/types";
import {
  calculateContextUsage,
  isCompletedNonCompactionAssistantMessage,
  isEligibleChildSession,
  type ModelLimit,
  reachesContextThreshold,
  resolveCompactionThreshold,
} from "./decision";

const SUMMARIZE_PROVIDER = "openai";
const SUMMARIZE_MODEL = "gpt-5.6-luna";

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function shouldCompact(message: Message): message is AssistantMessage {
  return isAssistantMessage(message) && isCompletedNonCompactionAssistantMessage(message);
}

type ModelWithOptionalInput = Model & {
  readonly limit: Model["limit"] & Pick<ModelV2["limit"], "input">;
};

function toModelLimit(model: Model): ModelLimit {
  const modelWithOptionalInput: ModelWithOptionalInput = model;
  const input = modelWithOptionalInput.limit.input;
  return {
    context: modelWithOptionalInput.limit.context,
    output: modelWithOptionalInput.limit.output,
    ...(input === undefined ? {} : { input }),
  };
}

async function resolveModelLimit(
  client: PluginInput["client"],
  providerID: string,
  modelID: string,
): Promise<ModelLimit | undefined> {
  const response = await client.config.providers();
  if (!response.data) return undefined;
  const provider = response.data.providers.find((entry) => entry.id === providerID);
  const model = provider?.models[modelID];
  return model ? toModelLimit(model) : undefined;
}

export const ChildCompactionPlugin: Plugin = async ({ client }) => {
  const inFlightSessions = new Set<string>();

  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated" || !shouldCompact(event.properties.info)) return;

      const message = event.properties.info;
      if (inFlightSessions.has(message.sessionID)) return;
      const usage = calculateContextUsage(message.tokens);
      const modelLimit = await resolveModelLimit(client, message.providerID, message.modelID);
      const threshold = resolveCompactionThreshold(modelLimit);
      if (threshold === undefined || !reachesContextThreshold(usage, threshold)) return;
      if (inFlightSessions.has(message.sessionID)) return;
      inFlightSessions.add(message.sessionID);

      try {
        const sessionResponse = await client.session.get<true>({ path: { id: message.sessionID } });
        const session: Session = sessionResponse.data;
        if (!isEligibleChildSession(session)) return;

        await client.session.summarize<true>({
          path: { id: message.sessionID },
          body: { providerID: SUMMARIZE_PROVIDER, modelID: SUMMARIZE_MODEL },
        });
      } finally {
        inFlightSessions.delete(message.sessionID);
      }
    },
  };
};

export default ChildCompactionPlugin;
