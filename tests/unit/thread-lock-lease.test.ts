import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import { SqliteThreadLockStore } from "../../packages/store/src/thread-lock-repo.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createDatabasePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thread-lock-")), "bridge.sqlite");
}

describe("thread lock lease", () => {
  it("renews a long-running lease and prevents another store from overwriting it", async () => {
    const databasePath = createDatabasePath();
    const firstDb = createSqliteDatabase(databasePath);
    const secondDb = createSqliteDatabase(databasePath);
    const options = {
      leaseTtlMs: 30,
      renewIntervalMs: 10,
      pollIntervalMs: 5
    };
    const firstStore = new SqliteThreadLockStore(firstDb, options);
    const secondStore = new SqliteThreadLockStore(secondDb, options);
    const started = deferred();
    const release = deferred();
    let secondRan = false;

    const first = firstStore.withThreadLock("thread-1", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const second = secondStore.withThreadLock("thread-1", async () => {
      secondRan = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondRan).toBe(false);

    release.resolve();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
    firstDb.close();
    secondDb.close();
  });

  it("waits for an unexpired external lease before taking ownership", async () => {
    const db = createSqliteDatabase(":memory:");
    let nowMs = Date.parse("2026-07-01T10:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_locks (thread_ref, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      "thread-1",
      "external-owner",
      new Date(nowMs).toISOString(),
      new Date(nowMs + 30).toISOString()
    );
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });
    const store = new SqliteThreadLockStore(db, {
      leaseTtlMs: 30,
      renewIntervalMs: 1_000,
      pollIntervalMs: 10,
      now: () => new Date(nowMs),
      sleep
    });
    const ownersSeen: string[] = [];

    await store.withThreadLock("thread-1", async () => {
      const row = db
        .prepare(`SELECT owner FROM thread_locks WHERE thread_ref = ?`)
        .get("thread-1") as { owner: string };
      ownersSeen.push(row.owner);
    });

    expect(sleep).toHaveBeenCalledTimes(3);
    expect(ownersSeen).toHaveLength(1);
    expect(ownersSeen[0]).not.toBe("external-owner");
    db.close();
  });

  it("takes over an already expired lease without polling", async () => {
    const db = createSqliteDatabase(":memory:");
    const now = new Date("2026-07-01T10:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_locks (thread_ref, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      "thread-1",
      "expired-owner",
      "2026-07-01T09:59:00.000Z",
      "2026-07-01T09:59:30.000Z"
    );
    const sleep = vi.fn(async () => undefined);
    const store = new SqliteThreadLockStore(db, {
      now: () => now,
      sleep
    });

    await expect(
      store.withThreadLock("thread-1", async () => "acquired")
    ).resolves.toBe("acquired");
    expect(sleep).not.toHaveBeenCalled();
    db.close();
  });
});
