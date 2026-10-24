import type { ActivityEvent } from "../../src/shared/contracts.ts";

export interface ActivityFilter {
  scope: "all" | "current_run" | "system";
  current_run_id: string | null;
  types: readonly string[];
  query: string;
}

/** `all` keeps every event; `system` keeps unattributed events; `current_run` keeps
 * events of one caller-named run and matches nothing while that run is unknown. */
function inScope(event: ActivityEvent, filter: ActivityFilter): boolean {
  if (filter.scope === "system") return event.run_id === null;
  if (filter.scope === "current_run")
    return (
      filter.current_run_id !== null && event.run_id === filter.current_run_id
    );
  return true;
}

/** An empty type list admits every type; otherwise one exact, case-sensitive
 * membership test decides. No type catalog or importance ranking is applied. */
function matchesTypes(event: ActivityEvent, types: readonly string[]): boolean {
  return types.length === 0 || types.includes(event.type);
}

/** A literal, case-insensitive substring of the trimmed query must occur in the
 * event type or summary on its own. The `details` payload is never read. */
function matchesQuery(event: ActivityEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    event.type.toLowerCase().includes(needle) ||
    event.summary.toLowerCase().includes(needle)
  );
}

/** Select loaded events without mutating them: scope, types, and query combine
 * with AND, keep the input order and duplicate references, and never sort. */
export function filterActivity(
  events: readonly ActivityEvent[],
  filter: ActivityFilter,
): ActivityEvent[] {
  return events.filter(
    (event) =>
      inScope(event, filter) &&
      matchesTypes(event, filter.types) &&
      matchesQuery(event, filter.query),
  );
}
