import { expect, test } from "bun:test";
import {
	type AssistantMessageMetadata,
	type ContextTokenUsage,
	calculateContextUsage,
	isCompletedNonCompactionAssistantMessage,
	isEligibleChildSession,
	type MessageMetadata,
	type ModelLimit,
	reachesContextThreshold,
	resolveCompactionThreshold,
	type SessionMetadata,
} from "../src/decision";

test("calculateContextUsage includes fresh input and available cache tokens", () => {
	const usage = {
		input: 14811,
		cache: { read: 619008, write: 37 },
	} satisfies ContextTokenUsage;

	expect(calculateContextUsage(usage)).toBe(633856);
});

test("calculateContextUsage accepts cache-read contribution without cache-write tokens", () => {
	const usage = {
		input: 14811,
		cache: { read: 619008 },
	} satisfies ContextTokenUsage;

	expect(calculateContextUsage(usage)).toBe(633819);
});

test("resolveCompactionThreshold uses the provider input limit first", () => {
	const limit = {
		context: 400_000,
		input: 260_000,
		output: 128_000,
	} satisfies ModelLimit;

	expect(resolveCompactionThreshold(limit)).toBe(195_000);
});

test("resolveCompactionThreshold falls back to context minus output", () => {
	const limit = {
		context: 400_000,
		output: 128_000,
	} satisfies ModelLimit;

	expect(resolveCompactionThreshold(limit)).toBe(204_000);
});

test("resolveCompactionThreshold returns undefined without model metadata", () => {
	expect(resolveCompactionThreshold(undefined)).toBeUndefined();
});

test("reachesContextThreshold is false below and true at the resolved limit", () => {
	const threshold = 195_000;

	expect(reachesContextThreshold(threshold - 1, threshold)).toBe(false);
	expect(reachesContextThreshold(threshold, threshold)).toBe(true);
});

test("isEligibleChildSession excludes sessions without a parent", () => {
	const rootSession = {
		title: "ordinary session",
	} satisfies SessionMetadata;

	expect(isEligibleChildSession(rootSession)).toBe(false);
});

test("isEligibleChildSession excludes Magic Context children", () => {
	const magicContextChild = {
		parentID: "root",
		title: "magic-context-123",
	} satisfies SessionMetadata;

	expect(isEligibleChildSession(magicContextChild)).toBe(false);
});

test("isEligibleChildSession accepts an ordinary child", () => {
	const ordinaryChild = {
		parentID: "root",
		title: "implementation worker",
	} satisfies SessionMetadata;

	expect(isEligibleChildSession(ordinaryChild)).toBe(true);
});

test("isCompletedNonCompactionAssistantMessage accepts a completed assistant message", () => {
	const message = {
		type: "assistant",
		time: { completed: 1 },
	} satisfies AssistantMessageMetadata;

	expect(isCompletedNonCompactionAssistantMessage(message)).toBe(true);
});

test("isCompletedNonCompactionAssistantMessage excludes non-assistant messages", () => {
	const compactionControl = {
		type: "compaction",
		time: { completed: 1 },
	} satisfies MessageMetadata;

	expect(isCompletedNonCompactionAssistantMessage(compactionControl)).toBe(
		false,
	);
});
