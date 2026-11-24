import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Db } from "mongodb";

interface MigrationState {
  _id: "schema";
  version: number;
  lockId?: string;
}

// Append new migrations only. Each step must tolerate retry after a partial failure.
const migrations = [
  async (db: Db) => {
    await db
      .collection("nest_ai_chat_turns")
      .createIndex({ sessionId: 1, position: 1 }, { unique: true });
    await db
      .collection("nest_ai_runs")
      .createIndex({ sessionId: 1, startedAt: 1 });
    const events = db.collection("nest_ai_run_events");
    await events.createIndex({ runId: 1, sequence: 1 }, { unique: true });
    await events.createIndex(
      { invocationId: 1 },
      {
        unique: true,
        partialFilterExpression: { invocationId: { $type: "string" } },
      },
    );
  },
  async (db: Db) => {
    await db
      .collection("nest_ai_chat_sessions")
      .createIndex({ subjectId: 1, tenantId: 1 });
  },
  async (db: Db) => {
    const sessions = db.collection("nest_ai_chat_sessions");
    const indexes = await sessions.indexes();
    const hasBinaryOwnerIndex = indexes.some(
      ({ key, collation }) =>
        Object.keys(key).join(",") === "subjectId,tenantId" &&
        key.subjectId === 1 &&
        key.tenantId === 1 &&
        (!collation || collation.locale === "simple"),
    );
    if (hasBinaryOwnerIndex) return;
    await sessions.createIndex(
      { subjectId: 1, tenantId: 1 },
      {
        name: "subjectId_1_tenantId_1_binary",
        collation: { locale: "simple" },
      },
    );
  },
];

/** Run against the primary with majority write concern. */
export async function applyMongoMigrations(db: Db): Promise<void> {
  const versions = db.collection<MigrationState>("nest_ai_schema_migrations");
  const deadline = performance.now() + 60_000;
  const lockId = randomUUID();
  const key = { _id: "schema" } as const;
  const ownedLock = { ...key, lockId };

  for (;;) {
    const current = await versions.findOne(key, { readConcern: "majority" });
    const version = current ? current.version : 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(
        "NestJS AI Middleware has an invalid MongoDB schema version.",
      );
    }
    if (version > migrations.length) {
      throw new Error(
        `NestJS AI Middleware MongoDB schema version ${version} requires a newer adapter.`,
      );
    }
    if (!current)
      await versions.updateOne(
        key,
        { $setOnInsert: { version: 0 } },
        { upsert: true },
      );
    if (!current?.lockId) {
      if (version === migrations.length) return;
      try {
        const lock = await versions.updateOne(
          { ...key, version, lockId: { $exists: false } },
          { $set: { lockId } },
        );
        if (lock.matchedCount) {
          for (let index = version; index < migrations.length; index++) {
            await migrations[index](db);
            const checkpoint = await versions.updateOne(ownedLock, {
              $set: { version: index + 1 },
            });
            if (!checkpoint.matchedCount)
              throw new Error(
                "NestJS AI Middleware MongoDB migration lock was lost.",
              );
          }
          return;
        }
      } finally {
        // Also release if the server acquired the lock but the response was lost.
        await versions.updateOne(ownedLock, { $unset: { lockId: "" } });
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        "Timed out waiting for the NestJS AI Middleware MongoDB migration lock.",
      );
    }
    await setTimeout(250);
  }
}
