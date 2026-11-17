const officialSessionFailures = new WeakSet<object>();
const OFFICIAL_SESSION_UNAVAILABLE =
  "The official Launcher Minecraft session is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher.";

/** The verifier found no acceptable official session; this does not establish why. */
export class OfficialSessionUnavailableError extends Error {
  readonly stage = "native_launch";
  readonly code = "official_session_unavailable";
  constructor() {
    super(OFFICIAL_SESSION_UNAVAILABLE);
    this.name = "OfficialSessionUnavailableError";
    officialSessionFailures.add(this);
  }
}

/** Only host-created faults receive this fixed projection, never message/property matches. */
export function nativeLaunchFailure(error: unknown): {
  stage: "native_launch"; code: "official_session_unavailable"; error: string;
} | undefined {
  if (!error || typeof error !== "object" || !officialSessionFailures.has(error)) return undefined;
  return { stage: "native_launch", code: "official_session_unavailable", error: OFFICIAL_SESSION_UNAVAILABLE };
}
