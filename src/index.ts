import { Plugin } from "@opencode/plugin";
import { loadSummarizationConfig } from "./config";
import {
  calculateContextUsage,
  isCompletedNonCompactionAssistantMessage,
  isEligibleChildSession,
  resolveCompactionThreshold,
} from "./decision";
import { buildSummaryPrompt } from "./summary";

type Context = Plugin.Context;
type Event = AsyncIterableValue<ReturnType<Context["event"]["subscribe"]>>;
type AsyncIterableValue<T> = T extends AsyncIterable<infer V> ? V : never;
type StepEnded = Extract<Event, { type: "session.step.ended" }>;

function pendingCompaction() {
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    controller: new AbortController(),
    admitted: Promise.withResolvers<string | undefined>(),
    closed: Promise.withResolvers<void>(),
    submitted: false,
    started: false,
    acceptedID: undefined as string | undefined,
    summary: undefined as Promise<string> | undefined,
  };
}
type Pending = ReturnType<typeof pendingCompaction>;

// Cancellation also settles plugin-owned waits if a transport ignores its AbortSignal.
function during<T>(pending: Pending, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    pending.closed.promise.then(() => {
      throw new DOMException("Child compaction cancelled", "AbortError");
    }),
  ]);
}

export default Plugin.define({
  id: "@seasyecn/opencode-child-compaction",
  async setup(ctx) {
    const config = await loadSummarizationConfig(new URL("../config.json", import.meta.url));
    const controller = new AbortController();
    const pending = new Map<string, Pending>();
    const running = new Map<string, string | undefined>();
    const seen = new Map<string, Set<string>>();
    const tasks = new Set<Promise<void>>();

    function release(sessionID: string, operation: Pending) {
      if (pending.get(sessionID) !== operation) return;
      pending.delete(sessionID);
      operation.controller.abort();
      operation.admitted.resolve(undefined);
      operation.closed.resolve();
    }

    function stop() {
      controller.abort();
      for (const [sessionID, operation] of pending) release(sessionID, operation);
      running.clear();
      seen.clear();
    }

    const registration = await ctx.session.hook("compaction", async (event) => {
      const operation = pending.get(event.sessionID);
      if (!operation?.submitted) return;
      const acceptedID = await operation.admitted.promise;
      // A request can merge into somebody else's pending control. Do not take it over.
      if (acceptedID !== operation.id || pending.get(event.sessionID) !== operation) return;
      const options = { signal: operation.controller.signal };
      const messages = await during(operation, ctx.session.context({ sessionID: event.sessionID }, options));
      const active = messages.findLast((message) => message.type === "compaction" && message.status === "running");
      // Public session state is already projected when this hook runs, even if the
      // async event subscriber has not consumed compaction.started yet.
      if (active?.id !== acceptedID) return;
      operation.started = true;
      try {
        operation.summary ??= during(operation, ctx.generate.text({
          model: { providerID: config.providerID, id: config.modelID },
          prompt: buildSummaryPrompt(event.messages),
        }, options)).then(({ text }) => {
          if (!text.trim()) throw new Error("Empty child compaction summary");
          return text;
        });
        const summary = await operation.summary;
        operation.controller.signal.throwIfAborted();
        event.result = {
          summary,
          metadata: { childCompaction: { providerID: config.providerID, modelID: config.modelID } },
        };
        // Supplying a result is not checkpoint completion. Only the host's terminal
        // compaction event below releases the session; the host also resumes work.
      } catch {
        // Do not leak provider errors containing prompts, credentials or summaries.
        // A hook failure fails this compaction, rather than using the child's model.
        throw new Error("Child compaction summary generation failed or was cancelled");
      }
    });

    async function consider(event: StepEnded, operation: Pending) {
      const { sessionID, assistantMessageID } = event.data;
      const options = { signal: operation.controller.signal };
      try {
        const session = await during(operation, ctx.session.get({ sessionID }, options));
        if (!isEligibleChildSession(session) || session.location.directory !== ctx.location.directory) {
          release(sessionID, operation);
          return;
        }
        const messages = await during(operation, ctx.session.context({ sessionID }, options));
        const message = messages.find((entry) => entry.id === assistantMessageID);
        if (!message || message.type !== "assistant" || !isCompletedNonCompactionAssistantMessage(message)) {
          release(sessionID, operation);
          return;
        }
        const models = await during(operation, ctx.model.list({ location: { directory: session.location.directory } }, options));
        const model = models.data.find((entry) => entry.providerID === message.model.providerID && entry.id === message.model.id);
        const threshold = resolveCompactionThreshold(model?.limit);
        if (threshold === undefined || calculateContextUsage(event.data.tokens) < threshold || running.has(sessionID)) {
          release(sessionID, operation);
          return;
        }
        operation.submitted = true;
        const admitted = await during(operation, ctx.session.compact({
          sessionID,
          id: operation.id,
          delivery: "steer",
        }, options));
        operation.acceptedID = admitted.id;
        operation.admitted.resolve(admitted.id);
        // Fast completions (or a merged external request) may precede the admission
        // response. Reconcile by the accepted inbox/message ID, never by HTTP return.
        if (pending.get(sessionID) !== operation) return;
        const context = await during(operation, ctx.session.context({ sessionID }, options));
        const control = context.find((entry) => entry.id === admitted.id);
        if (control?.type === "compaction" && control.status !== "running") release(sessionID, operation);
      } catch {
        if (!operation.controller.signal.aborted) console.warn("[child-compaction] Could not schedule or observe compaction");
        // If submission succeeded, retain deduplication until a host terminal event.
        if (!operation.acceptedID) release(sessionID, operation);
      }
    }

    function handle(event: Event) {
      if (event.type === "session.step.ended") {
        const { sessionID, assistantMessageID } = event.data;
        let steps = seen.get(sessionID);
        if (steps?.has(assistantMessageID)) return;
        if (!steps) seen.set(sessionID, steps = new Set());
        steps.add(assistantMessageID);
        if (pending.has(sessionID) || event.data.finish === "error") return;
        const operation = pendingCompaction();
        pending.set(sessionID, operation);
        const task = consider(event, operation);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return;
      }
      if (!("sessionID" in event.data)) return;
      const sessionID = event.data.sessionID;
      const operation = pending.get(sessionID);
      switch (event.type) {
        case "session.compaction.started":
          running.set(sessionID, event.data.inputID);
          if (operation && event.data.inputID === (operation.acceptedID ?? operation.id)) operation.started = true;
          break;
        case "session.compaction.ended":
          if (operation && (running.get(sessionID) === (operation.acceptedID ?? operation.id) || operation.started)) {
            release(sessionID, operation);
          }
          running.delete(sessionID);
          break;
        case "session.compaction.failed":
          if (operation && (event.data.inputID === (operation.acceptedID ?? operation.id) ||
            (event.data.inputID === undefined && operation.started))) release(sessionID, operation);
          running.delete(sessionID);
          break;
        case "session.inbox.cancelled":
          if (operation && event.data.inboxID === (operation.acceptedID ?? operation.id)) release(sessionID, operation);
          break;
        case "session.execution.failed":
        case "session.execution.interrupted":
          // An interruption before delivery can leave the control queued for the
          // successor execution. Only an already-started compaction is terminal here.
          if (operation?.started) release(sessionID, operation);
          running.delete(sessionID);
          break;
        case "session.deleted":
          if (operation) release(sessionID, operation);
          running.delete(sessionID);
          seen.delete(sessionID);
          break;
      }
    }

    const loop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          // Never await child work here: it would block completion events and other children.
          handle(event);
        }
      } catch {
        if (!controller.signal.aborted) console.warn("[child-compaction] Event stream failed; reload the plugin to resume");
      } finally {
        stop();
      }
    })();

    return async () => {
      stop();
      await registration.dispose();
      await loop;
      await Promise.all(tasks);
    };
  },
});
