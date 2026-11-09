import type { KVNamespace } from "@cloudflare/workers-types";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { DeployConfig } from "../deploy.config.ts";
import { decodeAlertRequest, decodeCredentialRecord, Token } from "./services.ts";

const MAX_BODY_BYTES = 32 * 1024;
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const jsonResponse = (body: unknown, status: number, headers = {}) =>
  HttpServerResponse.json(body, { status, headers: { ...responseHeaders, ...headers } });

const readCredential = (env: Record<string, unknown>, token: string) =>
  Effect.tryPromise({
    try: async () => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const digest = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const catalog = env.ServiceCatalog as Pick<KVNamespace, "get">;
      const raw = await catalog.get(`credentials/${digest}`, "text");
      if (raw === null) return undefined;
      if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 32_768)
        throw new Error("Invalid credential record");
      const record = decodeCredentialRecord(JSON.parse(raw));
      return record.enabled ? record : undefined;
    },
    catch: () => "configuration_unavailable" as const,
  });

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(MAX_BODY_BYTES);
    let size = 0;
    yield* Stream.runForEach(request.stream, (chunk) => {
      if (size + chunk.byteLength > MAX_BODY_BYTES) return Effect.fail("too_large" as const);
      bytes.set(chunk, size);
      size += chunk.byteLength;
      return Effect.void;
    });
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      catch: () => "invalid_utf8" as const,
    });
  });

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const makeWorker = (worker?: DeployConfig["worker"]) =>
  Cloudflare.Worker(
    // Persisted Alchemy identity; renaming it would fork resource ownership.
    "AlertEmailWorker",
    {
      ...worker,
      main: import.meta.url,
      // Release policy, not operator overrides. Advance compatibility after testing.
      compatibility: { date: "2026-10-22", flags: ["nodejs_compat"] },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: {
          enabled: true,
          invocationLogs: true,
          headSamplingRate: 1,
          persist: true,
        },
        traces: { enabled: true, headSamplingRate: 1 },
      },
    },
    Effect.gen(function* () {
      // The selected credential's KV policy owns all delivery addresses.
      const emailBinding = yield* Cloudflare.Email.SendEmail("Email");
      const email = yield* Cloudflare.Email.Send(emailBinding);

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Match the runtime path without additional decoding or normalization.
          const path = request.url.replace(/^https?:\/\/[^/]+/, "");
          if (path !== "/health" && path !== "/example" && path !== "/v1/alerts")
            return yield* jsonResponse({ error: "Not found" }, 404);
          const method = path === "/v1/alerts" ? "POST" : "GET";
          if (request.method !== method) {
            return yield* jsonResponse({ error: "Method not allowed" }, 405, { Allow: method });
          }
          if (path === "/health") return yield* jsonResponse({ status: "ok" }, 200);
          if (path === "/example")
            return yield* jsonResponse(
              {
                kvPolicy: {
                  schemaVersion: 1,
                  enabled: false,
                  sender: "alerts@example.com",
                  recipient: ["oncall@example.net"],
                  name: "Example monitor",
                },
                alertRequest: {
                  title: "Example error",
                  message: "An operation failed.",
                  timestamp: "2026-01-01T00:00:00Z",
                  metadata: { component: "example" },
                },
              },
              200,
            );

          const unauthorized = () =>
            jsonResponse({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
          const authorization = request.headers.authorization ?? "";
          const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
          if (!Schema.is(Token)(presented)) return yield* unauthorized();
          const env = yield* Cloudflare.WorkerEnvironment;
          const configuration = yield* readCredential(env, presented).pipe(Effect.result);
          if (configuration._tag === "Failure") {
            yield* Effect.logError("Alert configuration unavailable");
            return yield* jsonResponse({ error: "Alert configuration unavailable" }, 503);
          }
          const record = configuration.success;
          if (!record) return yield* unauthorized();

          const mediaType = request.headers["content-type"] ?? "";
          const encoding = request.headers["content-encoding"];
          if (
            !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(mediaType) ||
            (encoding && encoding !== "identity")
          ) {
            return yield* jsonResponse(
              { error: "Use uncompressed application/json with UTF-8" },
              415,
            );
          }
          const declaredLength = request.headers["content-length"];
          if (
            declaredLength !== undefined &&
            (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
          ) {
            return yield* jsonResponse({ error: "Payload too large" }, 413);
          }
          const body = yield* readBody(request).pipe(Effect.result);
          if (body._tag === "Failure") {
            const oversized = body.failure === "too_large";
            return yield* jsonResponse(
              { error: oversized ? "Payload too large" : "Invalid request body" },
              oversized ? 413 : 400,
            );
          }
          const parsed = yield* Effect.try({
            try: () => decodeAlertRequest(JSON.parse(body.success)),
            catch: () => "Invalid alert" as const,
          }).pipe(Effect.result);
          if (parsed._tag === "Failure") return yield* jsonResponse({ error: parsed.failure }, 400);
          const alert = parsed.success;
          const title = alert.title.trim();
          const timestamp = alert.timestamp ?? new Date().toISOString();
          const metadata = JSON.stringify(alert.metadata ?? {}, null, 2);
          const details = `${record.name ? `Service: ${record.name}\n` : ""}Timestamp: ${timestamp}`;
          const result = yield* email
            .send({
              from: record.sender,
              to: [...record.recipient],
              subject: `[ERROR] ${title}`,
              text: `${title}\n\n${details}\n\n${alert.message}\n\nMetadata:\n${metadata}`,
              html: `<h1>${escapeHtml(title)}</h1><pre>${escapeHtml(details)}</pre><pre style="white-space:pre-wrap">${escapeHtml(alert.message)}</pre><h2>Metadata</h2><pre style="white-space:pre-wrap">${escapeHtml(metadata)}</pre>`,
            })
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* Effect.logError("Alert email provider failed");
            return yield* jsonResponse({ error: "Failed to send alert" }, 502);
          }
          yield* Effect.logInfo("Alert email accepted").pipe(
            Effect.annotateLogs({ messageId: result.success.messageId }),
          );
          return yield* jsonResponse({ sent: true, message_id: result.success.messageId }, 202);
        }),
      };
    }).pipe(Effect.provide(Cloudflare.Email.SendBinding)),
  );

export default makeWorker();
