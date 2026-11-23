import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, jest } from "@jest/globals";
import { Inject, Injectable, Scope } from "@nestjs/common";
import { ContextIdFactory, REQUEST } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  AiAttachmentService,
  AiChatService,
  AiModule,
  AiTool,
} from "../src/index.js";
import type {
  AiAttachmentStorageAdapter,
  AiCaller,
  AiModel,
  AiModuleOptions,
} from "../src/index.js";

const caller = { subjectId: "reader", tenantId: "retail" };
const attachment = {
  mediaType: "text/plain",
  filename: "reports/Q4.txt",
  data: Buffer.from("Revenue was 120 dollars.\n"),
};
const model: AiModel = {
  capabilities: { toolCalling: true },
  async generate() {
    return { kind: "final", message: "Offline reply" };
  },
};

@Injectable({ scope: Scope.REQUEST })
class AttachmentTools {
  constructor(
    @Inject(REQUEST) private readonly request: { caller: AiCaller },
    private readonly attachments: AiAttachmentService,
  ) {}

  @AiTool({
    name: "get_attachment",
    description: "Get attachment metadata by ID.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  })
  async getAttachment({ id }: { id: string }) {
    const file = await this.attachments.read(this.request.caller, id);
    return { sizeBytes: file.data.byteLength };
  }
}

it("persists uploads across Nest instances and resolves attachments only for their owner", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "nest-ai-attachments-"));
  let id: string;
  const extraction = jest.fn<AiModel["generate"]>(async () => ({
    kind: "final",
    message: "Revenue was 120 dollars.",
  }));
  const options: AiModuleOptions = {
    attachmentModels: {
      "text/plain": {
        capabilities: { toolCalling: false },
        generate: extraction,
      },
    },
    model: {
      capabilities: { toolCalling: true },
      async generate({ messages }) {
        const last = messages.at(-1);
        if (last?.role === "tool") {
          expect(last.result).toEqual({
            ok: true,
            data: { sizeBytes: attachment.data.byteLength },
          });
          return { kind: "final", message: "Read the report." };
        }
        expect(last?.content).toContain("Revenue was 120 dollars.");
        return {
          kind: "tool-calls",
          toolCalls: [
            { id: "lookup", name: "get_attachment", arguments: { id } },
          ],
        };
      },
    },
  };
  const env = jest.replaceProperty(process, "env", {
    ...process.env,
    NEST_AI_ATTACHMENT_STORAGE_ENABLED: "true",
    NEST_AI_ATTACHMENT_STORAGE_DIRECTORY: join(temporary, "assets"),
  });
  try {
    const upload = await Test.createTestingModule({
      imports: [AiModule.forRoot(options)],
    }).compile();
    try {
      id = await upload.get(AiAttachmentService).create(caller, attachment);
    } finally {
      await upload.close();
    }

    const app = await Test.createTestingModule({
      imports: [AiModule.forRoot(options)],
      providers: [AttachmentTools],
    }).compile();
    try {
      await app.init();
      const storage = app.get(AiAttachmentService);
      const chat = app.get(AiChatService);
      const contextId = ContextIdFactory.create();
      const context = { caller, contextId };
      app.registerRequestByContextId({ caller }, contextId);

      await expect(storage.read(caller, id)).resolves.toEqual(attachment);
      const otherTenant = { ...caller, tenantId: "another-tenant" };
      await expect(
        storage.update(otherTenant, id, attachment),
      ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
      await expect(
        storage.delete({ ...caller, subjectId: "other-reader" }, id),
      ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
      await expect(storage.read(caller, "malformed-id")).rejects.toMatchObject({
        code: "INVALID_ATTACHMENT",
      });
      await expect(
        chat.sendMessage(
          "",
          { ...context, caller: otherTenant },
          { attachmentIds: [id] },
        ),
      ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
      expect(extraction).not.toHaveBeenCalled();

      await expect(
        chat.sendMessage("", context, { attachmentIds: [id] }),
      ).resolves.toMatchObject({
        message: "Read the report.",
        tools: ["get_attachment"],
      });
      expect(extraction).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [attachment] }),
      );

      const replacement = {
        mediaType: "text/plain",
        data: Buffer.from([0, 10, 255]),
      };
      await storage.update(caller, id, replacement);
      await expect(storage.read(caller, id)).resolves.toEqual(replacement);
      await storage.delete(caller, id);
      await expect(
        storage.update(caller, id, replacement),
      ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
      await expect(storage.read(caller, id)).rejects.toMatchObject({
        code: "ATTACHMENT_NOT_FOUND",
      });
    } finally {
      await app.close();
    }
  } finally {
    env.restore();
    await rm(temporary, { recursive: true, force: true });
  }
});

it("passes the verified caller and cancellation signal to the configured adapter", async () => {
  const create = jest
    .fn<AiAttachmentStorageAdapter["create"]>()
    .mockResolvedValue(undefined);
  const read = jest
    .fn<AiAttachmentStorageAdapter["read"]>()
    .mockResolvedValue(attachment);
  const adapter: AiAttachmentStorageAdapter = {
    create,
    read,
    async update() {
      return false;
    },
    async delete() {
      return false;
    },
  };
  const app = await Test.createTestingModule({
    imports: [
      AiModule.forRootAsync({
        useFactory: () => ({ model, attachmentStorage: { adapter } }),
      }),
    ],
  }).compile();
  try {
    const storage = app.get(AiAttachmentService);
    const controller = new AbortController();
    const id = await storage.create(caller, attachment, controller.signal);
    expect(create).toHaveBeenCalledWith(
      caller,
      id,
      attachment,
      controller.signal,
    );
    await expect(storage.read(caller, id, controller.signal)).resolves.toEqual(
      attachment,
    );
    expect(read).toHaveBeenCalledWith(caller, id, controller.signal);
    controller.abort();
    await expect(storage.read(caller, id, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
