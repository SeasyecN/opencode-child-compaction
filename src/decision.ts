const MAGIC_CONTEXT_TITLE_PREFIX = "magic-context-";

/** Compact at 75% of the effective input budget, reserving 25% for prompt growth. */
export const COMPACTION_THRESHOLD_RATIO = 0.75;

export type ContextTokenUsage = {
  readonly input: number;
  readonly cache?: {
    readonly read?: number;
    readonly write?: number;
  };
};

export type ModelLimit = {
  readonly context: number;
  readonly input?: number;
  readonly output: number;
};

export type SessionMetadata = {
  readonly parentID?: string;
  readonly title: string;
};

export type AssistantMessageMetadata = {
  readonly role: "assistant";
  readonly summary?: boolean;
  readonly time: {
    readonly completed?: number;
  };
};

export type UserMessageMetadata = {
  readonly role: "user";
  readonly time: {
    readonly completed?: number;
  };
};

export type MessageMetadata = AssistantMessageMetadata | UserMessageMetadata;

export function calculateContextUsage(usage: ContextTokenUsage): number {
  return usage.input + (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0);
}

export function resolveCompactionThreshold(
  limit: ModelLimit | undefined,
): number | undefined {
  if (!limit) return undefined;
  const effectiveInputLimit = limit.input ?? limit.context - limit.output;
  return Math.floor(effectiveInputLimit * COMPACTION_THRESHOLD_RATIO);
}

export function reachesContextThreshold(usage: number, threshold: number): boolean {
  return usage >= threshold;
}

export function isEligibleChildSession(session: SessionMetadata): boolean {
  return (
    session.parentID !== undefined &&
    !session.title.startsWith(MAGIC_CONTEXT_TITLE_PREFIX)
  );
}

export function isCompletedNonCompactionAssistantMessage(
  message: MessageMetadata,
): boolean {
  return (
    message.role === "assistant" &&
    message.time.completed !== undefined &&
    message.summary !== true
  );
}
