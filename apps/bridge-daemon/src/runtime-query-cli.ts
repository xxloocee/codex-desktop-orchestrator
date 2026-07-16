import fs from "node:fs";
import path from "node:path";
import { SqliteDeliveryJobStore } from "../../../packages/store/src/delivery-job-repo.js";
import { openReadonlySqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { SqliteTurnStore } from "../../../packages/store/src/turn-repo.js";
import { loadConfig } from "./config.js";

const LOG_PREFIX = "[codex-desktop-orchestrator]";

export async function runDataQueryCommand(
  command: "tasks" | "task" | "deliveries",
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    writeStdout: (line: string) => void;
    writeStderr: (line: string) => void;
  }
): Promise<number> {
  try {
    const config = loadConfig(options.env);
    const databasePath = path.resolve(config.databasePath);
    if (!fs.existsSync(databasePath)) {
      writeJsonLine(options.writeStdout, {
        status: "not_initialized",
        databasePath
      });
      return 1;
    }

    const db = openReadonlySqliteDatabase(databasePath);
    try {
      if (command === "tasks") {
        const turns = await new SqliteTurnStore(db).listRecentTurnsAll(parseQueryLimit(args[0]));
        writeJsonLine(options.writeStdout, { status: "ok", turns });
        return 0;
      }

      if (command === "deliveries") {
        const deliveries = await new SqliteDeliveryJobStore(db).listRecentJobsAll(
          parseQueryLimit(args[0])
        );
        writeJsonLine(options.writeStdout, { status: "ok", deliveries });
        return 0;
      }

      return await queryTask(args[0], new SqliteTurnStore(db), options.writeStdout);
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.writeStderr(`${LOG_PREFIX} ${command} failed: ${message}`);
    writeJsonLine(options.writeStdout, { status: "failed", error: message });
    return 1;
  }
}

async function queryTask(
  rawTurnId: string | undefined,
  turnStore: SqliteTurnStore,
  writeStdout: (line: string) => void
): Promise<number> {
  const turnId = rawTurnId?.trim();
  if (!turnId) {
    writeJsonLine(writeStdout, { status: "failed", error: "task id is required" });
    return 1;
  }

  const turn = await turnStore.getTurn(turnId);
  if (!turn) {
    writeJsonLine(writeStdout, { status: "not_found", turnId });
    return 1;
  }

  const events = await turnStore.listTurnEvents(turn.turnId, 100);
  writeJsonLine(writeStdout, { status: "ok", turn, events });
  return 0;
}

function parseQueryLimit(value: string | undefined): number {
  const parsed = Number(value ?? "20");
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}

function writeJsonLine(writeStdout: (line: string) => void, value: unknown): void {
  writeStdout(JSON.stringify(value));
}
