// The Telem config vocabulary — ONE source for every reader of the unified
// `.telem/telem.json` file (the design notes).
//
// Everything downstream is generated from or checked against the table below:
// the JSON Schema (the schema generator), the TS resolution helper
// (`resolve.ts`), the Python mirror (`telem/_config_files.py`), the shared
// conformance corpus (`fixtures/`), and — later — the wizard's interview.
// Adding a key here is the only place a key gets added.
//
// Coercion classes are the SHIPPED plugin semantics, lifted verbatim from
// the sibling plugin (asName/asNameList/asFlag): a value counts as SET
// only when it is well-formed, and anything else is ABSENT so the next
// precedence level can still supply that key. `overridesMap` is the one new
// class (no plugin shipped `providerOverrides` yet); it follows the same rule.

/** How a raw JSON value is turned into a resolved option value. */
export type CoercionClass = "name" | "nameList" | "flag" | "overridesMap"

/**
 * The ONE blank definition both readers trim. A CLOSED, EXPLICIT LIST — never
 * either runtime's own idea of whitespace:
 *
 *   U+0020 space   U+0009 tab   U+000A LF   U+000D CR   U+000B VT   U+000C FF
 *   U+00A0 no-break space       U+FEFF byte-order mark  U+3000 ideographic space
 *
 * The six ASCII characters are the common floor. The other three are on the list
 * because they are what a PASTE actually deposits: a value copied out of a web
 * page, a PDF, or a CJK editor arrives padded with NBSP, a BOM, or an ideographic
 * space, and forwarding one to the server turns `"tier": " max "` into a 400.
 * The shipped plugins' `.trim` ate all three, and dropping to ASCII-only would
 * have been a silent regression against them.
 *
 * It stops there, and it is a LIST rather than a call to either runtime, because
 * the runtimes disagree: JS `String.prototype.trim` also eats U+1680, U+2000-200A,
 * U+2028/9, U+202F and U+205F; Python `str.strip` eats those PLUS U+001C-1F and
 * U+0085 (NEL) but NOT U+FEFF. Either runtime's definition would make the same
 * file resolve to two different configs — exactly what this package exists to
 * prevent — so neither is used. Adding a character means adding it to BOTH lists
 * and to the shared corpus, deliberately.
 *
 * Consequence, pinned by the corpus: a lone U+00A0, U+FEFF or U+3000 is ABSENT on
 * both sides; a lone U+0085 or U+2028 is CONTENT on both. The mirror is
 * `_trim_blank` in `telem/_config_files.py`.
 */
const BLANK_CHARS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0x00a0, 0xfeff, 0x3000])

/** Strip leading/trailing characters of the shared blank list — see {@link BLANK_CHARS}. */
export function trimBlank(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && BLANK_CHARS.has(value.charCodeAt(start))) start += 1
  while (end > start && BLANK_CHARS.has(value.charCodeAt(end - 1))) end -= 1
  return start === 0 && end === value.length ? value : value.slice(start, end)
}

/** The JSON type a well-formed value of each coercion class has. */
export const COERCION_JSON_TYPE = {
  name: "string",
  nameList: "array",
  flag: "boolean",
  overridesMap: "object",
} as const satisfies Record<CoercionClass, string>

export type JsonType = (typeof COERCION_JSON_TYPE)[CoercionClass]

/**
 * The normative "empty means absent" rule: `[]`, `{}`, `""` — and a
 * string made only of {@link BLANK_CHARS}, and JSON `null` — resolve exactly like
 * an omitted key, for EVERY key regardless of coercion class. Returns `undefined`
 * for absent, the value itself otherwise.
 *
 * The coercers below call this first, so the rule holds even for a value whose
 * type does not match its key (`fullContent: {}` is absent, not `false`).
 */
export function normalizeEmpty(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return trimBlank(value) ? value : undefined
  if (Array.isArray(value)) return value.length ? value : undefined
  if (typeof value === "object") return Object.keys(value as object).length ? value : undefined
  return value
}

/** A plain JSON object — not an array, not null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asName(value: unknown): string | undefined {
  const raw = normalizeEmpty(value)
  if (typeof raw !== "string") return undefined
  return trimBlank(raw) || undefined
}

export function asNameList(value: unknown): string[] | undefined {
  const raw = normalizeEmpty(value)
  if (!Array.isArray(raw)) return undefined
  const names = raw.map((item) => (typeof item === "string" ? trimBlank(item) : "")).filter(Boolean)
  return names.length ? names : undefined
}

export function asFlag(value: unknown): boolean | undefined {
  const raw = normalizeEmpty(value)
  return typeof raw === "boolean" ? raw : undefined
}

/**
 * `{ "<provider>": { <raw provider params> } }`. Provider names are trimmed;
 * an entry whose value is not a plain object is dropped (the params are passed
 * to the server verbatim, so their SHAPE is deliberately not policed here).
 *
 * The map is built on a NULL PROTOTYPE. With an ordinary `{}`, a provider named
 * `__proto__` does not become a key at all: `out["__proto__"] = params` runs the
 * inherited `__proto__` setter and REPARENTS the map, so the entry vanishes from
 * `Object.keys`/`JSON.stringify` while the attacker's params leak in as inherited
 * properties that any `for.in` then enumerates. `Object.create(null)` has no
 * such setter, so `__proto__` is an ordinary own key — which is what Python's
 * `dict` already did, and what the corpus now pins on both sides.
 *
 * Numbers inside the params are whatever the host's JSON parser makes of them,
 * and the two hosts genuinely differ outside IEEE-754 double range — see the
 * "host-parser limits" note in `files.ts`.
 */
