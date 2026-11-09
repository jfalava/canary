import { expect, test } from "bun:test";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { ProviderLive as namespaceProvider } from "@alchemy.run/cloudflare/KV";
import { adopt } from "alchemy/AdoptPolicy";
import { evaluate } from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { retain } from "alchemy/RemovalPolicy";
import { InMemoryService, State, type ResourceState } from "alchemy/State";
import { Credentials, fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { catalogRecordProvider } from "../catalog.ts";
import { defineCloudflareServices } from "../cloudflare.ts";
import configuration from "../canary.deploy.example.json";
import { decodeDeployConfig } from "../deploy.config.ts";

const deployConfig = decodeDeployConfig(configuration);
const namespaceId = "0123456789abcdef0123456789abcdef";
const emptyProviders = {
  kind: "ProviderCollection" as const,
  providers: {},
  get: () => undefined,
};
const compile = async (stage = "prod", config = deployConfig) => {
  const state = Layer.succeed(State, Effect.succeed(await Effect.runPromise(InMemoryService())));
  const stack = Alchemy.Stack.of({
    name: "AlertEmail",
    stage,
    resources: {},
    bindings: {},
    actions: {},
  });
  await Effect.runPromise(
    defineCloudflareServices(config).pipe(
      Effect.asVoid,
      Effect.provide(state),
      Effect.provideService(Alchemy.Stack, stack),
      Effect.provideService(Alchemy.Stage, stage),
      Effect.provideService(Cloudflare.Providers, emptyProviders),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  );
  const entries = stack.bindings.AlertEmailWorker!;
  const bindings = await Effect.runPromise(
    evaluate(
      entries.flatMap((entry) => entry.data.bindings ?? []),
      { ServiceCatalog: { namespaceId } },
    ).pipe(Effect.provide(state)),
  );
  return { stack, bindings };
};

test("deployment declares only the Worker and retained registry, with no caller credentials or records", async () => {
  for (const stage of ["prod", "local"]) {
    const { stack, bindings } = await compile(stage);
    expect(Object.keys(stack.resources).sort()).toEqual(["AlertEmailWorker", "ServiceCatalog"]);
    expect(stack.resources.AlertEmailWorker!.Props).toMatchObject({
      name: "example-alerts",
      domain: { name: "alerts.example.com", zoneName: "example.com" },
      workersDev: { enabled: true, previewsEnabled: false },
      compatibility: { date: "2026-10-22", flags: ["nodejs_compat"] },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
        traces: { enabled: true, headSamplingRate: 1 },
      },
    });
    expect(stack.resources.ServiceCatalog!.Props).toEqual({
      title: `example-alerts-${stage}-services`,
    });
    expect(stack.resources.ServiceCatalog!.RemovalPolicy).toBe("retain");
    expect(stack.resources.ServiceCatalog!.Mode).toBe("live");
    expect(bindings).toEqual([
      { type: "send_email", name: "Email" },
      { type: "kv_namespace", name: "ServiceCatalog", namespaceId },
    ]);
    expect(stack.bindings.AlertEmailWorker!.every((entry) => entry.data.env === undefined)).toBe(
      true,
    );
  }
});

test("deployment JSON is strict and preserves unmanaged versus detached domain semantics", async () => {
  for (const domain of [undefined, null, { name: "errors.example.net", zoneName: "example.net" }]) {
    const config = decodeDeployConfig({
      ...deployConfig,
      worker: {
        name: "other-worker",
        ...(domain === undefined ? {} : { domain }),
      },
    });
    const { stack } = await compile("preview", config);
    const props = stack.resources.AlertEmailWorker!.Props;
    expect(props).toMatchObject({
      name: "other-worker",
      workersDev: { enabled: true, previewsEnabled: false },
      compatibility: { date: "2026-10-22", flags: ["nodejs_compat"] },
      observability: { enabled: true, headSamplingRate: 1 },
    });
    expect(Object.hasOwn(props, "domain")).toBe(domain !== undefined);
    if (domain !== undefined) expect(props.domain).toEqual(domain);
    expect(stack.resources.ServiceCatalog!.Props).toEqual({
      title: "other-worker-preview-services",
    });
  }
  for (const invalid of [
    {},
    { ...deployConfig, catalogTitlePrefix: "other-prefix" },
    { ...deployConfig, catalogTitle: "other-registry" },
    { ...deployConfig, sender: "alerts@example.com" },
    { ...deployConfig, worker: { domain: null } },
    { ...deployConfig, worker: { ...deployConfig.worker, name: "bad name" } },
    { ...deployConfig, worker: { ...deployConfig.worker, main: "other.ts" } },
    ...[
      { workersDev: { enabled: false, previewsEnabled: true } },
      { compatibility: { date: "2024-02-29", flags: [] } },
      {
        observability: {
          enabled: false,
          headSamplingRate: 0,
          logs: { enabled: false, invocationLogs: false, headSamplingRate: 0, persist: false },
          traces: { enabled: false, headSamplingRate: 0 },
        },
      },
    ].map((settings) => ({ ...deployConfig, worker: { ...deployConfig.worker, ...settings } })),
    ...[
      "canary.example.com",
      { name: "https://canary.example.com", zoneName: "example.com" },
      { name: "notexample.com", zoneName: "example.com" },
      { name: "canary.example.com", zoneName: "example.com", typo: true },
    ].map((domain) => ({ ...deployConfig, worker: { ...deployConfig.worker, domain } })),
  ]) {
    expect(() => decodeDeployConfig(invalid)).toThrow();
  }
});

test("existing state retires catalog/store ownership without modifying live data, including legacy unstamped retention", async () => {
  for (const retained of [true, false]) {
    const service = await Effect.runPromise(InMemoryService());
    const state = Layer.succeed(State, Effect.succeed(service));
    const address = { stack: "AlertEmail", stage: "prod" };
    const events: string[] = [];
    const fakeProviders: Record<
      string,
      Provider.ProviderService<Alchemy.ResourceLike<string, object, Record<string, unknown>>>
    > = {
      "Cloudflare.KV.Namespace": {
        stables: ["namespaceId", "accountId"],
        list: () => Effect.succeed([]),
        reconcile: () =>
          Effect.sync(() => {
            events.push("namespace");
            return {
              namespaceId,
              accountId: "test-account",
              title: "example-alerts-prod-services",
            };
          }),
        delete: () => Effect.die("Must retain the registry namespace"),
      },
      "Cloudflare.Worker": {
        stables: ["workerName", "workerId", "url"],
        list: () => Effect.succeed([]),
        reconcile: () =>
          Effect.sync(() => {
            events.push("worker");
            return {
              workerName: "example-alerts",
              workerId: "same-worker",
              url: "https://example.invalid",
            };
          }),
        delete: () => Effect.die("Must update, not replace the Worker"),
      },
    };
    // Real retirement implementations, fake infrastructure and forbidden HTTP.
    const providers = Layer.mergeAll(
      catalogRecordProvider,
      Cloudflare.SecretsStore.StoreProviderLive(),
    );
    const offline = Layer.mergeAll(
      state,
      Layer.succeed(Cloudflare.CloudflareEnvironment, Effect.die("Environment forbidden")),
      Layer.succeed(Credentials, Effect.die("Credentials forbidden")),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Network forbidden")),
      ),
    );
    const run = async (compiled: Awaited<ReturnType<typeof compile>>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const planned = yield* Plan.make({ ...compiled.stack, output: {} });
          yield* Alchemy.apply(planned);
        }).pipe(
          Effect.provide(providers),
          Effect.provide(offline),
          Effect.provideService(Cloudflare.Providers, {
            kind: "ProviderCollection",
            providers: fakeProviders,
            get: (type: string) => fakeProviders[type],
          } as unknown as Cloudflare.Providers["Service"]),
          Effect.provideService(Alchemy.Stack, compiled.stack),
          Effect.provideService(Alchemy.Stage, "prod"),
        ),
      );
    await run(await compile());
    expect(events.sort()).toEqual(["namespace", "worker"]);
    const worker = await Effect.runPromise(service.get({ ...address, fqn: "AlertEmailWorker" }));
    if (!worker || !("bindings" in worker)) throw new Error("Expected Worker state");
    // Model the old manifest and static secret binding on the same Worker.
    await Effect.runPromise(
      service.set({
        ...address,
        fqn: "AlertEmailWorker",
        value: {
          ...worker,
          bindings: worker.bindings.map((binding) => ({
            ...binding,
            data: {
              ...binding.data,
              env: { AlertServiceManifest: [{ slug: "old", keyname: "CANARY_OLD_TOKEN" }] },
              bindings: [
                ...(binding.data.bindings ?? []),
                {
                  type: "secrets_store_secret",
                  name: "CANARY_OLD_TOKEN",
                  storeId: "shared",
                  secretName: "CANARY_OLD_TOKEN",
                },
              ],
            },
          })),
        },
      }),
    );
    const row = (
      logicalId: string,
      resourceType: string,
      attr: Record<string, unknown>,
    ): ResourceState => ({
      status: "created",
      logicalId,
      fqn: logicalId,
      resourceType,
      namespace: undefined,
      instanceId: `fixture-${logicalId}`,
      providerVersion: 0,
      downstream: [],
      bindings: [],
      props: {},
      attr,
    });
    await Effect.runPromise(
      service.set({
        ...address,
        fqn: "Service-old",
        value: {
          ...row("Service-old", "AlertEmail.CatalogRecord", {
            namespaceId,
            keyName: "services/old",
            accountId: "test-account",
          }),
          ...(retained ? { removalPolicy: "retain" as const } : {}),
        },
      }),
    );
    await Effect.runPromise(
      service.set({
        ...address,
        fqn: "SharedSecretsStore",
        value: row("SharedSecretsStore", "Cloudflare.SecretsStore", {
          storeId: "shared",
          storeName: "default",
          accountId: "test-account",
        }),
      }),
    );
    events.length = 0;
    await run(await compile());
    expect(events).toEqual(["worker"]);
    expect([...(await Effect.runPromise(service.list(address)))].sort()).toEqual([
      "AlertEmailWorker",
      "ServiceCatalog",
    ]);
    const namespace = await Effect.runPromise(service.get({ ...address, fqn: "ServiceCatalog" }));
    expect(namespace && "attr" in namespace ? namespace.attr?.namespaceId : undefined).toBe(
      namespaceId,
    );
    // Repeated deployments have no catalog writer, seed operation, or secret API.
    events.length = 0;
    await run(await compile());
    expect(events).toEqual([]);
  }
});

