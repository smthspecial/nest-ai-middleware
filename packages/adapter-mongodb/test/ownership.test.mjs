import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoDatabaseAdapter } from "../dist/index.js";
import { applyMongoMigrations } from "../dist/migrations.js";

const caller = { subjectId: "fixture-account", tenantId: "fixture-tenant" };
const sessionId = "e92ffd5e-6b58-45d9-8f44-9bbfe259e53e";

test("uses binary collation and scalar equality in conversation ownership queries", async () => {
  const filters = [];
  const collection = {
    aggregate(pipeline, options) {
      filters.push([pipeline[0].$match, options]);
      return { toArray: async () => [] };
    },
    async updateOne(filter, _update, options) {
      filters.push([filter, options]);
      return { matchedCount: 1 };
    },
  };
  const db = { collection: () => collection };
  const adapter = new MongoDatabaseAdapter({ db: () => db }, "fixture");
  const signal = new AbortController().signal;
  await adapter.listConversations(caller, { limit: 1 }, signal);
  await adapter.searchConversationTurns(
    caller,
    { excludeSessionId: sessionId, keywords: ["forecast"], limit: 1 },
    signal,
  );
  await adapter.beginConversation(
    {
      session: { caller, id: sessionId },
      runId: "fixture-run",
      create: false,
      leaseUntil: Date.now() + 1000,
    },
    signal,
  );

  assert.equal(filters.length, 3);
  for (const [filter, options] of filters) {
    assert.deepEqual(filter.subjectId, { $eq: caller.subjectId });
    assert.deepEqual(filter.tenantId, { $eq: caller.tenantId });
    assert.deepEqual(options.collation, { locale: "simple" });
  }
  await assert.rejects(
    adapter.listConversations(
      { ...caller, tenantId: {} },
      { limit: 1 },
      signal,
    ),
    { name: "TypeError" },
  );
  assert.equal(filters.length, 3);
});

test("adds a binary owner index when upgrading a collection with a locale collation", async () => {
  const key = { subjectId: 1, tenantId: 1 };
  const created = [];
  const versions = {
    findOne: async () => ({ version: 2 }),
    updateOne: async () => ({ matchedCount: 1 }),
  };
  const sessions = {
    indexes: async () => [{ key, collation: { locale: "en", strength: 2 } }],
    async createIndex(...args) {
      created.push(args);
    },
  };
  await applyMongoMigrations({
    collection: (name) =>
      name === "nest_ai_schema_migrations" ? versions : sessions,
  });
  assert.deepEqual(created, [
    [
      key,
      {
        name: "subjectId_1_tenantId_1_binary",
        collation: { locale: "simple" },
      },
    ],
  ]);
});
