import "reflect-metadata";
import assert from "node:assert/strict";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory, ContextIdFactory } from "@nestjs/core";
import { MongoClient } from "mongodb";
import pg from "pg";
import { AiChatService, AiModule, AiTool } from "nestjs-ai-middleware";
import { MongoDatabaseAdapter } from "nestjs-ai-middleware-adapter-mongodb";
import { PostgresDatabaseAdapter } from "nestjs-ai-middleware-adapter-postgres";
import { SqliteDatabaseAdapter } from "nestjs-ai-middleware-adapter-sqlite";

class Catalog {
  lookup({ term }) {
    return { title: term };
  }
}
Injectable()(Catalog);
AiTool({
  name: "lookup",
  description: "Look up a catalog entry.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { term: { type: "string" } },
    required: ["term"],
    additionalProperties: false,
  },
})(
  Catalog.prototype,
  "lookup",
  Object.getOwnPropertyDescriptor(Catalog.prototype, "lookup"),
);

const model = {
  capabilities: { toolCalling: true },
  async generate({ messages, tools }) {
    assert.deepEqual(
      tools.map(({ name }) => name),
      ["lookup"],
    );
    const latest = messages.at(-1);
    if (latest.role === "tool") {
      assert.deepEqual(latest.result, {
        ok: true,
        data: { title: "Cleaning" },
      });
      return { kind: "final", message: "Found Cleaning." };
    }
    return {
      kind: "tool-calls",
      toolCalls: [
        { id: "lookup-1", name: "lookup", arguments: { term: "Cleaning" } },
      ],
    };
  },
};

const adapter = new SqliteDatabaseAdapter(":memory:");
const pool = new pg.Pool();
const mongoClient = new MongoClient("mongodb://127.0.0.1:27017");
let app;
try {
  assert.equal(typeof new PostgresDatabaseAdapter(pool).initialize, "function");
  assert.equal(
    typeof new MongoDatabaseAdapter(mongoClient, "fixture").initialize,
    "function",
  );
  class Host {}
  Module({
    imports: [AiModule.forRoot({ model, database: { adapter } })],
    providers: [Catalog],
  })(Host);
  app = await NestFactory.createApplicationContext(Host, {
    logger: false,
    abortOnError: false,
  });
  const chat = app.get(AiChatService);
  const caller = { subjectId: "compatibility-fixture" };
  const reply = await chat.sendMessage("Find Cleaning.", {
    caller,
    contextId: ContextIdFactory.create(),
  });
  assert.equal(reply.message, "Found Cleaning.");
  assert.deepEqual(reply.tools, ["lookup"]);
  const transcript = await chat.readConversation(reply.sessionId, caller);
  assert.equal(transcript.turns[0].assistant, reply.message);
  console.log(
    `Verified packed middleware on Node ${process.version} and NestJS 11.`,
  );
} finally {
  await app?.close();
  adapter.close();
  await Promise.all([pool.end(), mongoClient.close()]);
}
