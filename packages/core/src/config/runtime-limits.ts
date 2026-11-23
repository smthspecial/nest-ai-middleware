import { MAX_TIMER_MS, readAiIntegerEnv } from "./environment.js";

export type AiRuntimeLimits = ReturnType<typeof readRuntimeLimits>;

export function readRuntimeLimits() {
  const runTimeoutMs = readAiIntegerEnv("RUN_TIMEOUT_MS", 30_000);
  const runLeaseMs = readAiIntegerEnv(
    "RUN_LEASE_MS",
    Math.max(35_000, runTimeoutMs + 5000),
    MAX_TIMER_MS + 5000,
  );
  if (runLeaseMs <= runTimeoutMs) {
    throw new TypeError(
      "NEST_AI_RUN_LEASE_MS must exceed NEST_AI_RUN_TIMEOUT_MS.",
    );
  }

  return Object.freeze({
    runTimeoutMs,
    runLeaseMs,
    transcriptPageSize: readAiIntegerEnv(
      "TRANSCRIPT_PAGE_SIZE",
      50,
      MAX_TIMER_MS - 1,
    ),
    conversationPageSize: readAiIntegerEnv(
      "CONVERSATION_PAGE_SIZE",
      20,
      MAX_TIMER_MS - 1,
    ),
    sessionReleaseTimeoutMs: readAiIntegerEnv(
      "SESSION_RELEASE_TIMEOUT_MS",
      250,
    ),
    storeReadTimeoutMs: readAiIntegerEnv("STORE_READ_TIMEOUT_MS", 5000),
    bookkeepingTimeoutMs: readAiIntegerEnv("BOOKKEEPING_TIMEOUT_MS", 100),
    logTimeoutMs: readAiIntegerEnv("LOG_TIMEOUT_MS", 100),
    maxModelRounds: readAiIntegerEnv("MAX_MODEL_ROUNDS", 10),
    maxToolCalls: readAiIntegerEnv("MAX_TOOL_CALLS", 20),
    maxAnswerBytes: readAiIntegerEnv("MAX_ANSWER_BYTES", 32_768),
    maxAttachmentNotesBytes: readAiIntegerEnv(
      "MAX_ATTACHMENT_NOTES_BYTES",
      8192,
    ),
    attachmentNotesTargetChars: readAiIntegerEnv(
      "ATTACHMENT_NOTES_TARGET_CHARS",
      2000,
    ),
    maxJsonDepth: readAiIntegerEnv("MAX_JSON_DEPTH", 24, 128),
  });
}
