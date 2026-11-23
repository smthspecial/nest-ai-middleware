---
id: ARCH-003
type: arch
title: "Middleware data-flow diagrams"
status: draft
created: 2026-11-21
linkedIds: ARCH-001,ARCH-002
---

# Middleware data-flow diagrams

Boxes name functions or operations, diamonds show branches, and arrow labels describe the data passed between steps. The host supplies the verified caller and the original Nest request context. [Component overview](arch-001.md), [public API and model protocol](arch-002.md).

## How the flows connect

`AiOrchestrator.run()` connects the chat paths. Startup supplies the tool registry. The database adapter supplies session history and stores conversation turns and run records for later reads.

```mermaid
flowchart TD
    Startup["1. Module startup builds the tool registry"] -.->|Registry used for tool discovery| Model
    Host(["Host backend"]) -->|Message, caller and options| Run["AiChatService.sendMessage() calls AiOrchestrator.run()"]
    Run -->|With a database adapter, after input checks| Open["4a. Create or resume the session and acquire its lease"]
    Run -->|Caller-managed history when storage is disabled| HasFiles{"Attachment groups present?"}
    Open -->|Session and ordered history| HasFiles
    HasFiles -->|Yes| Files["5. prepareUserMessage() calls appendAttachmentNotes()"]
    HasFiles -->|"No: question and history"| Model["2. runModelLoop()"]
    Files -->|User message with notes and history| Model
    Model -->|Execution-time guard denies a call| Denied["3. Wrap the tool denial"]
    Model -->|Model needs an earlier conversation| Recall["8. Search other sessions and load a selected turn"]
    Recall -->|Search or load result| Model
    Store -->|Saved turns for the verified owner| Recall
    Denied -.->|Tool error in messages| Model
    Model -->|Tool request fails screening| Rejected["6. Record run rejection when possible"]
    Rejected -->|If a session lease is held| Release["4b. Attempt to release the lease"]
    Rejected -->|Stateless run| Error(["Propagate the error to the host"])
    Release --> Error
    Model -->|Draft with an evaluator configured| Review["9. Evaluate the draft and optionally revise it"]
    Review -->|Selected draft| Present["answerRequest() screens and presents the answer"]
    Model -->|Final answer without an evaluator| Present
    Present -->|Session held| Save["4b. saveTurn() saves the turn and clears the lease"]
    Present -->|Stateless run| Reply(["Return AiRunResult"])
    Save -->|Result includes sessionId| Reply
    Save -->|Committed turn| Store[("Database adapter")]
    Rejected -.->|Run outcome when bookkeeping is configured| Store
    Host -->|Separate conversation or run read| Reads["7. Read stored records"]
    Store -->|Caller-scoped records| Reads
```

