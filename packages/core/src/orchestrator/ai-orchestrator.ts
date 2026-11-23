import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AiAttachmentError,
  assertAttachmentId,
} from "../attachments/ai-attachment.js";
import { AI_MODULE_OPTIONS } from "../config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../config/validate-options.js";
import { AiConversationSessions } from "../conversation/ai-conversation-sessions.js";
import { AiConversationError } from "../conversation/ai-conversation-error.js";
import type {
  AiConversationSession,
  AiConversationTurn,
} from "../contracts/ai-conversation.js";
import type {
  AiCaller,
  AiExecutionContext,
} from "../contracts/ai-execution-context.js";
import type { AiLogDetail } from "../contracts/ai-logger.js";
import type { AiMessage } from "../contracts/ai-model.js";
import type { AiRunOptions, AiRunResult } from "../contracts/ai-run.js";
import { AiToolError, AiToolExecutor } from "../executor/ai-tool-executor.js";
import { withSignal } from "../executor/with-signal.js";
import { AiRunBookkeeping } from "../logging/ai-run-bookkeeping.js";
import { writeRunLog } from "../logging/run-logging.js";
import { AiModelError } from "../model/ai-model-error.js";
import {
  AiPromptSecurity,
  AiSecurityError,
} from "../security/prompt-security.js";
import { AiAttachmentService } from "../services/ai-attachment.service.js";
import { assertAnswerText, runModelLoop } from "./ai-answer.js";
import {
  addAttachment,
  appendAttachmentNotes,
  prepareAttachments,
} from "./ai-attachments.js";
import { AiRunContext } from "./ai-run-context.js";

