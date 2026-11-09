import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { SendEmailMessage } from "@alchemy.run/cloudflare/Email";
import { Stack } from "alchemy/Stack";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { decodeAlertRequest, decodeCredentialRecord } from "../src/services.ts";

let Worker: typeof import("../src/worker.ts").default;
const firstToken = "first-source-test-credential-0123456789";
const secondToken = "second-source-test-credential-9876543210";
// Independently computed with sha256sum, not the worker's hashing implementation.
const firstDigest = "ec1da63296d564b7adbe96a10652141b674060f5a4055c1c1c28063472d0e7a8";
const secondDigest = "22ce1f2a074bc96fed3c29f25f0925bbff33538bfc26cfb28b2a64261c64226c";
const firstKey = `credentials/${firstDigest}`;
const secondKey = `credentials/${secondDigest}`;
const valid = {
  title: "Service failed",
  message: "Disk offline",
};
const messages: SendEmailMessage[] = [];
let provider: (message: SendEmailMessage) => Promise<{ messageId: string }>;
const records = {
  [firstKey]: {
    schemaVersion: 1,
    enabled: true,
    sender: "alerts@example.com",
    recipient: ["fixed@example.net", "oncall@example.org"],
    name: "Storage monitor",
  },
  [secondKey]: {
    schemaVersion: 1,
    enabled: true,
    sender: "ci@example.com",
    recipient: ["ci-team@example.net"],
  },
};
const lookups: { key: string; type: string }[] = [];
const catalog = (entries: Record<string, unknown>) => ({
  get: async (key: string, type: string) => {
    lookups.push({ key, type });
    // Only exact digest keys exist: raw tokens, uppercase hashes, and scans miss.
    return Object.hasOwn(entries, key) ? JSON.stringify(entries[key]) : null;
  },
});
const env = {
  Email: { send: (message: SendEmailMessage) => provider(message) },
  ServiceCatalog: catalog(records),
};
const withRecord = (record: unknown) => ({
  ...env,
  ServiceCatalog: catalog({ [firstKey]: record }),
});
const originalFetch = globalThis.fetch;
const originalRuntime = globalThis.__ALCHEMY_RUNTIME__;
const originalPhase = process.env.ALCHEMY_PHASE;

// Alchemy's declaration hides the RuntimeContext attached to inline Worker instances,
// and retains plan-only provider requirements even in its runtime branch.
type RuntimeFixture = Effect.Success<typeof Worker> & {
  RuntimeContext: {
    shape(): {
      fetch: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest
      >;
    };
  };
};
const instantiate = async () => {
  const context = Context.makeUnsafe<Effect.Services<typeof Worker>>(new Map());
  return Effect.runPromiseWith(context)(
    Worker.pipe(
      Effect.provideService(Stack, {
        name: "CanaryTest",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Cloudflare.WorkerEnvironment, env),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ALCHEMY_PHASE: "runtime",
        }),
      ),
      // Resource proxies synthesize a callable `then`; do not return one through a Promise.
      Effect.map((resource) => ({ RuntimeContext: (resource as RuntimeFixture).RuntimeContext })),
      Effect.scoped,
    ),
  );
};

let instance: Awaited<ReturnType<typeof instantiate>>;
beforeAll(async () => {
  // Runtime initialization only: no providers, state-store, plan, or deployment.
  globalThis.__ALCHEMY_RUNTIME__ = true;
  process.env.ALCHEMY_PHASE = "runtime";
  globalThis.fetch = Object.assign(() => {
    throw new Error("Network forbidden in tests");
  }, originalFetch);
  // Alchemy captures its plan/runtime layer branch when the module is imported.
  // Keep this runtime instance separate from the declaration tests' module cache.
  const runtimeModule = "../src/worker.ts?runtime-fixture";
  Worker = (await import(runtimeModule)).default;
  instance = await instantiate();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.__ALCHEMY_RUNTIME__ = originalRuntime;
  if (originalPhase === undefined) delete process.env.ALCHEMY_PHASE;
  else process.env.ALCHEMY_PHASE = originalPhase;
});