[1. Startup](#1-register-the-module-and-discover-tools) · [2. Model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback) · [3. Tool denial](#3-handle-an-execution-time-tool-denial) · [4. Session lifecycle](#4-manage-the-conversation-session) · [5. Attachments](#5-process-inline-files-and-stored-attachments) · [6. Run rejection](#6-reject-a-run-when-tool-request-screening-fails) · [7. Stored reads](#7-read-stored-conversations-and-run-records) · [8. History recall](#8-recall-a-turn-from-another-session) · [9. Answer evaluation](#9-evaluate-the-answer-before-presentation)

## 1. Register the module and discover tools

```mermaid
flowchart TD
    Sync(["AiModule.forRoot()"]) -->|Options| Validate["validateOptions()"]
    Async(["AiModule.forRootAsync()"]) --> Factory["Await the host options factory"]
    Factory -->|Options| Validate
    Validate -->|Validated options injected by Nest| Registry["AiToolRegistry.onApplicationBootstrap()"]
    Registry -->|Discovered Nest provider classes| Methods["decoratedMethods()"]
    Methods -->|Method and AiTool metadata| Compile["Validate registration and compile the input schema"]
    Compile -->|Tool name, definition, validator, provider and guards| Ready(["Tool registry ready"])
```

The `@AiTool()` decorator adds metadata to the service method. The registry resolves the owning Nest module when it builds the tool entry. Runtime discovery in the model loop checks the caller's access to those entries. [Model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback), [module registration](../../../packages/core/src/ai.module.ts), [tool registry](../../../packages/core/src/config/ai-tool-registry.ts).

## 2. Answer from context, call a tool, or return a fallback

`runModelLoop()` gives the model system instructions to answer from existing context, request an eligible tool for fresh application data or an action, and return a fallback for out-of-domain requests. The host can define the application domain and fallback in its own model instructions. The middleware follows the model's `AiModelResponse.kind`.

A saved chat loads history before entering this loop and commits the accepted turn after presentation. [Loading history](#4a-acquire-the-lease-and-load-history), [saving the turn](#4b-save-the-accepted-turn-or-release-the-lease).

```mermaid
flowchart TD
    Host(["AiChatService.sendMessage()"]) -->|Message, verified caller context and options| Run["AiOrchestrator.run() prepares the model input"]
    Run -->|Prepared messages and caller context| Start["runModelLoop() adds chat response instructions"]
    Start --> Discover["AiToolExecutor.discover() checks service and method guards"]
    Discover --> Merge["Include history tools when available"]
    Merge -->|Messages and allowed tool definitions| Model["AiRunContext.callModel()"]
    Model -->|AiModelResponse| Kind{"Response kind and round budget?"}
    Kind -->|"final: answer from context or tool results, or fallback"| Final["assertAnswerText() validates the proposed answer"]
    Final -->|Evaluator configured| Review["9. Review the draft and optionally revise it"]
    Review -->|Selected draft| Assemble["finalizeAnswer() collects successful tool IDs"]
    Final -->|Evaluator absent| Assemble
    Assemble -->|Message, tools and toolIds| Present["answerRequest() screens and presents the answer"]
    Present -->|Session held| Save["4b. AiConversationSessions.finish() saves the accepted turn"]
    Save -->|Turn committed| Reply(["Return AiRunResult to host"])
    Present -->|Stateless run| Reply
    Kind -->|tool-calls and another round available| ToolRound["runToolRound()"]
    ToolRound --> Screen["validateToolCalls() then screenToolRequest()"]
    Kind -->|Unexpected kind or tool calls on the last round| Error(["Throw MODEL_PROTOCOL_ERROR"])
    Screen -->|Screened calls with IDs, names and arguments| Invoke["invokeTool() delegates to attemptToolCall()"]
    Invoke -->|Internal history call| Recall["8. Search or load history and record the result"]
    Recall --> Append
    Invoke -->|Tool name, arguments and Nest context| Execute["AiToolExecutor.execute() validates arguments and rechecks guards"]
    Execute -->|Arguments pass screening| Service["invokeServiceMethod() resolves the service in the original contextId and calls it"]
    Service -->|JSON snapshot| Result["execute() screens the result and invokeTool() records the attempt"]
    Result -->|Successful tool result| Append["runToolRound() appends a tool message for each call in order"]
    Append -.->|Assistant calls and tool results in messages| Model
```

`runToolRound()` validates and screens the batch, then appends the assistant's tool-call message before dispatch. Each tool result carries the corresponding call ID, and the next round receives the updated message list. The final reply's `tools` and `toolIds` list successful calls and are empty when the model answers on the first round. A denied tool call produces a result for the next round. A screening failure exits the loop and reaches the orchestrator's error path. [Tool denial](#3-handle-an-execution-time-tool-denial), [run rejection](#6-reject-a-run-when-tool-request-screening-fails), [model loop implementation](../../../packages/core/src/orchestrator/ai-answer.ts).

## 3. Handle an execution-time tool denial

This path begins after discovery has offered the tool and the model has requested it.

```mermaid
flowchart TD
    Call(["invokeTool() receives a screened call"]) -->|Name, arguments and caller context| Execute["AiToolExecutor.execute() validates the arguments"]
    Execute --> Guard{"Service and method guards allow execution?"}
    Guard -->|Yes| Service(["Screen arguments before invokeServiceMethod()"])
    Guard -->|No| Error["Throw AiToolError with code DENIED"]
    Error --> Wrap["invokeTool() records the attempt when bookkeeping is enabled"]
    Wrap -->|Failed tool result with code DENIED| Append["runToolRound() appends a tool message with the call ID"]
    Append -.->|Messages with the failed tool result| Model(["AiRunContext.callModel() starts the next round"])
```

The guard denial stops dispatch before the service method. Once the batch is processed, the model can answer or request another tool within the remaining limits. The session lease stays with the chat run throughout the loop. [Model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback), [session lifecycle](#4-manage-the-conversation-session), [tool executor](../../../packages/core/src/executor/ai-tool-executor.ts).

## 4. Manage the conversation session

`sessionId` identifies a conversation across requests. `runId` identifies one request and owns its lease while that request is in flight. With a database adapter configured, the host omits `sessionId` to start a conversation and sends the returned ID with the same verified subject and tenant to resume it.

### 4a. Acquire the lease and load history

`AiOrchestrator.run()` rejects nonempty caller-supplied history when session storage is enabled. With storage disabled, it accepts caller-managed history and rejects `sessionId` with `SESSION_UNAVAILABLE`. For a saved chat, `createRunContext()` sets up logging and attempts to start run bookkeeping. The orchestrator then screens the question before calling `begin()`.

```mermaid
flowchart TD
    Begin(["AiConversationSessions.begin()"]) --> Id{"sessionId supplied?"}
    Id -->|No| Create["Generate sessionId and set create to true"]
    Id -->|Yes| Resume["Validate sessionId and set create to false"]
    Resume -->|Malformed ID| Unavailable(["Throw SESSION_UNAVAILABLE"])
    Create -->|Session, caller, runId, create flag and lease expiry| Acquire["adapter.beginConversation()"]
    Resume -->|Session, caller, runId, create flag and lease expiry| Acquire
    Acquire --> Status{"Lease status?"}
    Acquire -->|Store call fails| StoreError(["Propagate the store or abort error"])
    Status -->|Session missing or caller does not own it| Unavailable
    Status -->|Another run holds the lease| Busy(["Throw SESSION_BUSY"])
    Status -->|Ready, new session| Empty["Start with empty history"]
    Status -->|Ready, existing session| History["loadHistory() pages through adapter.listConversationTurns()"]
    Empty --> Ready["Return session and history to the orchestrator"]
    History -->|Ordered user and assistant turns| Ready
    History -->|Read fails| Release(["begin() calls release() and propagates the error"])
    Ready -->|Empty or loaded history| Attach["Track held lease and attach sessionId to the run record when available"]
    Attach --> Screen(["prepareHistory() screens history before model input is assembled"])
```

The adapter scopes the lease to the session owner. Another run can acquire the lease after it is released or expires. History enters the model loop alongside the current user message, which may include attachment notes. [Attachments](#5-process-inline-files-and-stored-attachments), [model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback), [session implementation](../../../packages/core/src/conversation/ai-conversation-sessions.ts).

### 4b. Save the accepted turn or release the lease

```mermaid
flowchart TD
    Held(["Session lease held by runId"]) --> Outcome{"Answer passed screening and presentation?"}
    Outcome -->|Yes| Finish["AiConversationSessions.finish()"]
    Finish -->|Session, runId and turn| Save["adapter.finishConversation() saves the turn and clears the lease"]
    Save -->|Commit succeeds| Record["recordSuccess() marks the run succeeded when a record exists"]
    Record -->|AiRunResult with sessionId| Reply(["Host can reuse sessionId on the next message"])
    Outcome -->|Run fails before answer acceptance| Catch["AiOrchestrator.run() records the failure when possible"]
    Save -->|Commit fails| Catch
    Catch -->|finally block with held lease| Release["AiConversationSessions.release()"]
    Release -->|Session, runId and discardIfEmpty| Cleanup["adapter.finishConversation() attempts cleanup"]
    Cleanup -->|Cleanup attempt completes| Error(["Propagate run failure to host"])
```

The accepted turn stores the user message, presented answer, and successful tool identifiers. `release()` uses a separate cleanup timeout and asks the adapter to discard the session if it is empty. If cleanup fails, the lease remains eligible for takeover after its expiry. Both conversation reads and run reads use the same configured adapter. [Run rejection](#6-reject-a-run-when-tool-request-screening-fails), [stored reads](#7-read-stored-conversations-and-run-records), [orchestrator](../../../packages/core/src/orchestrator/ai-orchestrator.ts), [database contract](../../../packages/core/src/contracts/ai-database.ts).

## 5. Process inline files and stored attachments

```mermaid
flowchart TD
    Host(["AiChatService.sendMessage()"]) -->|Question, attachments and attachmentIds| Run["AiOrchestrator.run()"]
    Run -->|Inline attachments from initial validation| Inline["prepareAttachments() normalizes each file"]
    Run -->|Caller and attachment IDs after input and history checks| Stored["AiAttachmentService.read() reads caller-owned files"]
    Inline -->|Normalized attachment| Group["addAttachment() groups files by configured model"]
    Stored -->|Normalized attachment from storage adapter| Group
    Group -->|Map of attachment models to file groups| Build["appendAttachmentNotes()"]
    Build -->|Question, group of file bytes and empty tool list| Extract["AiRunContext.callModel() calls the attachment model for each group"]
    Extract -->|Final reference notes| Screen["AiRunContext.screenInput()"]
    Screen -->|Notes pass screening| Merge["appendAttachmentNotes() adds the notes to the question"]
    Merge -->|Enriched user message text| Answer(["runModelLoop() calls the main model"])
```

`AiAttachmentService.create()` gives the caller an ID for later requests. The attachment model receives the file bytes. The enriched user message enters the model loop and becomes the saved user turn when a session is active. [Model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback), [saving the turn](#4b-save-the-accepted-turn-or-release-the-lease), [attachment processing](../../../packages/core/src/orchestrator/ai-attachments.ts).

## 6. Reject a run when tool request screening fails

```mermaid
flowchart TD
    Calls(["runModelLoop() receives model tool calls"]) -->|Validated batch| Screen["screenToolRequest() screens optional model text and every argument object"]
    Screen --> Allowed{"Whole batch passes screening?"}
    Allowed -->|Yes| Invoke(["Continue to invokeTool()"])
    Allowed -->|No| Failure["Throw AiSecurityError with code SECURITY_REJECTED"]
    Failure -->|Original security error| Catch["AiOrchestrator.run() records rejected when bookkeeping is enabled"]
    Catch --> Held{"Session lease held?"}
    Held -->|Yes| Release["AiConversationSessions.release() attempts lease cleanup"]
    Held -->|No| Reject(["Reject the promise returned to the host"])
    Release --> Reject
```

Screening checks the entire batch before any tool executes. A rejection reaches the session cleanup path if the run already acquired a lease. [Model and tool loop](#2-answer-from-context-call-a-tool-or-return-a-fallback), [releasing the lease](#4b-save-the-accepted-turn-or-release-the-lease), [run failure and cleanup](../../../packages/core/src/orchestrator/ai-orchestrator.ts).

## 7. Read stored conversations and run records

```mermaid
flowchart TD
    Host(["Host backend with verified caller"])
    Host -->|Caller and optional list cursor| List["AiChatService.listConversations()"]
    Host -->|Session ID, caller and optional turn cursor| Chat["AiChatService.readConversation()"]
    Host -->|Run ID, caller and optional event cursor| Run["AiChatService.readRun()"]
    List --> Sessions["AiConversationSessions.list()"]
    Chat --> Turns["AiConversationSessions.read()"]
    Run --> Reader["AiRunReader.readRun()"]
    Sessions -->|"adapter.listConversations()"| ConversationRows[("Conversation summaries")]
    Turns -->|"adapter.listConversationTurns()"| TurnRows[("Saved turns")]
    Reader -->|"adapter.readRun()"| RunRows[("Run and events")]
    ConversationRows --> ListPage(["AiConversationListPage"])
    TurnRows --> ChatPage(["AiConversationPage"])
    RunRows --> RunPage(["AiRunPage or undefined"])
```

These are separate host calls that retrieve the committed turns and run records. Each cursor belongs to its own result type. [Session lifecycle](#4-manage-the-conversation-session), [chat service](../../../packages/core/src/services/ai-chat.service.ts), [run reader](../../../packages/core/src/logging/ai-run-reader.ts).

## 8. Recall a turn from another session

An active session and a database adapter that implements `searchConversationTurns()` make recall available. The model chooses when to search. The adapter searches the verified caller's committed turns across other sessions and returns at most five matches. `createHistoryTools()` holds those turns for the current run and gives the model question previews and keyword matches. Only a later load call with a candidate ID can put that candidate's full question and answer into context. [Session lifecycle](#4-manage-the-conversation-session) · [History tools](../../../packages/core/src/orchestrator/ai-history-tools.ts).

```mermaid
flowchart TD
    Model["2. Chat model sees the current transcript and available tools"] --> Need{"Does the request need earlier sessions?"}
    Need -->|Yes| Search["Call nest_ai_search_history with keywords"]
    Search --> Query["searchConversationTurns() scopes matches to the user and tenant"]
    Query --> Preview["Return previews and keep the full matches in the run"]
    Preview --> Relevant{"Model finds a relevant candidate?"}
    Relevant -->|Yes| Load["Call nest_ai_load_history with the candidate ID"]
    Load -->|Screened question and answer as a tool result| Model
    Relevant -->|No| Proceed["Continue with regular tools or answer"]
    Need -->|No| Proceed
```

## 9. Evaluate the answer before presentation

When `answerEvaluator` is configured, `reviewAndReviseAnswer()` compares the proposed answer to the current request and the evidence available in the run. A low score triggers one text-only revision. A valid revised draft receives a second review, and the higher-scoring draft proceeds to presentation and session save. [Model loop](#2-answer-from-context-call-a-tool-or-return-a-fallback) · [Evaluator](../../../packages/core/src/orchestrator/ai-answer-evaluator.ts).

```mermaid
flowchart TD
    Draft["2. Model returns a proposed answer"] --> Review["Evaluator scores the draft against the request and evidence"]
    Review --> Complete{"Draft meets the request?"}
    Complete -->|Yes| Present["answerRequest() screens and presents the selected draft"]
    Complete -->|No| Revise["Chat model revises once using feedback and existing evidence"]
    Revise --> Changed{"Valid draft with changed text?"}
    Changed -->|No, keep original draft| Present
    Changed -->|Yes| Recheck["Evaluator scores the revised draft"]
    Recheck --> Select["Keep the higher-scoring draft"]
    Select --> Present
    Present -->|Session held| Save["4b. Save the accepted turn"]
    Present -->|Stateless run| Reply["Return AiRunResult"]
    Save --> Reply
```