export function asOverridesMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  const raw = normalizeEmpty(value)
  if (!isPlainObject(raw)) return undefined
  const out = Object.create(null) as Record<string, Record<string, unknown>>
  for (const [name, params] of Object.entries(raw)) {
    const provider = trimBlank(name)
    if (provider && isPlainObject(params)) out[provider] = params
  }
  return Object.keys(out).length ? out : undefined
}

export const COERCERS: Record<CoercionClass, (value: unknown) => unknown> = {
  name: asName,
  nameList: asNameList,
  flag: asFlag,
  overridesMap: asOverridesMap,
}

/**
 * The six option keys. `env` is the variable each key falls back to; `envAliases`
 * are DEPRECATED variables read below it (v1 names kept working). `providerOverrides`
 * has no env form on purpose — a JSON blob in a shell variable is not a config
 * surface anyone should be pushed toward.
 */
export const TELEM_OPTIONS = [
  {
    key: "tier",
    jsonType: "string",
    coercion: "name",
    env: "TELEM_TIER",
    envAliases: [],
    description:
      "Normalized field tier for search results: minimalist, default, extended, or max. " +
      "Mutually exclusive with `fields` — a request may carry only one.",
  },
  {
    key: "fields",
    jsonType: "array",
    coercion: "nameList",
    env: "TELEM_FIELDS",
    envAliases: [],
    description:
      "Explicit list of normalized result fields to request (e.g. title, url, summary). " +
      "Replaces `tier` when both are configured.",
  },
  {
    key: "providersInclude",
    jsonType: "array",
    coercion: "nameList",
    env: "TELEM_PROVIDERS_INCLUDE",
    envAliases: ["TELEM_PROVIDERS"],
    description:
      "Search providers to run, REPLACING the deployment's default set (e.g. exa, tavily).",
  },
  {
    key: "providersExclude",
    jsonType: "array",
    coercion: "nameList",
    env: "TELEM_PROVIDERS_EXCLUDE",
    envAliases: [],
    description: "Search providers to drop from the set that would otherwise run.",
  },
  {
    key: "fullContent",
    jsonType: "boolean",
    coercion: "flag",
    env: "TELEM_FULL_CONTENT",
    envAliases: [],
    description:
      "Ask providers for each result's full page content instead of a summary. " +
      "Slower and more expensive; off unless set.",
  },
  {
    key: "providerOverrides",
    jsonType: "object",
    coercion: "overridesMap",
    env: null,
    envAliases: [],
    description:
      'Raw per-provider request parameters, merged into that provider\'s request only: ' +
      '{"exa": {"numResults": 2}}. Unvalidated passthrough — the server owns the names.',
  },
] as const satisfies readonly TelemOptionSpec[]

/** The shape every entry of {@link TELEM_OPTIONS} conforms to. */
export type TelemOptionSpec = {
  key: string
  jsonType: JsonType
  coercion: CoercionClass
  env: string | null
  envAliases: readonly string[]
  description: string
}

export type TelemOptionKey = (typeof TELEM_OPTIONS)[number]["key"]

/** The resolved value type of each coercion class. */
type ValueOfClass<C extends CoercionClass> = C extends "name"
  ? string
  : C extends "nameList"
    ? string[]
    : C extends "flag"
      ? boolean
      : Record<string, Record<string, unknown>>

/** `{ tier?: string; fields?: string[]; ... }`, derived — never hand-written. */
export type TelemOptions = {
  [Entry in (typeof TELEM_OPTIONS)[number] as Entry["key"]]?: ValueOfClass<Entry["coercion"]>
}

export const TELEM_OPTION_KEYS: readonly TelemOptionKey[] = TELEM_OPTIONS.map((option) => option.key)

/** Coerce one raw JSON value for `key`, or `undefined` when it is absent/malformed. */
export function coerceOption(key: TelemOptionKey, value: unknown): unknown {
  const spec = TELEM_OPTIONS.find((option) => option.key === key)
  if (!spec) return undefined
  return COERCERS[spec.coercion](value)
}

/**
 * A comma-separated env value: items stripped, empties dropped, an all-empty
 * value unset. An env var can therefore never express an explicit empty list.
 */
export function csvValue(raw: string | undefined): string[] | undefined {
  return raw === undefined ? undefined : asNameList(raw.split(","))
}

/**
 * Read one key from an env bag. Only `"1"` turns a flag on (the shipped rule);
 * `nameList` keys parse as CSV; `name` keys are trimmed. Deprecated aliases are
 * read strictly BELOW the primary variable.
 */
export function optionFromEnv(
  spec: TelemOptionSpec,
  env: Record<string, string | undefined>,
): unknown {
  const names = spec.env === null ? [] : [spec.env, ...spec.envAliases]
  for (const name of names) {
    const raw = env[name]
    if (raw === undefined) continue
    const value =
      spec.coercion === "nameList"
        ? csvValue(raw)
        : spec.coercion === "flag"
          ? raw === "1" || undefined
          : spec.coercion === "name"
            ? asName(raw)
            : undefined
    if (value !== undefined) return value
  }
  return undefined
}
