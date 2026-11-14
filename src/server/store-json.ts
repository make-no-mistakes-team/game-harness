/** Stable JSON identity for canonical and derived ledger receipts. */
export function canonical(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Non-finite request value");
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    return item;
  });
  if (text === undefined) throw new Error("Request must be JSON");
  return text;
}
