import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateRuntimeConfigFile } from "../../apps/bridge-daemon/src/config-management.js";

function createTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("config management", () => {
  it("merges a partial runtime config patch and preserves existing secrets", () => {
    const runtimeHome = createTempDir("qq-codex-config-management-");
    const configPath = path.join(runtimeHome, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        qqBot: {
          accountId: "default",
          appId: "config-app",
          clientSecret: "config-secret",
          markdownSupport: false,
          stt: null
        },
        accessControl: {
          mode: "deny-by-default",
          allowedC2cSenderIds: ["OPENID1"]
        }
      })
    );

    const env = {
      QQBOT_APP_ID: "env-app",
      QQBOT_CLIENT_SECRET: "env-secret"
    };

    const result = updateRuntimeConfigFile({
      configPath,
      env,
      patch: {
        runtime: {
          listenPort: 3999
        },
        accessControl: {
          allowedC2cSenderIds: ["OPENID1", "OPENID2"]
        }
      }
    });

    const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      qqBot?: { clientSecret?: string };
      runtime?: { listenPort?: number };
      accessControl?: { allowedC2cSenderIds?: string[] };
    };

    expect(saved.qqBot?.clientSecret).toBe("config-secret");
    expect(saved.runtime?.listenPort).toBe(3999);
    expect(saved.accessControl?.allowedC2cSenderIds).toEqual(["OPENID1", "OPENID2"]);
    expect(result.effectiveConfig.runtime.listenPort).toBe(3999);
    expect(result.effectiveConfig.qqBot.clientSecret).toBe("config-secret");
  });

  it("rejects non-object patches with a bad request status", () => {
    expect(() =>
      updateRuntimeConfigFile({
        configPath: path.join(createTempDir("qq-codex-config-management-"), "config.json"),
        env: {
          QQBOT_APP_ID: "env-app",
          QQBOT_CLIENT_SECRET: "env-secret"
        },
        patch: []
      })
    ).toThrow("config patch must be a JSON object");
  });
});
