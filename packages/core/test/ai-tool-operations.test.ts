import { expect, it, jest } from "@jest/globals";
import {
  ForbiddenException,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AiModule, AiTool, AiToolExecutor } from "../src/index.js";
import type { AiModel, AiToolOptions, JsonObject } from "../src/index.js";

const recordIdInput = {
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
  additionalProperties: false,
};
const updateRecordInput = {
  ...recordIdInput,
  properties: {
    ...recordIdInput.properties,
    quantity: { type: "integer", minimum: 1 },
    note: { type: "string" },
    review: { type: "boolean" },
  },
  additionalProperties: { type: "string" },
};

const editorGuard: CanActivate = {
  canActivate(context) {
    return (
      context.switchToHttp().getRequest<{ role: string }>().role === "editor"
    );
  },
};

@Injectable()
class RecordService {
  changes = 0;

  @AiTool({
    name: "get_record",
    description: "Read an example record.",
    readOnly: true,
    inputSchema: recordIdInput,
  })
  get({ id }: { id: number }) {
    if (id !== 1) throw new ForbiddenException();
    return { id };
  }

  @UseGuards(editorGuard)
  @AiTool({
    name: "create_record",
    description: "Create an example record.",
    readOnly: false,
    operation: "create",
    inputSchema: recordIdInput,
  })
  create({ id }: { id: number }) {
    const result = this.get({ id });
    this.changes++;
    return result;
  }

  @UseGuards(editorGuard)
  @AiTool({
    name: "update_record",
    description: "Update an example record.",
    readOnly: false,
    operation: "update",
    inputSchema: updateRecordInput,
  })
  update({
    id,
    quantity = 1,
    note = "default, (note)",
    review = false,
    ...labels
  }: JsonObject & {
    id: number;
    quantity?: number;
    note?: string;
    review?: boolean;
  }) {
    this.create({ id });
    return { id, quantity, note, review, labels };
  }
}

@Injectable()
class InvalidDeleteService {
  @AiTool({
    name: "remove_record",
    description: "Delete an example record.",
    readOnly: false,
    operation: "delete",
    inputSchema: recordIdInput,
  } as unknown as AiToolOptions)
  delete({ id }: { id: number }) {
    return { id };
  }
}

@Injectable()
class LegacyArgumentOrderService {
  @AiTool({
    name: "legacy_order",
    description: "Read by positional argument.",
    readOnly: true,
    inputSchema: recordIdInput,
    argumentOrder: ["id"],
  } as AiToolOptions)
  read(id: number) {
    return { id };
  }
}

@Module({ providers: [RecordService] })
class RecordsModule {}

@Module({ providers: [InvalidDeleteService] })
class InvalidDeleteModule {}

@Module({ providers: [LegacyArgumentOrderService] })
class LegacyArgumentOrderModule {}

const model: AiModel = {
  capabilities: { toolCalling: true },
  async generate() {
    return { kind: "final", message: "OK" };
  },
};

function createFixture(allowWrites: boolean, recordsModule = RecordsModule) {
  const env = jest.replaceProperty(process, "env", {
    ...process.env,
    NEST_AI_ALLOW_WRITES: String(allowWrites),
  });
  return Test.createTestingModule({
    imports: [recordsModule, AiModule.forRoot({ model })],
  })
    .compile()
    .finally(() => env.restore());
}

it("uses service guards and business authorization for get, create, and update", async () => {
  const fixture = await createFixture(true);
  try {
    await fixture.init();
    const executor = fixture.get(AiToolExecutor);
    const service = fixture.get(RecordService);
    const viewer = {
      caller: { subjectId: "viewer" },
      contextId: ContextIdFactory.create(),
      http: { request: { role: "viewer" } },
    };
    const editor = {
      caller: { subjectId: "editor" },
      contextId: ContextIdFactory.create(),
      http: { request: { role: "editor" } },
    };

    expect(
      (await executor.discover(viewer, AbortSignal.timeout(1000))).map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_record"]);
    await expect(
      executor.execute("get_record", { id: 1 }, viewer),
    ).resolves.toEqual({ id: 1 });
    await expect(
      executor.execute("get_record", { id: 2 }, viewer),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    await expect(
      executor.execute("create_record", { id: 1 }, viewer),
    ).rejects.toMatchObject({ code: "DENIED" });
    await expect(
      executor.execute("update_record", { id: 2 }, editor),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    expect(service.changes).toBe(0);
    await expect(
      executor.execute("create_record", { id: 1 }, editor),
    ).resolves.toEqual({ id: 1 });
    const tools = await executor.discover(editor, AbortSignal.timeout(1000));
    const updateTool = tools.find((tool) => tool.name === "update_record");
    expect(updateTool?.inputSchema).toEqual(updateRecordInput);
    await expect(
      executor.execute("update_record", { id: 1 }, editor),
    ).resolves.toEqual({
      id: 1,
      quantity: 1,
      note: "default, (note)",
      review: false,
      labels: {},
    });
    const firstOrder = { source: "manual", review: true, quantity: 4, id: 1 };
    const otherOrder = { id: 1, quantity: 4, review: true, source: "manual" };
    const expected = {
      id: 1,
      quantity: 4,
      note: "default, (note)",
      review: true,
      labels: { source: "manual" },
    };
    await expect(
      executor.execute("update_record", firstOrder, editor),
    ).resolves.toEqual(expected);
    await expect(
      executor.execute("update_record", otherOrder, editor),
    ).resolves.toEqual(expected);
    await expect(
      executor.execute("update_record", { id: "1" }, editor),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      executor.execute("update_record", { id: 1, source: false }, editor),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      executor.execute("get_record", { id: 1, source: "manual" }, viewer),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(service.changes).toBe(4);
    expect(service.update({ id: 1, quantity: 6, note: "manual" })).toEqual({
      id: 1,
      quantity: 6,
      note: "manual",
      review: false,
      labels: {},
    });
  } finally {
    await fixture.close();
  }
});

it("rejects legacy positional tool configuration at startup", async () => {
  const fixture = await createFixture(false, LegacyArgumentOrderModule);
  try {
    await expect(fixture.init()).rejects.toThrow(
      /receives one named input object/,
    );
  } finally {
    await fixture.close();
  }
});

it("rejects writes without host opt-in and rejects delete even with opt-in", async () => {
  const readOnly = await createFixture(false);
  const withDelete = await createFixture(true, InvalidDeleteModule);
  try {
    await expect(readOnly.init()).rejects.toThrow(
      /requires NEST_AI_ALLOW_WRITES=true/,
    );
    await expect(withDelete.init()).rejects.toThrow(
      /Unsupported AI tool operation/,
    );
  } finally {
    await readOnly.close();
    await withDelete.close();
  }
});
