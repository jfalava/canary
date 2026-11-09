import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { cloudflareProviders, cloudflareState, defineCloudflareServices } from "./cloudflare.ts";
import { loadDeployConfig } from "./deploy.config.ts";

const deployConfig = loadDeployConfig();

export default Alchemy.Stack(
  // Keep the existing state partition; Canary is the public Worker identity.
  "AlertEmail",
  { providers: cloudflareProviders, state: cloudflareState },
  Effect.gen(function* () {
    const { worker } = yield* defineCloudflareServices(deployConfig);
    return { workerName: worker.workerName, url: worker.url };
  }),
);