test("installed namespace provider adopts, creates, renames by ID, and retains on removal", async () => {
  for (const existing of [true, false]) {
    const state = Layer.succeed(State, Effect.succeed(await Effect.runPromise(InMemoryService())));
    const writes: string[] = [];
    const namespace = {
      id: namespaceId,
      title: "dedicated-alert-catalog",
      supports_url_encoding: true,
    };
    const transport = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.method !== "GET") writes.push(request.method);
        expect(new URL(request.url).pathname).toStartWith(
          "/client/v4/accounts/test-account/storage/kv/namespaces",
        );
        const listing =
          request.method === "GET" && new URL(request.url).pathname.endsWith("/namespaces");
        if (request.method === "GET" && !listing)
          expect(new URL(request.url).pathname).toEndWith(`/namespaces/${namespaceId}`);
        if (request.method === "PUT") {
          expect(new URL(request.url).pathname).toEndWith(`/namespaces/${namespaceId}`);
          if (request.body._tag !== "Uint8Array") throw new Error("Expected namespace JSON body");
          const update = JSON.parse(new TextDecoder().decode(request.body.body));
          expect(update).toEqual({ title: "renamed-example-registry" });
          namespace.title = update.title;
        }
        const available = [
          { ...namespace, id: "f".repeat(32), title: "unrelated-catalog" },
          ...(existing ? [namespace] : []),
        ];
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result: listing ? available : namespace,
            ...(listing
              ? {
                  result_info: {
                    page: 1,
                    per_page: 100,
                    total_pages: 1,
                    total_count: available.length,
                  },
                }
              : {}),
          }),
        );
      }),
    );
    const stack = Alchemy.Stack.of({
      name: "CatalogAdoption",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    });
    const environment = Layer.succeed(
      Cloudflare.CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        accountId: "test-account",
        apiToken: Redacted.make("offline-only"),
        source: { type: "env" as const },
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Cloudflare.KV.Namespace("ServiceCatalog", {
          title: namespace.title,
        }).pipe(Alchemy.remote(), adopt(false), retain());
        const planned = yield* Plan.make({
          ...stack,
          output: { namespaceId: catalog.namespaceId },
        });
        expect(writes).toEqual([]);
        expect(yield* Alchemy.apply(planned)).toEqual({ namespaceId });
        expect(writes).toEqual(existing ? [] : ["POST"]);
        const renamedStack = { ...stack, resources: {}, bindings: {}, actions: {} };
        const renamed = yield* Effect.gen(function* () {
          const sameCatalog = yield* Cloudflare.KV.Namespace("ServiceCatalog", {
            title: "renamed-example-registry",
          }).pipe(Alchemy.remote(), retain());
          return yield* Plan.make({
            ...renamedStack,
            output: { namespaceId: sameCatalog.namespaceId },
          });
        }).pipe(Effect.provideService(Alchemy.Stack, renamedStack));
        expect(yield* Alchemy.apply(renamed)).toEqual({ namespaceId });
        expect(namespace.title).toBe("renamed-example-registry");
        expect(writes).toEqual(existing ? ["PUT"] : ["POST", "PUT"]);
        const removal = yield* Plan.make({ ...renamedStack, resources: {}, output: {} });
        yield* Alchemy.apply(removal);
        expect(writes).toEqual(existing ? ["PUT"] : ["POST", "PUT"]);
      }).pipe(
        Effect.provideService(Cloudflare.Providers, emptyProviders),
        Effect.provide(namespaceProvider()),
        Effect.provide([
          state,
          environment,
          fromApiToken({ apiToken: Redacted.make("offline-only") }),
          Layer.succeed(HttpClient.HttpClient, transport),
        ]),
        Effect.provideService(Alchemy.Stack, stack),
        Effect.provideService(Alchemy.Stage, "test"),
      ),
    );
  }
});
