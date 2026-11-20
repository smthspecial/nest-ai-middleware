import { describe, expect, it } from "@jest/globals";
import { Module } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AI_MODULE_OPTIONS } from "../src/config/validate-options.js";
import type { ValidatedAiModuleOptions } from "../src/config/validate-options.js";
import { AiChatService, AiModule } from "../src/index.js";
import type { AiModel, AiModuleOptions } from "../src/index.js";

const model: AiModel = {
  capabilities: { toolCalling: false },
  async generate() {
    return { kind: "final", message: "Offline reply" };
  },
};
const options: AiModuleOptions = { model };

const HOST_MODEL = Symbol("HOST_MODEL");
const HOST_TOOL_TIMEOUT = Symbol("HOST_TOOL_TIMEOUT");

@Module({
  providers: [
    { provide: HOST_MODEL, useValue: model },
    { provide: HOST_TOOL_TIMEOUT, useValue: 250 },
  ],
  exports: [HOST_MODEL, HOST_TOOL_TIMEOUT],
})
class HostDependenciesModule {}

describe("AiModule", () => {
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
      inject: [HOST_MODEL, HOST_TOOL_TIMEOUT],
      async useFactory(hostModel: AiModel, toolTimeoutMs: number) {
        return { model: hostModel, execution: { toolTimeoutMs } };
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
      expect(config.execution.toolTimeoutMs).toBe(250);
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
      capabilities: { toolCalling: false },
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
    [{ model: { capabilities: { toolCalling: true } } }, /generate\(\)/],
    [{ model: { ...model, capabilities: {} } }, /capabilities\.toolCalling/],
    [
      {
        model: {
          ...model,
          capabilities: { toolCalling: false, structuredOutput: "yes" },
        },
      },
      /structuredOutput/,
    ],
    [
      { authorization: {} },
      /Move AiModule authorization checks into Nest service guards/,
    ],
    [{ promptSecurity: "false" }, /promptSecurity must be a boolean/],
    [
      { promptSecurity: { enabled: false } },
      /promptSecurity must be a boolean/,
    ],
    [{ promptSecurity: null }, /promptSecurity must be a boolean/],
    [
      { promptSecurity: { input: "false" } },
      /promptSecurity.input and output must be booleans/,
    ],
    [
      { promptSecurity: { output: null } },
      /promptSecurity.input and output must be booleans/,
    ],
    [{ services: [] }, /before removing the AiModule services option/],
    [{ execution: null }, /execution must be an object/],
    [{ database: { filename: ":memory:" } }, /database\.adapter/],
    [{ database: { adapter: {} } }, /implementing AiDatabaseAdapter/],
    [{ database: { filename: ":memory:", adapter: {} } }, /database\.adapter/],
    [{ conversation: { filename: ":memory:" } }, /database\.adapter/],
    [
      { selectConversationHistory: () => [] },
      /Resumed conversations now use the full saved history/,
    ],
    [{ attachmentModels: { image: model } }, /full lowercase MIME types/],
    [{ execution: { toolTimeoutMs: 0 } }, /execution\.toolTimeoutMs/],
    [
      { execution: { toolTimeoutMs: 2_147_483_648 } },
      /execution\.toolTimeoutMs/,
    ],
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

  it("validates the resolved async configuration during bootstrap", async () => {
    const registeredModule = AiModule.forRootAsync({
      useFactory: () => ({ ...options, execution: { toolTimeoutMs: 1.5 } }),
    });

    await expect(
      Test.createTestingModule({ imports: [registeredModule] }).compile(),
    ).rejects.toThrow(/execution\.toolTimeoutMs/);
  });
});
