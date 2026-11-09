import { remote, Stage } from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { catalogRecordProvider } from "./catalog.ts";
import type { DeployConfig } from "./deploy.config.ts";
import { makeWorker } from "./src/worker.ts";

export const cloudflareProviders = catalogRecordProvider.pipe(
  Layer.provideMerge(Cloudflare.providers()),
);
export const cloudflareState = Cloudflare.state();

export const defineCloudflareServices = Effect.fnUntraced(function* (deployConfig: DeployConfig) {
  const stage = yield* Stage;
  // Preserve namespace identity and operator-managed contents across deployments.
  const catalog = yield* Cloudflare.KV.Namespace("ServiceCatalog", {
    title: `${deployConfig.worker.name}-${stage}-services`,
  }).pipe(retain(), remote());
  const worker = yield* makeWorker(deployConfig.worker);
  yield* worker.bind("AlertConfiguration", {
    bindings: [{ type: "kv_namespace", name: "ServiceCatalog", namespaceId: catalog.namespaceId }],
  });
  return { worker };
});
