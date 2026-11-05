/** Complete UTF-8 IPC lines, including envelope and trailing newline. */
export const HISTORY_LIMITS = Object.freeze({
  active: 1,
  queued: 8,
  requestBytes: 8192,
  responseBytes: 65536,
});
