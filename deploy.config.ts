import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";

const Hostname = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$(?![\s\S])/,
  ),
);
const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$(?![\s\S])/));
const Domain = Schema.Struct({ name: Hostname, zoneName: Hostname }).check(
  Schema.makeFilter(({ name, zoneName }) => name === zoneName || name.endsWith(`.${zoneName}`)),
);

// Only deployment identity belongs here; runtime policy is canonical in source.
// Credentials and delivery addresses live exclusively in KV.
const DeployConfig = Schema.Struct({
  worker: Schema.Struct({
    name: Name,
    domain: Schema.optionalKey(Schema.Union([Domain, Schema.Null])),
  }),
});

export type DeployConfig = typeof DeployConfig.Type;

export const decodeDeployConfig = Schema.decodeUnknownSync(DeployConfig, {
  onExcessProperty: "error",
});

// Called only by the deployment entrypoint, never by the Worker or tests.
export const loadDeployConfig = (): DeployConfig => {
  let configuration: string;
  try {
    configuration = readFileSync(new URL("./canary.deploy.json", import.meta.url), "utf8");
  } catch (cause) {
    throw new Error(
      "Cannot read canary.deploy.json. Copy canary.deploy.example.json to canary.deploy.json and edit it for your deployment.",
      { cause },
    );
  }
  return decodeDeployConfig(JSON.parse(configuration));
};
