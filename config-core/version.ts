// Client update advisory — the shared version comparator every Telem surface uses
// to decide whether its own build is behind the version the server recommends.
//
// ONE implementation, MIRRORED (never re-derived) per language: this TypeScript
// and the Python in `telem/_version_advisory.py` both run the same checked-in
// corpus (`fixtures/version/compare.json`), so a string-compare bug that ranks
// "0.2.10" below "0.2.9" fails a suite loudly instead of shipping on one surface.
//
// Two rules the whole feature leans on:
//   * numeric-segment compare — "0.2.10" is NEWER than "0.2.9", never older.
//   * malformed input on either side ⇒ `false` (silent), never a throw: an
//     unreadable version degrades to silence, so a stray value can never crash a
//     client turn.
//
// Kept to plain functions + type aliases (erasableSyntaxOnly, zero-dependency) so
// it loads identically under `node --test`, esbuild, and Bun.

type ParsedVersion = {
  /** Numeric release segments, e.g. `0.2.10` → [0, 2, 10]. */
  release: number[]
  /** Prerelease identifiers (the `-next.1` tail); empty for a stable release. */
  pre: string[]
}

const NUMERIC = /^\d+$/

/**
 * Parse `x.y.z` / `x.y.z-pre.tags`. Build metadata (`+…`) is stripped and ignored,
 * per semver. Returns `null` for anything that is not a run of numeric release
 * segments — the signal every caller turns into silence.
 */
function parseVersion(input: unknown): ParsedVersion | null {
  if (typeof input !== "string") return null
  let text = input.trim()
  if (text === "") return null
  const plus = text.indexOf("+")
  if (plus !== -1) text = text.slice(0, plus)
  const dash = text.indexOf("-")
  const core = dash === -1 ? text : text.slice(0, dash)
  const preText = dash === -1 ? "" : text.slice(dash + 1)
  const release: number[] = []
  for (const part of core.split(".")) {
    if (!NUMERIC.test(part)) return null
    release.push(Number(part))
  }
  // A dash with nothing after it is malformed, not a stable release.
  if (dash !== -1 && preText === "") return null
  const pre = preText === "" ? [] : preText.split(".")
  for (const id of pre) {
    if (id === "") return null
  }
  return { release, pre }
}

/** -1 / 0 / 1 for a<b / a==b / a>b over prerelease identifier lists. */
function comparePre(a: string[], b: string[]): number {
  // A stable release (no prerelease) outranks any prerelease of the same core.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const x = a[i]
    const y = b[i]
    const xn = NUMERIC.test(x)
    const yn = NUMERIC.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xn !== yn) {
      // A numeric identifier has lower precedence than an alphanumeric one.
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/** -1 / 0 / 1 for a<b / a==b / a>b over two already-parsed versions. */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const width = Math.max(a.release.length, b.release.length)
  for (let i = 0; i < width; i++) {
    const x = a.release[i] ?? 0
    const y = b.release[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

/**
 * Is `local` strictly older than `recommended` — i.e. should this client notify?
 * Malformed input on either side ⇒ `false` (silent), never a throw.
 */
export function isBehind(local: string, recommended: string): boolean {
  const a = parseVersion(local)
  const b = parseVersion(recommended)
  if (a === null || b === null) return false
  return compareParsed(a, b) < 0
}

/**
 * The exact update instruction for a surface, from the shared commands corpus.
 * A pure accessor: the caller passes the parsed `commands.json`. Documentation
 * keys (leading `_`) are never surfaces. Returns `undefined` when a surface has
 * no row yet.
 */
export function updateCommandFor(
  surface: string,
  commands: Record<string, unknown>,
): string | undefined {
  if (surface.startsWith("_")) return undefined
  const value = commands[surface]
  return typeof value === "string" ? value : undefined
}

/**
 * Has this surface ALREADY shown the update advisory for `recommendedVersion`
 * today? The cross-run dedup gate: a surface persists the last
 * version it notified about and the calendar day it did (`~/.telem/
 * update-notice.json`). The notice repeats only when the recommended version
 * changes OR the day rolls over — so an interactive one-shot (`opencode run` in
 * a TTY) is told once per release per day, never on every invocation.
 *
 * PURE — no fs, clock, or env: the caller passes the already-read stamp entry
 * for its surface, the recommended version, and today's `YYYY-MM-DD`. A missing,
 * `null`, or malformed entry is "not shown" (`false`), so a lost or unreadable
 * stamp degrades to show-once, never a throw.
 *
 * TS-only by design (no Python mirror): the persisted stamp is a plugin concern.
 * The SDK surfaces dedup once-per-process, so they never read a stamp
 * and this helper has no `telem/` twin — unlike `isBehind`, which every surface
 * runs against the shared corpus.
 */
export function noticeAlreadyShown(
  stampEntry: unknown,
  recommendedVersion: string,
  today: string,
): boolean {
  if (stampEntry === null || typeof stampEntry !== "object") return false
  const entry = stampEntry as { version?: unknown; lastShownDate?: unknown }
  return entry.version === recommendedVersion && entry.lastShownDate === today
}
