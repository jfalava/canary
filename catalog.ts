import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

// Retirement only: Alchemy resolves orphan providers before checking retention.
// Keep this type registered until all stages have forgotten old managed rows.
type CatalogRecord = Resource<
  "AlertEmail.CatalogRecord",
  Record<string, unknown>,
  Record<string, unknown>
>;
export const CatalogRecord = Resource<CatalogRecord>("AlertEmail.CatalogRecord", {
  defaultRemovalPolicy: "retain",
});

export const catalogRecordProvider = Provider.succeed(CatalogRecord, {
  reconcile: () => Effect.die("Catalog records are operator-managed; provisioning is separate"),
  // Retained rows skip delete; older rows without persisted retention must also
  // be forgotten without altering KV. This provider never calls a management API.
  delete: () => Effect.void,
});
