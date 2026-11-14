import type { ActionView, AppSnapshot, PolicyView } from "../shared/contracts.ts";
import type { PlanProjection } from "../shared/planning.ts";
import type { StoreReadLocation } from "./store-read.ts";

export const PUBLICATION_LIMITS = Object.freeze({
  startupMs: 5_000, requestMs: 10_000, streamIdleMs: 35_000,
  seedBytes: 2 * 1024 * 1024, requests: 32, eventStreams: 8,
  heartbeatMs: 15_000, pollMs: 100,
});
export interface PublicationRuntimeSeed {
  run_id: string | null;
  action: ActionView | null;
  recovering: boolean;
  policy_order: Pick<PolicyView, "policy_id" | "version" | "last_error">[];
  planning: PlanProjection | null;
}
/** No source, execution collection, event collection or credentials belong here. */
export interface PublicationSeed {
  sequence: number;
  services: Omit<AppSnapshot, "run" | "events">;
  runtime: PublicationRuntimeSeed;
}
export interface PublicationBootstrap {
  token: string;
  instance: string;
  location: StoreReadLocation;
  experience: string;
}
export function isPublicationRoute(method: string, pathname: string): boolean {
  if (method === "POST") return pathname === "/v1/program-comparisons";
  return method === "GET" && (
    ["/v1/state", "/v1/runs", "/v1/events", "/v1/experience"].includes(pathname) ||
    /^\/v1\/runs\/[a-f0-9-]{36}(?:\/(?:skill-evidence|trace|improvements|deaths|planning|events)|\/(?:objective-metrics|skill-evidence)\/[a-f0-9-]{36})?$/.test(pathname)
  );
}
export class PublicationUnavailable extends Error {
  constructor(readonly status = 503, message = "Operator publication is unavailable") {
    super(message);
    this.name = "PublicationUnavailable";
  }
}
