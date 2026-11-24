import { describe, expect, it, jest } from "@jest/globals";
import { Module } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AI_MODULE_OPTIONS } from "../src/config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../src/config/validate-options.js";
import { AiChatService, AiModule } from "../src/index.js";
import type { AiModel, AiModuleOptions } from "../src/index.js";

const model: AiModel = {
  async generate() {
    return { kind: "final", message: "Offline reply" };
  },
};
const options: AiModuleOptions = { model };

const HOST_MODEL = Symbol("HOST_MODEL");

@Module({
  providers: [{ provide: HOST_MODEL, useValue: model }],
  exports: [HOST_MODEL],
})
class HostDependenciesModule {}

describe("AiModule", () => {
  it("reviews the draft against the question and returns an improved revision without requiring storage", async () => {
    const question = "Give the due date and owner.";
    const draft = "The due date is Friday.";
    const revision = "The due date is Friday. The owner is unknown.";
    const chatModel = jest
      .fn<AiModel["generate"]>()
      .mockResolvedValueOnce({ kind: "final", message: draft })
      .mockResolvedValueOnce({ kind: "final", message: revision });
    const review = jest
      .fn<AiModel["generate"]>()
      .mockResolvedValueOnce({
        kind: "final",
        message: '{"score":2,"feedback":"Address the missing owner."}',
      })
      .mockResolvedValueOnce({
        kind: "final",
        message: '{"score":3,"feedback":""}',
      });
    const fixture = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          model: { generate: chatModel },
          answerEvaluator: { generate: review },
        }),
      ],
    }).compile();
    try {
      await fixture.init();
      const chat = fixture.get(AiChatService);
      await expect(
        chat.sendMessage(question, {
          caller: { subjectId: "reader" },
          contextId: ContextIdFactory.create(),
        }),
      ).resolves.toMatchObject({ message: revision, tools: [] });
      expect(chatModel.mock.calls[0][0].tools).toEqual([]);
      expect(chatModel.mock.calls[1][0].tools).toEqual([]);
      const reviewedDrafts = review.mock.calls.map(([{ messages }]) => {
        const user = messages.find((message) => message.role === "user");
        if (user?.role !== "user") throw new Error("Missing review input");
        return JSON.parse(user.content);
      });
      expect(reviewedDrafts).toEqual([
        expect.objectContaining({ request: question, draft }),
        expect.objectContaining({ request: question, draft: revision }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("registers an initialized model with the default timeout", async () => {
    const registeredModule = AiModule.forRoot(options);
    const fixture = await Test.createTestingModule({
      imports: [registeredModule],
    }).compile();
    try {
      await fixture.init();
      const config = fixture
        .select(registeredModule)
        .get<ValidatedAiModuleOptions>(AI_MODULE_OPTIONS, { strict: true });

      expect(config.model).toBe(model);
      expect(config.promptSecurity).toEqual({ input: true, output: true });
      expect(config.execution.toolTimeoutMs).toBe(10_000);
    } finally {
      await fixture.close();
    }
  });

  it("awaits a factory with dependencies exported by a host module", async () => {
    const registeredModule = AiModule.forRootAsync({
      imports: [HostDependenciesModule],
      inject: [HOST_MODEL],
      async useFactory(hostModel: AiModel) {
        return { model: hostModel };
      },
    });
    const fixture = await Test.createTestingModule({
      imports: [registeredModule],
    }).compile();
    try {
      await fixture.init();
      const config = fixture
        .select(registeredModule)
        .get<ValidatedAiModuleOptions>(AI_MODULE_OPTIONS, { strict: true });

      expect(config.model).toBe(model);
      expect(config.model).toBe(model);
    } finally {
      await fixture.close();
    }
  });

  it("passes large inputs through the chat service and routes attachments by the host MIME map", async () => {
    let extractionCalls = 0;
    const message = "Review this product note. ".repeat(11_000);
    const files = Array.from({ length: 5 }, () => ({
      mediaType: "text/plain",
      data: Buffer.alloc(2 * 1024 * 1024),
    }));
    files[0].data = Buffer.alloc(4 * 1024 * 1024 + 1);
    const extractor: AiModel = {
      async generate({ attachments, tools }) {
        extractionCalls++;
        expect(tools).toEqual([]);
        expect(
          attachments?.map((file) => [file.mediaType, file.data.byteLength]),
        ).toEqual(files.map((file) => [file.mediaType, file.data.byteLength]));
        return { kind: "final", message: "A short note." };
      },
    };
    const fixture = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          model: {
            ...model,
            async generate({ messages }) {
              expect(messages.at(-1)).toEqual({
                role: "user",
                content: `${message}\n\nAttachment reference notes (text/plain):\nA short note.`,
              });
              return { kind: "final", message: "Offline reply" };
            },
          },
          attachmentModels: { "text/plain": extractor },
        }),
      ],
    }).compile();
    try {
      await fixture.init();
      const chat = fixture.get(AiChatService);
      const context = {
        caller: { subjectId: "reader" },
        contextId: ContextIdFactory.create(),
      };
      await expect(
        chat.sendMessage("Read it.", context, {
          attachments: [
            { mediaType: "application/pdf", data: Buffer.from("data") },
          ],
        }),
      ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_CONFIGURED" });
      await expect(
        chat.sendMessage(message, context, { attachments: files }),
      ).resolves.toMatchObject({ message: "Offline reply" });
      expect(extractionCalls).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    [{ model: {} }, /chat model must implement generate\(\)/],
    [{ answerEvaluator: {} }, /answerEvaluator must implement generate\(\)/],
    [
      { attachmentModels: { "text/plain": {} } },
      /attachment model must implement generate\(\)/,
    ],
    [
      { authorization: {} },
      /Move AiModule authorization checks into Nest service guards/,
    ],
    [{ promptSecurity: false }, /NEST_AI_PROMPT_SECURITY/],
    [{ execution: { toolTimeoutMs: 250 } }, /NEST_AI_TOOL_TIMEOUT_MS/],
    [
      { attachmentStorage: { directory: "/assets" } },
      /NEST_AI_ATTACHMENT_STORAGE_DIRECTORY/,
    ],
    [{ services: [] }, /before removing the AiModule services option/],
    [{ database: { filename: ":memory:" } }, /database\.adapter/],
    [{ database: { adapter: {} } }, /implementing AiDatabaseAdapter/],
    [{ database: { filename: ":memory:", adapter: {} } }, /database\.adapter/],
    [{ conversation: { filename: ":memory:" } }, /database\.adapter/],
    [
      { selectConversationHistory: () => [] },
      /Resumed conversations now use the full saved history/,
    ],
    [{ attachmentModels: { image: model } }, /full lowercase MIME types/],
  ])(
    "rejects invalid configuration %o during bootstrap",
    async (overrides, error) => {
      const invalidOptions = { ...options, ...overrides } as AiModuleOptions;
      await expect(
        Test.createTestingModule({
          imports: [AiModule.forRoot(invalidOptions)],
        }).compile(),
      ).rejects.toThrow(error);
    },
  );

  it("reads environment settings at bootstrap", async () => {
    const env = jest.replaceProperty(process, "env", {
      ...process.env,
      NEST_AI_RUN_TIMEOUT_MS: "45000",
      NEST_AI_TOOL_TIMEOUT_MS: "420",
      NEST_AI_MAX_ANSWER_BYTES: "5",
      NEST_AI_PROMPT_SECURITY: "false",
      NEST_AI_PROMPT_SECURITY_OUTPUT: "true",
      NEST_AI_ALLOW_WRITES: "true",
    });
    const registered = AiModule.forRootAsync({ useFactory: () => options });
    try {
      const fixture = await Test.createTestingModule({
        imports: [registered],
      }).compile();
      try {
        const config = fixture
          .select(registered)
          .get<ValidatedAiModuleOptions>(AI_MODULE_OPTIONS, { strict: true });
        expect(config.execution).toEqual({
          toolTimeoutMs: 420,
          allowWrites: true,
        });
        expect(config.promptSecurity).toEqual({ input: false, output: true });
        expect(config.limits.runLeaseMs).toBe(50_000);
        await expect(
          fixture.get(AiChatService).sendMessage("Hello", {
            caller: { subjectId: "reader" },
            contextId: ContextIdFactory.create(),
          }),
        ).rejects.toMatchObject({ code: "MODEL_PROTOCOL_ERROR" });
      } finally {
        await fixture.close();
      }
    } finally {
      env.restore();
    }
  });

  it.each([
    [{ NEST_AI_RUN_LEASE_MS: "30000" }, /RUN_LEASE_MS must exceed/],
    [{ NEST_AI_RUN_TIMEOUT_MS: "2.5" }, /RUN_TIMEOUT_MS must be an integer/],
    [{ NEST_AI_TOOL_TIMEOUT_MS: "" }, /TOOL_TIMEOUT_MS must be an integer/],
    [
      { NEST_AI_TOOL_TIMEOUT_MS: "2147483648" },
      /TOOL_TIMEOUT_MS must be an integer/,
    ],
    [
      { NEST_AI_PROMPT_SECURITY_INPUT: "off" },
      /PROMPT_SECURITY_INPUT must be true or false/,
    ],
    [{ NEST_AI_ALLOW_WRITES: "1" }, /ALLOW_WRITES must be true or false/],
    [
      { NEST_AI_ATTACHMENT_STORAGE_DIRECTORY: " " },
      /ATTACHMENT_STORAGE_DIRECTORY must be a nonempty path/,
    ],
  ])(
    "rejects malformed or inconsistent environment settings %o",
    async (settings, error) => {
      const env = jest.replaceProperty(process, "env", {
        ...process.env,
        ...settings,
      });
      try {
        await expect(
          Test.createTestingModule({
            imports: [AiModule.forRoot(options)],
          }).compile(),
        ).rejects.toThrow(error);
      } finally {
        env.restore();
      }
    },
  );
});
