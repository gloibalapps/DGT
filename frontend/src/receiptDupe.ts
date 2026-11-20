export type DupeLevel = "strong" | "likely" | "possible" | null;

/** Strong and likely matches are "already saved". A possible match is only a hint. */
export function looksAlreadySaved(level: DupeLevel): boolean {
  return level === "strong" || level === "likely";
}

/** Batch summary. One receipt, or a batch with nothing already saved, stays quiet. */
export function batchAlreadySavedLine(levels: DupeLevel[]): string | null {
  if (levels.length < 2) return null;
  const flagged = levels.filter(looksAlreadySaved).length;
  if (!flagged) return null;
  return `${flagged} of ${levels.length} look already saved`;
}

export function possibleHint(): string {
  return "A saved expense for the same amount at this supplier is a day apart.";
}
