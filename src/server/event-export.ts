import type { ActivityEvent } from "../shared/contracts.ts";

const MAX_EVENTS = 200;
const MAX_BYTES = 262144;

/** Page reader. Callers bind Store methods; this module does not open a database. */
export interface EventExportReader {
  eventsAfter(
    runId: string | null,
    after: number,
    limit: number,
  ): ActivityEvent[];
  lastEventSeq(): number;
}

export interface EventExportOptions {
  run_id: string;
  after: number;
  through_seq: number | null;
  max_events: number;
  max_bytes: number;
}

export type EventExportResult =
  | {
      ok: true;
      ndjson: string;
      exported_count: number;
      next_after: number;
      through_seq: number;
      has_more: boolean;
      details_omitted: true;
    }
  | {
      ok: false;
      code: "invalid_options" | "invalid_reader_result" | "record_too_large";
    };

/**
 * Project one run's events to NDJSON.
 * Dropping details does not redact summary text. A future route must authorize
 * run_id at the operator boundary before calling this.
 */
export function exportEventPage(
  reader: EventExportReader,
  options: EventExportOptions,
): EventExportResult {
  if (!validOptions(options)) return { ok: false, code: "invalid_options" };
  const through = watermark(reader, options);
  if (through === null) return { ok: false, code: "invalid_reader_result" };
  if (through <= options.after)
    return emptyPage(options.after, through);
  let raw: unknown;
  try {
    raw = reader.eventsAfter(
      options.run_id,
      options.after,
      options.max_events + 1,
    );
  } catch {
    return { ok: false, code: "invalid_reader_result" };
  }
  const events = acceptedEvents(
    raw,
    options.run_id,
    options.after,
    options.max_events + 1,
  );
  if (!events) return { ok: false, code: "invalid_reader_result" };
  return pack(events, options, through);
}

function validOptions(options: EventExportOptions): boolean {
  if (options === null || typeof options !== "object") return false;
  if (typeof options.run_id !== "string" || options.run_id.length === 0)
    return false;
  if (!safeCursor(options.after)) return false;
  if (options.through_seq !== null && !safeCursor(options.through_seq))
    return false;
  if (options.through_seq !== null && options.through_seq < options.after)
    return false;
  if (
    typeof options.max_events !== "number" ||
    !Number.isSafeInteger(options.max_events) ||
    options.max_events < 1 ||
    options.max_events > MAX_EVENTS
  )
    return false;
  if (
    typeof options.max_bytes !== "number" ||
    !Number.isSafeInteger(options.max_bytes) ||
    options.max_bytes < 1 ||
    options.max_bytes > MAX_BYTES
  )
    return false;
  return true;
}

function safeCursor(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function watermark(
  reader: EventExportReader,
  options: EventExportOptions,
): number | null {
  if (options.through_seq !== null) return options.through_seq;
  let value: unknown;
  try {
    value = reader.lastEventSeq();
  } catch {
    return null;
  }
  return safeCursor(value) ? value : null;
}

function emptyPage(after: number, through: number): EventExportResult {
  return {
    ok: true,
    ndjson: "",
    exported_count: 0,
    next_after: after,
    through_seq: through,
    has_more: false,
    details_omitted: true,
  };
}

function acceptedEvents(
  value: unknown,
  runId: string,
  after: number,
  limit: number,
): ActivityEvent[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const events: ActivityEvent[] = [];
  let previous = after;
  for (const item of value) {
    if (item === null || typeof item !== "object") return null;
    const event = item as ActivityEvent;
    const sequence = event.event_seq;
    if (event.run_id !== runId) return null;
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence <= previous
    )
      return null;
    previous = sequence;
    events.push(event);
  }
  return events;
}

function pack(
  events: ActivityEvent[],
  options: EventExportOptions,
  through: number,
): EventExportResult {
  const lines: string[] = [];
  let used = 0;
  let exported = 0;
  let nextAfter = options.after;
  for (const event of events) {
    if (event.event_seq > through) break;
    let line: string;
    try {
      line = projectLine(event);
    } catch {
      return { ok: false, code: "invalid_reader_result" };
    }
    const size = Buffer.byteLength(line, "utf8");
    if (exported === options.max_events || used + size > options.max_bytes) {
      if (exported === 0) return { ok: false, code: "record_too_large" };
      return page(lines, exported, nextAfter, through, true);
    }
    lines.push(line);
    used += size;
    exported += 1;
    nextAfter = event.event_seq;
  }
  return page(lines, exported, nextAfter, through, false);
}

function projectLine(event: ActivityEvent): string {
  return (
    JSON.stringify({
      event_seq: event.event_seq,
      run_id: event.run_id,
      at: event.at,
      type: event.type,
      summary: event.summary,
    }) + "\n"
  );
}

function page(
  lines: string[],
  exported: number,
  nextAfter: number,
  through: number,
  hasMore: boolean,
): EventExportResult {
  return {
    ok: true,
    ndjson: lines.join(""),
    exported_count: exported,
    next_after: nextAfter,
    through_seq: through,
    has_more: hasMore,
    details_omitted: true,
  };
}
