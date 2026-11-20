import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import { AiConversationSessions } from "../conversation/ai-conversation-sessions.js";
import { AiConversationError } from "../conversation/ai-conversation-error.js";
import type {
  AiConversationSession,
  AiConversationTurn,
} from "../contracts/ai-conversation.js";
import type { AiExecutionContext } from "../contracts/ai-execution-context.js";
import type { AiLogDetail } from "../contracts/ai-logger.js";
import type { AiRunOptions, AiRunResult } from "../contracts/ai-run.js";
import { AiToolError, AiToolExecutor } from "../executor/ai-tool-executor.js";
import { AiRunBookkeeping } from "../logging/ai-run-bookkeeping.js";
import { writeRunLog } from "../logging/run-logging.js";
import { AiModelError } from "../model/ai-model-error.js";
import {
  AiPromptSecurity,
  AiSecurityError,
} from "../security/prompt-security.js";
import { assertAnswerText, generateAnswer } from "./ai-answer.js";
import { buildUserMessage, prepareAttachments } from "./ai-attachments.js";
import { AiRunContext } from "./ai-run-context.js";

const RUN_TIMEOUT_MS = 30_000;

function runFailure(error: unknown, signal: AbortSignal) {
  if (error instanceof AiSecurityError || error instanceof AiConversationError)
    return error;
  if (signal.aborted) return new AiModelError("MODEL_TIMEOUT");
  if (error instanceof AiModelError) return error;
  return new AiModelError("MODEL_PROTOCOL_ERROR");
}

function conversationMessages(
  turns: readonly AiConversationTurn[],
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const { user, assistant } of turns) {
    if (typeof user !== "string" || typeof assistant !== "string") {
      throw new TypeError("Conversation messages must be text.");
    }
    messages.push(
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    );
  }
  return messages;
}

@Injectable()
export class AiOrchestrator {
  constructor(
    @Inject(AI_MODULE_OPTIONS)
    private readonly options: ValidatedAiModuleOptions,
    private readonly executor: AiToolExecutor,
    private readonly security: AiPromptSecurity,
    private readonly sessions: AiConversationSessions,
    private readonly bookkeeping: AiRunBookkeeping,
  ) {}

  async run(
    message: string,
    context: AiExecutionContext,
    runOptions: AiRunOptions = {},
  ): Promise<AiRunResult> {
    if (!context.caller.subjectId.trim()) throw new AiToolError("DENIED");
    if (typeof message !== "string") {
      throw new TypeError("Expected a text message.");
    }

    const attachments = prepareAttachments(
      runOptions.attachments === undefined ? [] : runOptions.attachments,
      this.options.attachmentModels,
    );
    if (!message.trim() && !attachments.size) {
      throw new TypeError("Expected a message or an attachment.");
    }
    const question = message.trim() ? message : "Summarize the attached files.";

    if (this.sessions.enabled && runOptions.history?.length) {
      throw new TypeError(
        "Stored conversations load history from the configured store.",
      );
    }
    if (!this.sessions.enabled && runOptions.sessionId !== undefined) {
      throw new AiConversationError("SESSION_UNAVAILABLE");
    }

    const { subjectId, tenantId } = context.caller;
    const caller = {
      subjectId,
      ...(tenantId !== undefined ? { tenantId } : {}),
    };
    const runId = randomUUID();
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const signal = AbortSignal.any([
      timeout,
      ...(context.abortSignal ? [context.abortSignal] : []),
    ]);
    const invocation = { ...context, abortSignal: signal };

    let history = conversationMessages(runOptions.history ?? []);
    let session: AiConversationSession | undefined;
    let leaseHeld = false;

    const log = (detail: AiLogDetail) =>
      writeRunLog(this.options.logger, runId, session?.id, caller, detail);
    const record = await this.bookkeeping.start(runId, () => {
      void log({
        stage: "reasoning",
        event: "bookkeeping_error",
        code: "STORE_UNAVAILABLE",
      });
    });
    const run = new AiRunContext(
      context,
      invocation,
      this.security,
      record,
      log,
    );

    try {
      run.screenInput(question);

      if (this.sessions.enabled) {
        const stored = await this.sessions.begin(
          caller,
          runOptions.sessionId,
          runId,
          signal,
        );
        session = stored.session;
        leaseHeld = true;
        await record?.attachSession(session.id);
        history = conversationMessages(stored.history);
      }
      if (history.length) {
        run.screenInput(history.map((entry) => entry.content));
      }
      await log({ stage: "input", message: question });

      const user = await buildUserMessage(question, attachments, run);
      const answer = await generateAnswer({
        messages: [...history, { role: "user", content: user }],
        model: this.options.model,
        executor: this.executor,
        run,
        runOptions,
      });

      run.screenOutput(answer.message);
      const reply: AiRunResult = {
        ...answer,
        runId,
        ...(session ? { sessionId: session.id } : {}),
      };
      const presented = runOptions.presentAnswer
        ? runOptions.presentAnswer(Object.freeze(reply))
        : reply.message;
      assertAnswerText(presented);
      if (presented !== reply.message) {
        run.screenOutput(presented);
      }

      if (session) {
        await this.sessions.finish(
          session,
          runId,
          {
            id: runId,
            user,
            assistant: presented,
            tools: reply.tools,
            toolIds: reply.toolIds,
          },
          signal,
        );
        leaseHeld = false;
      }

      await record?.finish("succeeded");
      await log({
        stage: "output",
        message: presented,
        toolIds: reply.toolIds,
      });
      return { ...reply, message: presented };
    } catch (error) {
      const failure = runFailure(error, signal);
      await record?.finish(run.failureOutcome(failure.code), failure.code);
      if (!(failure instanceof AiSecurityError)) {
        await log({
          stage: "reasoning",
          event: "run_rejected",
          code: failure.code,
        });
      }
      throw failure;
    } finally {
      if (session && leaseHeld) await this.sessions.release(session, runId);
    }
  }
}
