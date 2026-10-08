export type Triple = readonly [number, number, number];

const STRICT = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/**
 * Parses `X.Y.Z` or `vX.Y.Z`. Pre-release and build suffixes are rejected on purpose: a
 * pre-release tag must never be announced as an update, so anything unusual is simply ignored.
 */
export function parseVersion(text: string): Triple | undefined {
  const match = STRICT.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True only when both sides parse and `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}
