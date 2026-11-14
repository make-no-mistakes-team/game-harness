import type { ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";

/**
 * Ownership, not a notification callback. Register before starting allocation.
 * revoke must synchronously fence new work and cancel current work; drain must
 * join startup (including late allocations), requests, transports and shutdown.
 * Neither method may await session.close() or manager revocation, which both
 * join this owner. drain rejection keeps the restriction and prevents SQLite
 * shutdown: it must never claim closure while owned work can still be running.
 * A remote adapter must own its child/connection through this same contract.
 */
export interface InferenceSessionConsumer {
  revoke(): void;
  drain(): Promise<void>;
}

/**
 * One selected account/model grant. Only AuthManager creates and revokes it.
 * Bearers and full upstream provenance are returned unchanged, never journaled.
 * The caller must close in finally; manager revocation also closes and drains
 * the grant even if the caller abandons its wait. Cancellation fences future
 * resolutions immediately, but close joins uncancelled leased refresh commits.
 */
export interface SelectedAccountInferenceSession {
  readonly sessionId: string;
  readonly model: Model;
  readonly thinkingLevel: Effort | undefined;
  readonly singleInferenceDispatch: boolean;
  readonly streamFn: StreamFn | undefined;
  readonly signal: AbortSignal;
  /** Each resolver invocation rechecks the exact requested model and grant. */
  getApiKey(requested: Model): (context: ApiKeyResolveContext) => Promise<ResolvedApiKey>;
  cancel(): void;
  close(): Promise<void>;
}
