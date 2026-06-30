import { createServer, type IncomingMessage, type Server } from "node:http";

type JsonRoute = {
  routePath: string;
  method?: "GET" | "POST" | "PUT";
  dispatchPayload(payload: unknown): Promise<unknown>;
  onDispatchError?: (error: Error, payload: unknown) => void;
  allowOnlyLocal?: boolean;
  requiredToken?: string | null;
  respondWithJson?: boolean;
};

type JsonServerDeps = {
  routes: JsonRoute[];
};

type QqWebhookServerDeps = {
  webhookPath: string;
  ingress: {
    dispatchPayload(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

type InternalTurnEventServerDeps = {
  routePath: string;
  ingress: {
    dispatchTurnEvent(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

export function createQqWebhookServer(deps: QqWebhookServerDeps): Server {
  return createJsonServer({
    routes: [
      {
        routePath: deps.webhookPath,
        dispatchPayload: deps.ingress.dispatchPayload,
        onDispatchError: deps.onDispatchError
      }
    ]
  });
}

export function createInternalTurnEventServer(deps: InternalTurnEventServerDeps): Server {
  return createJsonServer({
    routes: [
      {
        routePath: deps.routePath,
        dispatchPayload: deps.ingress.dispatchTurnEvent,
        onDispatchError: deps.onDispatchError,
        allowOnlyLocal: true
      }
    ]
  });
}

export function createBridgeHttpServer(routes: JsonRoute[]): Server {
  return createJsonServer({ routes });
}

function createJsonServer(deps: JsonServerDeps): Server {
  return createServer(async (request, response) => {
    const candidateRoutes = deps.routes.filter((candidate) => candidate.routePath === request.url);
    if (candidateRoutes.length === 0) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const route = candidateRoutes.find((candidate) => (candidate.method ?? "POST") === request.method);
    if (!route) {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }

    if (route.allowOnlyLocal && !isLocalRequest(request)) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }

    const method = route.method ?? "POST";
    if (route.requiredToken && !hasValidToken(request, route.requiredToken)) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }

    if (method === "GET") {
      try {
        const result = await route.dispatchPayload(undefined);
        writeJson(response, 200, result ?? {});
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "dispatch failed");
        route.onDispatchError?.(normalized, undefined);
        writeJson(response, 500, { error: normalized.message });
      }
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let payload: unknown;
    try {
      const body = Buffer.concat(chunks).toString("utf8").trim();
      payload = body ? JSON.parse(body) : {};
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "invalid request");
      return;
    }

    if (route.respondWithJson) {
      try {
        const result = await route.dispatchPayload(payload);
        writeJson(response, 200, result ?? {});
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "dispatch failed");
        route.onDispatchError?.(normalized, payload);
        writeJson(response, errorStatusCode(normalized), { error: normalized.message });
      }
      return;
    }

    Promise.resolve()
      .then(() => route.dispatchPayload(payload))
      .catch((error) => {
        const normalized =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "dispatch failed");
        route.onDispatchError?.(normalized, payload);
      });

    response.statusCode = 202;
    response.end("accepted");
  });
}

function hasValidToken(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers["x-qq-codex-token"] ?? request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return false;
  }

  const token = value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
  return token === expectedToken;
}

function writeJson(response: { statusCode: number; setHeader?: (name: string, value: string) => void; end(body?: string): void }, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader?.("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function errorStatusCode(error: Error): number {
  const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600
    ? statusCode
    : 500;
}

function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
