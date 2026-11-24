import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { PostgresDatabaseAdapter } from "../dist/index.js";

const runId = "e92ffd5e-6b58-45d9-8f44-9bbfe259e53e";
const caller = { subjectId: "fixture-account" };
const empty = { rows: [], rowCount: 0 };

test("discards the checked-out client when an active query is cancelled", async () => {
  const entered = Promise.withResolvers();
  const result = Promise.withResolvers();
  const releases = [];
  const client = {
    async query(sql) {
      if (sql.includes("FROM pg_catalog.pg_settings")) return empty;
      assert.match(sql, /JOIN nest_ai_middleware.chat_sessions/);
      entered.resolve();
      return result.promise;
    },
    release(discard) {
      releases.push(discard);
    },
  };
  const adapter = new PostgresDatabaseAdapter({ connect: async () => client });
  const abort = new AbortController();
  const read = adapter.readRun(runId, caller, 0, abort.signal);
  await entered.promise;
  abort.abort();
  await assert.rejects(read, { name: "AbortError" });
  assert.deepEqual(releases, [true]);

  result.resolve(empty);
  await setImmediate();
  assert.deepEqual(releases, [true]);
});

test("returns a client received after checkout was cancelled without dispatching a query", async () => {
  const checkout = Promise.withResolvers();
  const releases = [];
  const adapter = new PostgresDatabaseAdapter({
    connect: () => checkout.promise,
  });
  const abort = new AbortController();
  const read = adapter.readRun(runId, caller, 0, abort.signal);
  abort.abort();
  await assert.rejects(read, { name: "AbortError" });
  checkout.resolve({
    query() {
      assert.fail("Cancelled checkout dispatched a query.");
    },
    release(discard) {
      releases.push(discard);
    },
  });
  await setImmediate();
  assert.deepEqual(releases, [undefined]);
});

test("rolls back failed work before returning a healthy client to the pool", async () => {
  const queries = [];
  const releases = [];
  const failure = new Error("Database statement failed.");
  const client = {
    async query(sql) {
      queries.push(sql.trim());
      if (sql.includes("JOIN nest_ai_middleware.chat_sessions")) throw failure;
      return empty;
    },
    release(discard) {
      releases.push(discard);
    },
  };
  const adapter = new PostgresDatabaseAdapter({ connect: async () => client });
  await assert.rejects(
    adapter.readRun(runId, caller, 0, new AbortController().signal),
    failure,
  );
  assert.match(queries[0], /BEGIN;[\s\S]*statement_timeout/);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [false]);
});
