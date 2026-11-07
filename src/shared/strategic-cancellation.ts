/** Trusted authoring-close reasons shared by request ownership and evidence consumers. */
export const AUTHORING_CANCELLATION_REASONS: Readonly<Record<string, true>> = Object.freeze({
  root_settled: true,
  scope_lost: true,
  root_replaced: true,
  deadline: true,
  calls: true,
  tools: true,
  fenced: true,
  resident_attention: true,
  policy_interrupt: true,
});