function runFailure(error: unknown, signal: AbortSignal) {
  if (error instanceof AiSecurityError || error instanceof AiConversationError)
    return error;
  if (signal.aborted) return new AiModelError("MODEL_TIMEOUT");
  if (error instanceof AiModelError || error instanceof AiAttachmentError)
    return error;
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

type OpenConversation = Awaited<ReturnType<AiConversationSessions["begin"]>>;

interface PreparedRun {
  caller: AiCaller;
  runId: string;
  invocation: AiRunContext["invocation"];
  question: string;
  history: ReturnType<typeof conversationMessages>;
  attachments: ReturnType<typeof prepareAttachments>;
  storedIds: string[];
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
    private readonly attachmentService: AiAttachmentService,
  ) {}

  async run(
    message: string,
    context: AiExecutionContext,
    runOptions: AiRunOptions = {},
  ): Promise<AiRunResult> {
    const request = this.prepareRun(message, context, runOptions);
    const { runId, caller, question, invocation } = request;
    let conversation: OpenConversation | undefined;
    let turnSaved = false;
    const run = await this.createRunContext(
      request,
      context,
      () => conversation?.session.id,
    );

    try {
      run.screenInput(question);
      if (this.sessions.enabled) {
        conversation = await this.sessions.begin(
          caller,
          runOptions.sessionId,
          runId,
          invocation.abortSignal,
        );
        await run.record?.attachSession(conversation.session.id);
      }

      const history = this.prepareHistory(request.history, conversation, run);
      await run.log({ stage: "input", message: question });
      const user = await this.prepareUserMessage(request, run);
      const reply = await this.answerRequest(
        [...history, { role: "user", content: user }],
        run,
        runOptions,
        {
          runId,
          ...(conversation ? { sessionId: conversation.session.id } : {}),
        },
      );

      if (conversation) {
        await this.saveTurn(
          conversation.session,
          user,
          reply,
          invocation.abortSignal,
        );
        turnSaved = true;
      }
      await this.recordSuccess(run, reply);
      return reply;
    } catch (error) {
      throw await this.recordFailure(run, error);
    } finally {
      if (conversation && !turnSaved) {
        await this.sessions.release(conversation.session, runId);
      }
    }
  }

  private prepareRun(
    message: string,
    context: AiExecutionContext,
    runOptions: AiRunOptions,
  ): PreparedRun {
    if (!context.caller.subjectId.trim()) throw new AiToolError("DENIED");
    if (typeof message !== "string") {
      throw new TypeError("Expected a text message.");
    }

    const attachments = prepareAttachments(
      runOptions.attachments === undefined ? [] : runOptions.attachments,
      this.options.attachmentModels,
    );
    const { attachmentIds = [] } = runOptions;
    if (!Array.isArray(attachmentIds))
      throw new AiAttachmentError("INVALID_ATTACHMENT");
    const storedIds = [...attachmentIds];
    for (const id of storedIds) assertAttachmentId(id);

    if (!message.trim() && !attachments.size && !storedIds.length) {
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
    const { limits } = this.options;
    const timeout = AbortSignal.timeout(limits.runTimeoutMs);
    const signal = AbortSignal.any([
      timeout,
      ...(context.abortSignal ? [context.abortSignal] : []),
    ]);
    return {
      caller,
      runId,
      invocation: { ...context, abortSignal: signal },
      question,
      history: conversationMessages(runOptions.history ?? []),
      attachments,
      storedIds,
    };
  }

  private async createRunContext(
    { runId, caller, invocation }: PreparedRun,
    context: AiExecutionContext,
    getSessionId: () => string | undefined,
  ): Promise<AiRunContext> {
    const log = (detail: AiLogDetail) =>
      writeRunLog(
        this.options.logger,
        runId,
        getSessionId(),
        caller,
        detail,
        this.options.limits.logTimeoutMs,
      );
    const record = await this.bookkeeping.start(runId, () => {
      void log({
        stage: "reasoning",
        event: "bookkeeping_error",
        code: "STORE_UNAVAILABLE",
      });
    });
    return new AiRunContext(context, invocation, this.security, record, log);
  }

  private prepareHistory(
    callerHistory: PreparedRun["history"],
    conversation: OpenConversation | undefined,
    run: AiRunContext,
  ) {
    const history = conversation
      ? conversationMessages(conversation.history)
      : callerHistory;
    if (history.length) run.screenInput(history.map(({ content }) => content));
    return history;
  }

  private async prepareUserMessage(
    { caller, attachments, storedIds, question }: PreparedRun,
    run: AiRunContext,
  ): Promise<string> {
    const signal = run.invocation.abortSignal;
    for (const id of storedIds) {
      const attachment = await withSignal(signal, () =>
        this.attachmentService.read(caller, id, signal),
      );
      addAttachment(attachments, attachment, this.options.attachmentModels);
    }
    return attachments.size
      ? appendAttachmentNotes(question, attachments, run, this.options.limits)
      : question;
  }

  private async answerRequest(
    messages: AiMessage[],
    run: AiRunContext,
    runOptions: AiRunOptions,
    identifiers: Pick<AiRunResult, "runId" | "sessionId">,
  ): Promise<AiRunResult> {
    const { model, limits } = this.options;
    const answer = await runModelLoop({
      messages,
      model,
      executor: this.executor,
      run,
      runOptions,
      limits,
    });
    run.screenOutput(answer.message);
    const reply: AiRunResult = { ...answer, ...identifiers };
    const presented = runOptions.presentAnswer
      ? runOptions.presentAnswer(Object.freeze(reply))
      : reply.message;
    assertAnswerText(presented, limits.maxAnswerBytes);
    if (presented !== reply.message) run.screenOutput(presented);
    return { ...reply, message: presented };
  }

  private saveTurn(
    session: AiConversationSession,
    user: string,
    { runId, message, tools, toolIds }: AiRunResult,
    signal: AbortSignal,
  ): Promise<void> {
    return this.sessions.finish(
      session,
      runId,
      { id: runId, user, assistant: message, tools, toolIds },
      signal,
    );
  }

  private async recordSuccess(
    run: AiRunContext,
    { message, toolIds }: AiRunResult,
  ) {
    await run.record?.finish("succeeded");
    await run.log({ stage: "output", message, toolIds });
  }

  private async recordFailure(run: AiRunContext, error: unknown) {
    const failure = runFailure(error, run.invocation.abortSignal);
    await run.record?.finish(run.failureOutcome(failure.code), failure.code);
    if (!(failure instanceof AiSecurityError)) {
      await run.log({
        stage: "reasoning",
        event: "run_rejected",
        code: failure.code,
      });
    }
    return failure;
  }
}