async function request(
  body: BodyInit | null = JSON.stringify(valid),
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {},
) {
  messages.length = 0;
  lookups.length = 0;
  provider = async (message) => {
    messages.push(message);
    return { messageId: "provider-id-123" };
  };
  const method = options.method ?? "POST";
  const req = new Request(`https://example.test${options.path ?? "/v1/alerts"}`, {
    method,
    headers: {
      Authorization: `Bearer ${firstToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
  return dispatch(req, options.env);
}

async function dispatch(
  req: Request,
  environment: Record<string, unknown> = env,
  rawPath?: string,
) {
  const incoming = HttpServerRequest.fromWeb(req);
  const response = await Effect.runPromise(
    instance.RuntimeContext.shape().fetch.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        rawPath === undefined ? incoming : incoming.modify({ url: rawPath }),
      ),
      Effect.provideService(Cloudflare.WorkerEnvironment, environment),
    ),
  );
  return HttpServerResponse.toWeb(response);
}

test("only health, example and versioned alert routes exist, with route-specific methods", async () => {
  const health = await request(null, {
    path: "/health",
    method: "GET",
    headers: { Authorization: "" },
  });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(health.headers.get("x-content-type-options")).toBe("nosniff");
  expect(lookups).toEqual([]);
  for (const path of [
    "/",
    "/example/",
    "/example?debug=true",
    "/v1/alerts?source=ci",
    "/v1/alerts/",
    "/arbitrary-webhook",
    "/v1/alerts/backups",
    "/v1/alerts/backups/",
    "/v1/alerts/Backups",
    "/v1/alerts/%62ackups",
    "/v1/alerts/backups%2fci",
    "/v1/alerts/backups?source=ci",
    "/v1/alerts/-bad",
    "/v1/alerts/__proto__",
    `/v1/alerts/${"a".repeat(65)}`,
  ]) {
    expect((await request(null, { path })).status).toBe(404);
  }
  for (const [path, method, allow] of [
    ["/health", "POST", "GET"],
    ["/example", "POST", "GET"],
    ["/v1/alerts", "GET", "POST"],
    ["/v1/alerts", "PUT", "POST"],
  ]) {
    const response = await request(null, { path: path!, method: method! });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow!);
  }
  expect(messages).toHaveLength(0);
});

test("example returns fictional policy and request without authentication or live bindings", async () => {
  const response = await request(null, {
    path: "/example",
    method: "GET",
    headers: { Authorization: "" },
    env: {},
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({
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
  });
  expect(decodeCredentialRecord(body.kvPolicy)).toEqual(body.kvPolicy);
  expect(decodeAlertRequest(body.alertRequest)).toEqual(body.alertRequest);
  expect(lookups).toEqual([]);
  expect(messages).toHaveLength(0);
});

test("paths are not decoded or normalized by the handler", async () => {
  // Supply raw HTTP-server paths: WHATWG Request normalizes dot segments first.
  for (const path of [
    "/v1/ci/../alerts",
    "/v1/%2e%2e/alerts",
    "/v1//alerts",
    "/v1/%61lerts",
    "/v1/alerts\n",
    "/v1/alerts#fragment",
    "/v1/alerts?",
  ]) {
    const response = await dispatch(
      new Request("https://example.test/v1/alerts", { method: "POST" }),
      {},
      path,
    );
    expect(response.status).toBe(404);
  }
});

test("Bearer credentials select independent digest policies; body cannot choose delivery addresses", async () => {
  for (const authorization of [
    "",
    "Bearer wrong",
    `bearer ${firstToken}`,
    `Bearer ${firstToken}extra`,
    `Bearer ${firstToken.toUpperCase()}`,
    `Bearer ${firstDigest}`,
    `Bearer ${secondDigest}`,
  ]) {
    const response = await request("invalid", { headers: { Authorization: authorization } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(messages).toHaveLength(0);
  }
  for (const [token, key, sender, recipient, name] of [
    [
      firstToken,
      firstKey,
      "alerts@example.com",
      ["fixed@example.net", "oncall@example.org"],
      "Storage monitor",
    ],
    [secondToken, secondKey, "ci@example.com", ["ci-team@example.net"], undefined],
  ] as const) {
    const response = await request(
      JSON.stringify({ ...valid, metadata: { source: "other", sender: "attacker@example.com" } }),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(202);
    expect(lookups).toEqual([{ key, type: "text" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe("[ERROR] Service failed");
    expect(messages[0]!.from).toBe(sender);
    expect(messages[0]!.to).toEqual([...recipient]);
    if (name) expect(messages[0]!.text).toContain(`Service: ${name}\nTimestamp: `);
    else expect(messages[0]!.text).not.toContain("Service:");
    const other = token === firstToken ? records[secondKey] : records[firstKey];
    for (const fields of [{ sender: other!.sender }, { recipient: other!.recipient }]) {
      expect(
        (
          await request(JSON.stringify({ ...valid, ...fields }), {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
      expect(messages).toHaveLength(0);
    }
  }
  for (const key of [
    "source",
    "severity",
    "sender",
    "recipient",
    "from",
    "to",
    "extra",
    "cc",
    "bcc",
    "service",
    "token",
    "name",
  ]) {
    expect(
      (await request(JSON.stringify({ ...valid, [key]: "attacker@example.com" }))).status,
    ).toBe(400);
    expect(messages).toHaveLength(0);
  }
});

test("Bearer syntax accepts 32..512 printable ASCII characters and rejects malformed auth before KV", async () => {
  for (const authorization of [
    "",
    "Basic ignored",
    `bearer ${firstToken}`,
    `Bearer  ${firstToken}`,
    `Bearer ${"x".repeat(31)}`,
    `Bearer ${"x".repeat(513)}`,
    `Bearer ${firstToken} embedded`,
    `Bearer ${firstToken}\ttab`,
    `Bearer ${firstToken}\x7f`,
    `Bearer ${firstToken}é`,
  ]) {
    const response = await request("invalid", {
      headers: { Authorization: authorization },
      env: {},
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(lookups).toEqual([]);
    expect(messages).toHaveLength(0);
  }
  // sha256sum fixtures also distinguish punctuation from an alphanumeric-only token rule.
  for (const [token, digest] of [
    ["!".repeat(31) + "~", "56f5e10132fb43beb31effbc1f2b84019b607d5047cc2906afc4f26cf8aa84a2"],
    ["0".repeat(511) + "~", "0b2b93fe4f7745804f161a0169df4919074948405e64c1b16ca8871f841cdb39"],
  ]) {
    const key = `credentials/${digest}`;
    expect(
      (
        await request(JSON.stringify(valid), {
          headers: { Authorization: `Bearer ${token}` },
          env: { ...env, ServiceCatalog: catalog({ [key]: records[firstKey] }) },
        })
      ).status,
    ).toBe(202);
    expect(lookups).toEqual([{ key, type: "text" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe("alerts@example.com");
  }
});

test("provider acceptance returns exact success contract, defaults, and preserved text", async () => {
  const before = Date.now();
  const response = await request(
    JSON.stringify({ ...valid, title: "  Example  ", message: "  details\nline 2  " }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ sent: true, message_id: "provider-id-123" });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.subject).toBe("[ERROR] Example");
  expect(messages[0]!.text).toContain("\n\n  details\nline 2  \n\nMetadata:\n{}");
  const timestamp = /Timestamp: (.+)/.exec(messages[0]!.text!)![1]!;
  expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now());
});

test("HTML escapes all untrusted fields while text and metadata remain readable", async () => {
  const response = await request(
    JSON.stringify({
      ...valid,
      title: "<b>host & 'disk'</b>",
      message: '<script>"unsafe" & test</script>',
      timestamp: "2026-10-22T22:17:03+02:00",
      metadata: { "<img>": "<svg onload='bad'>", nested: { source: "untrusted" }, count: 7 },
    }),
  );
  expect(response.status).toBe(202);
  const email = messages[0]!;
  expect(email.subject).toBe("[ERROR] <b>host & 'disk'</b>");
  expect(email.text).toContain("Timestamp: 2026-10-22T22:17:03+02:00");
  expect(email.text).toContain('"count": 7');
  expect(email.html).toContain("&lt;b&gt;host &amp; &#039;disk&#039;&lt;/b&gt;");
  expect(email.html).toContain("&lt;script&gt;&quot;unsafe&quot; &amp; test&lt;/script&gt;");
  expect(email.html).toContain("&lt;svg onload=&#039;bad&#039;&gt;");
  expect(email.html).not.toMatch(/<script|<svg|<img/);
  expect(
    (
      await request(JSON.stringify(valid), {
        env: withRecord({ ...records[firstKey], name: "<img>& CI" }),
      })
    ).status,
  ).toBe(202);
  expect(messages[0]?.html).toContain("Service: &lt;img&gt;&amp; CI");
  expect(messages[0]?.subject).toBe("[ERROR] Service failed");
});

test("reject malformed JSON, wrong types, blank/control content, and field overflows without sending", async () => {
  for (const body of [
    "{",
    "null",
    "[]",
    '"string"',
    "{}",
    ...[
      { title: 7 },
      { title: " \t " },
      { title: "a\r\nBcc: injected" },
      { title: "NUL\0" },
      { title: "x".repeat(201) },
      { title: "😀".repeat(101) },
      { message: null },
      { message: 7 },
      { message: "\n\t " },
      { message: "a\0b" },
      { message: "x".repeat(12_001) },
      { message: "😀".repeat(6_001) },
      { severity: "fatal" },
      { severity: null },
      { metadata: [] },
      { metadata: null },
    ].map((fields) => JSON.stringify({ ...valid, ...fields })),
  ]) {
    expect((await request(body)).status).toBe(400);
    expect(messages).toHaveLength(0);
  }
  expect(
    (
      await request(
        JSON.stringify({ ...valid, title: `  ${"x".repeat(200)}  `, message: "x".repeat(12_000) }),
      )
    ).status,
  ).toBe(202);
  expect(
    (
      await request(
        JSON.stringify({ ...valid, title: "😀".repeat(100), message: "😀".repeat(6_000) }),
      )
    ).status,
  ).toBe(202);
});

test("ISO timestamps validate calendar dates, clock and explicit time zone", async () => {
  for (const timestamp of [
    "2026-10-22",
    "2026-10-22T18:00:00",
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-00-01T12:00:00Z",
    "2026-10-00T12:00:00Z",
    "2026-10-22T24:00:00Z",
    "2026-10-22T12:60:00Z",
    "2026-10-22T12:00:60Z",
    "2026-10-22T12:00:00+24:00",
    "2026-10-22T12:00:00+01:60",
    null,
    7,
  ]) {
    expect((await request(JSON.stringify({ ...valid, timestamp }))).status).toBe(400);
    expect(messages).toHaveLength(0);
  }
  for (const timestamp of ["2024-02-29T23:59:59.123Z", "2026-10-22T12:00:00-07:30"]) {
    expect((await request(JSON.stringify({ ...valid, timestamp }))).status).toBe(202);
    expect(messages[0]!.text).toContain(`Timestamp: ${timestamp}`);
  }
});

test("reject unsupported media/encoding, malformed UTF-8, and failed body streams", async () => {
  for (const headers of [
    { "Content-Type": "text/plain" },
    { "Content-Type": "" },
    { "Content-Type": "application/json; charset=iso-8859-1" },
    { "Content-Encoding": "gzip" },
  ]) {
    expect((await request(JSON.stringify(valid), { headers })).status).toBe(415);
    expect(messages).toHaveLength(0);
  }
  expect(
    (
      await request(JSON.stringify(valid), {
        headers: { "Content-Type": "application/json; charset=UTF-8" },
      })
    ).status,
  ).toBe(202);
  // Replacement decoding would make this otherwise valid JSON and send altered content.
  const invalidUtf8 = new Uint8Array([
    ...new TextEncoder().encode(JSON.stringify({ ...valid, message: "" }).slice(0, -2)),
    0xff,
    ...new TextEncoder().encode('"}'),
  ]);
  expect((await request(new TextDecoder().decode(invalidUtf8))).status).toBe(202);
  expect((await request(invalidUtf8)).status).toBe(400);
  expect(
    (
      await request(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body failed"));
          },
        }),
      )
    ).status,
  ).toBe(400);
  expect(messages).toHaveLength(0);
});

test("actual byte limit holds at 32768 and 32769 with absent or dishonest Content-Length", async () => {
  const base = JSON.stringify({ ...valid, metadata: { padding: "" } });
  // Include a non-ASCII value so a code-unit limit would accept oversized UTF-8.
  const atLimit = base.replace(
    '"padding":""',
    `"padding":"é${"x".repeat(32_768 - new TextEncoder().encode(base).length - 2)}"`,
  );
  expect(new TextEncoder().encode(atLimit).length).toBe(32_768);
  expect((await request(atLimit)).status).toBe(202);
  expect((await request(`${atLimit} `)).status).toBe(413);
  expect(messages).toHaveLength(0);
  expect((await request(`${atLimit} `, { headers: { "Content-Length": "1" } })).status).toBe(413);
  expect(messages).toHaveLength(0);
  for (const length of ["32769", "invalid", "-1"]) {
    expect(
      (await request(JSON.stringify(valid), { headers: { "Content-Length": length } })).status,
    ).toBe(413);
    expect(messages).toHaveLength(0);
  }
});

test("stream overflow cancels the reader rather than buffering the rest", async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(8_192).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect((await request(body)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThan(10);
  expect(messages).toHaveLength(0);
});

test("metadata nesting and numeric overflow fail validation instead of failing email rendering", async () => {
  const nested = (containers: number) =>
    '{"child":'.repeat(containers - 1) + "{}" + "}".repeat(containers - 1);
  const prefix = JSON.stringify(valid).slice(0, -1);
  expect((await request(`${prefix},"metadata":${nested(20)}}`)).status).toBe(202);
  expect(
    (await request(`${prefix},"metadata":{"array":${"[".repeat(19)}0${"]".repeat(19)}}}`)).status,
  ).toBe(202);
  for (const metadata of [
    nested(21),
    nested(3_000),
    '{"number":1e400}',
    '{"array":' + "[".repeat(20) + "0" + "]".repeat(20) + "}",
  ]) {
    expect((await request(`${prefix},"metadata":${metadata}}`)).status).toBe(400);
    expect(messages).toHaveLength(0);
  }
});

test("never acknowledge before provider acceptance and hide upstream errors", async () => {
  await request();
  let accept!: (result: { messageId: string }) => void;
  provider = () =>
    new Promise((resolve) => {
      accept = resolve;
    });
  let responded = false;
  const pending = dispatch(
    new Request("https://example.test/v1/alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    }),
  ).then((response) => {
    responded = true;
    return response;
  });
  for (let attempt = 0; !accept && attempt < 100; attempt += 1) await Bun.sleep(1);
  expect(accept).toBeFunction();
  expect(responded).toBe(false);
  accept({ messageId: "delayed-id" });
  expect(await (await pending).json()).toEqual({ sent: true, message_id: "delayed-id" });
  provider = async () => {
    throw new Error(`private provider diagnostic ${firstToken}`);
  };
  const failed = await dispatch(
    new Request("https://example.test/v1/alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    }),
  );
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "Failed to send alert" });
});

test("registry mailboxes enforce 1/50/51 boundaries and domain-only case folding for duplicates", async () => {
  for (const fields of [
    { sender: undefined },
    { recipient: undefined },
    { sender: [] },
    { recipient: "fixed@example.net" },
    { recipient: [] },
    { recipient: [null] },
    { recipient: ["fixed@example.net", "fixed@EXAMPLE.NET"] },
    ...[
      "fixed@example.net\n",
      "bad\r\nBcc: x@example.net",
      "Display <fixed@example.net>",
      "a@example.net,b@example.net",
      "a..b@example.net",
      ".a@example.net",
      "a@-example.net",
      "a@exam_ple.net",
      "a@localhost",
      `${"x".repeat(65)}@example.net`,
      "a@例え.テスト",
    ].flatMap((value) => [{ sender: value }, { recipient: [value] }]),
  ]) {
    expect(
      (
        await request(JSON.stringify(valid), {
          env: withRecord({ ...records[firstKey], ...fields }),
        })
      ).status,
    ).toBe(503);
    expect(messages).toHaveLength(0);
  }
  for (const recipient of [
    ["fixed@example.net"],
    ["fixed@example.net", "Fixed@EXAMPLE.NET"],
    Array.from({ length: 50 }, (_, i) => `person${i}@example.net`),
  ]) {
    expect(
      (
        await request(JSON.stringify(valid), {
          env: withRecord({ ...records[firstKey], recipient }),
        })
      ).status,
    ).toBe(202);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toEqual(recipient);
  }
  expect(
    (
      await request(JSON.stringify(valid), {
        env: withRecord({
          ...records[firstKey],
          recipient: Array.from({ length: 51 }, (_, i) => `person${i}@example.net`),
        }),
      })
    ).status,
  ).toBe(503);
  expect(messages).toHaveLength(0);
});

test("malformed or oversized registry records fail closed with sanitized configuration errors", async () => {
  for (const record of [
    {},
    [],
    "not an object",
    { ...records[firstKey], schemaVersion: 2 },
    ...[
      { schemaVersion: undefined },
      { enabled: undefined },
      { enabled: "true" },
      { extra: true },
      { sender: [] },
      { recipient: [] },
      { recipient: ["fixed@example.net", "fixed@EXAMPLE.NET"] },
      { recipient: Array.from({ length: 51 }, (_, i) => `p${i}@example.net`) },
      { sender: ["alerts@example.com\n"] },
      { name: "bad\n" },
      { name: "" },
      { name: "x".repeat(101) },
      { name: null },
      { enabled: false, sender: [] },
    ].map((fields) => ({ ...records[firstKey], ...fields })),
  ]) {
    const failed = await request(JSON.stringify(valid), { env: withRecord(record) });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "Alert configuration unavailable" });
    expect(messages).toHaveLength(0);
  }
  const rawRecord = JSON.stringify({ ...records[firstKey], name: "é" });
  const atLimit = rawRecord + " ".repeat(32_768 - new TextEncoder().encode(rawRecord).length);
  expect(
    (
      await request(JSON.stringify(valid), {
        env: { ...env, ServiceCatalog: { get: async () => atLimit } },
      })
    ).status,
  ).toBe(202);
  for (const raw of ["{", "null", `${atLimit} `, 7, undefined]) {
    expect(
      (
        await request(JSON.stringify(valid), {
          env: { ...env, ServiceCatalog: { get: async () => raw } },
        })
      ).status,
    ).toBe(503);
    expect(messages).toHaveLength(0);
  }
});

test("the same runtime observes new entries, console policy edits, disable/delete and digest rotation", async () => {
  const observed: Record<string, unknown> = {};
  const environment = { ...env, ServiceCatalog: catalog(observed) };
  const send = (token = firstToken) =>
    request(JSON.stringify(valid), {
      env: environment,
      headers: { Authorization: `Bearer ${token}` },
    });
  const unauthorized = async (token = firstToken) => {
    const response = await send(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(messages).toHaveLength(0);
  };
  await unauthorized();
  observed[firstKey] = records[firstKey];
  expect((await send()).status).toBe(202);
  expect(messages[0]?.to).toEqual(["fixed@example.net", "oncall@example.org"]);
  observed[firstKey] = {
    ...records[firstKey],
    sender: "updated@example.org",
    recipient: ["new@example.net"],
    name: "New label",
  };
  expect((await send()).status).toBe(202);
  expect(messages[0]?.from).toBe("updated@example.org");
  expect(messages[0]?.to).toEqual(["new@example.net"]);
  expect(messages[0]?.text).toContain("Service: New label\nTimestamp: ");
  observed[firstKey] = { ...records[firstKey], enabled: false };
  await unauthorized();
  delete observed[firstKey];
  await unauthorized();
  observed[firstKey] = records[firstKey];
  expect((await send()).status).toBe(202);
  await unauthorized(secondToken);
  // Publish the new digest first, then revoke the old one. No runtime reinitialization.
  observed[secondKey] = records[firstKey];
  expect((await send(secondToken)).status).toBe(202);
  expect(lookups).toEqual([{ key: secondKey, type: "text" }]);
  expect(messages[0]?.from).toBe("alerts@example.com");
  expect(messages[0]?.to).toEqual(["fixed@example.net", "oncall@example.org"]);
  delete observed[firstKey];
  await unauthorized();
  expect((await send(secondToken)).status).toBe(202);
  delete observed[secondKey];
  await unauthorized(secondToken);
});

test("unavailable bindings/configuration fail closed but health and malformed auth do not read them", async () => {
  for (const environment of [
    { ...env, ServiceCatalog: undefined },
    {
      ...env,
      ServiceCatalog: {
        get: async () => {
          throw new Error(`private ${firstToken}`);
        },
      },
    },
  ]) {
    const failed = await request(JSON.stringify(valid), { env: environment });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "Alert configuration unavailable" });
    expect(messages).toHaveLength(0);
  }
  expect((await request(null, { method: "GET", path: "/health", env: {} })).status).toBe(200);
  expect(lookups).toEqual([]);
  expect((await request(null, { headers: { Authorization: "" }, env: {} })).status).toBe(401);
  expect(lookups).toEqual([]);
  expect((await request(null, { headers: { Authorization: "Bearer short" } })).status).toBe(401);
  expect(lookups).toEqual([]);
});
