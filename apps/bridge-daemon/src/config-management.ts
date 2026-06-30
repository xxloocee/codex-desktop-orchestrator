import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { appConfigSchema, loadConfig, type AppConfig } from "./config.js";

const runtimeConfigPatchSchema = appConfigSchema.deepPartial();

export function updateRuntimeConfigFile(options: {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  patch: unknown;
}): { configPath: string; effectiveConfig: AppConfig } {
  const patch = parseConfigPatch(options.patch);
  const existing = readJsonObject(options.configPath);
  const nextFileConfig = deepMerge(existing ?? {}, patch);

  fs.mkdirSync(path.dirname(options.configPath), { recursive: true });
  const tempPath = `${options.configPath}.${process.pid}.${Date.now()}.tmp`;
  let effectiveConfig: AppConfig;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(nextFileConfig, null, 2)}\n`, "utf8");
    effectiveConfig = loadConfig({
      ...(options.env ?? process.env),
      QQ_CODEX_CONFIG_PATH: tempPath
    });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  fs.renameSync(tempPath, options.configPath);
  return {
    configPath: options.configPath,
    effectiveConfig
  };
}

function parseConfigPatch(patch: unknown): Record<string, unknown> {
  if (!isRecord(patch)) {
    throw badRequest("config patch must be a JSON object");
  }

  try {
    return runtimeConfigPatchSchema.parse(patch) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(error.issues.map((issue) => issue.message).join("; "));
    }
    throw error;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw badRequest("runtime config file must contain a JSON object");
  }
  return parsed;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch)) {
    return patch;
  }

  if (!isRecord(base) || !isRecord(patch)) {
    return patch;
  }

  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
