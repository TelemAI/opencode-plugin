// The HARNESS-PLUGIN layering of the unified config (spec, levels 1-6) —
// the six-level ladder the TypeScript plugins resolve on every tool call:
//
//   1 host     the host-native options slot (opencode's plugin-tuple object)
//   2 project  <project>/.telem/telem.json
//   3 legacy   project host file (.opencode/telem.json | .pi/telem.json)
//   4 legacy   user host file (~/.config/opencode|pi/telem.json)
//   5 user     <telem dir>/telem.json  (TELEM_CONFIG_DIR-aware)
//   6 env      TELEM_*
//
// TS-ONLY BY CONSTRUCTION, and deliberately not part of the cross-language
// corpus: levels 1/3/4 exist only on the TypeScript harness surfaces. The
// contract every reader shares — including the Python mirror in
// `telem/_config_files.py` — is `resolve.ts` (levels 2/5/6), which the
// `fixtures/` corpus pins on both sides. What this module adds is the migration
// ladder around it, and it is pinned end-to-end by BOTH plugin suites
// (the sibling plugin own suite, the pi surface), which is
// where the wire consequences of a precedence change are actually visible;
// its own suite adds the few rules those suites cannot state cheaply
// (a degenerate `projectRoot`, and what makes a notice speak again).
//
// Level 4 sits deliberately ABOVE level 5: during migration a surface-specific
// file must not be inverted by the generic one. Level 3 is its own
// level rather than a peer of level 2, so a deprecated file's `fields` can never
// beat the canonical file's `tier`.
//
// Node built-ins only — the plugins ship as dependency-free bundles.

import { join } from "node:path"

import type { Env } from "./files.ts"
import {
  CONFIG_FILE_NAME,
  fileSignature,
  homeDir,
  projectConfigPath,
  readTelemFile,
  resolveTelemDir,
} from "./files.ts"
import type { TelemOptionKey, TelemOptions } from "./options.ts"
import { COERCERS, TELEM_OPTIONS, optionFromEnv } from "./options.ts"

/** Which layer supplied a key. */
export type LayerLevel = "host" | "project" | "legacyProject" | "legacyUser" | "user" | "env"

/** The ladder, most specific first. Index IS the precedence rank. */
export const LAYER_LEVELS: readonly LayerLevel[] = [
  "host",
  "project",
  "legacyProject",
  "legacyUser",
  "user",
  "env",
]

/** 0 (host) … 5 (env). Lower wins. */
export function layerRank(level: LayerLevel): number {
  return LAYER_LEVELS.indexOf(level)
}

/** The file layers, in precedence order — the ones that have a path on disk. */
const FILE_LEVELS: readonly LayerLevel[] = ["project", "legacyProject", "legacyUser", "user"]

// ---------------------------------------------------------------------------
// Reading: one parse per EDIT, not one per call
// ---------------------------------------------------------------------------

export type CachedRead = {
  /** The parsed object, or `null` when the file is ABSENT for any reason. */
  data: Record<string, unknown> | null
  /** The stat signature at read time; `null` when the file is not there at all. */
  signature: string | null
}

export type ConfigReader = (path: string) => CachedRead

/**
 * A stat-signature-cached reader over {@link readTelemFile}.
 *
 * Every layer is stat'd on every tool call — that is what makes a config edit
 * take effect on the next call with no host restart — but a file is only
 * re-parsed, and a malformed one only re-warned, when its signature MOVES. So a
 * broken telem.json says so once per edit rather than once per search.
 *
 * A file that cannot be stat'd is absent SILENTLY (not having one is the normal
 * case) and drops any cached parse, so a file that comes back later is read
 * fresh rather than served stale.
 */
export function createConfigReader(warn: (message: string) => void): ConfigReader {
  const cache = new Map<string, CachedRead>()
  return function read(path: string): CachedRead {
    const signature = fileSignature(path)
    if (signature === null) {
      cache.delete(path)
      return { data: null, signature: null }
    }
    const cached = cache.get(path)
    if (cached && cached.signature === signature) return cached
    const file = readTelemFile(path)
    if (file.warning) warn(file.warning)
    const entry: CachedRead = { data: file.data, signature }
    cache.set(path, entry)
    return entry
  }
}

// ---------------------------------------------------------------------------
// Notices: said once, not once per search
// ---------------------------------------------------------------------------

/**
 * Something the user should see about their own config — a deprecated file
 * still in force, a project file steering provider spend, a dropped key.
 *
 * `channel` is the thing being talked about (one live statement per channel);
 * `key` is the state that statement describes, so the sink stays quiet while
 * nothing changes and speaks again the moment it does. Keys embed a file's stat
 * signature where the statement is about a file, which makes "once per edit"
 * fall out of the same mechanism.
 */
export type Notice = { channel: string; key: string; message: string }

/** Emit each notice whose channel is not already saying exactly that. */
export function createNoticeSink(warn: (message: string) => void): (notices: readonly Notice[]) => void {
  // Bounded by the number of live channels (a handful, plus one per config
  // path), never by the number of tool calls or edits.
  const said = new Map<string, string>()
  return function emit(notices: readonly Notice[]): void {
    for (const notice of notices) {
      if (said.get(notice.channel) === notice.key) continue
      said.set(notice.channel, notice.key)
      warn(notice.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type HarnessLayersInput = {
  env: Env
  /**
   * Level 1, the host-native slot. opencode hands its plugin-tuple options
   * object to the factory; every other harness passes nothing. A non-object is
   * ignored. STATIC per instantiation — the host reads it at load time, so
   * unlike every other level it does not follow an edit until the host reloads.
   */
  hostOptions?: unknown
  /**
   * The harness's project root; `undefined` when it cannot be located at all.
   * An EMPTY STRING means the same thing — a host that hands over `""` (or a
   * caller's `cwd ?? ""`) has not located a project, and `join("", ".telem", …)`
   * would otherwise read a RELATIVE `.telem/telem.json` against whatever the
   * process's cwd happens to be, which is nobody's project file.
   */
  projectRoot?: string
  /**
   * `false` skips BOTH project layers (2 and 3) — pi's untrusted-project rule.
   * The user layers are unaffected. Defaults to `true`.
   */
  projectLayers?: boolean
  /** Level 3 segments under the project root, e.g. `[".opencode", "telem.json"]`. */
  legacyProject: readonly string[]
  /** Level 4 segments under the user's home, e.g. `[".config", "opencode", "telem.json"]`. */
  legacyUser: readonly string[]
  read: ConfigReader
}

/** One located file layer: where it is, and whether it had anything in it. */
export type ResolvedLayer = {
  level: LayerLevel
  path: string
  signature: string | null
  present: boolean
}

export type HarnessResolution = {
  /** Only the keys that resolved, after the tier/fields and overrides rules. */
  values: TelemOptions
  /** The level each resolved key came from (recorded BEFORE any key was dropped). */
  sources: Partial<Record<TelemOptionKey, LayerLevel>>
  /** The file layers that were looked at, in precedence order. */
  layers: ResolvedLayer[]
  /** Everything worth telling the user, deduped by the caller's sink. */
  notices: Notice[]
}

type MutableValues = Record<string, unknown>
type MutableSources = Record<string, LayerLevel>

/** A plain JSON object — not an array, not null. */
function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Locating a layer must never be able to fail a search: a host that outlived the
 * directory it was started in makes `process.cwd` — and therefore path
 * resolution — throw, and a layer we cannot even name is simply absent.
 */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Resolve every option key over the six levels, per KEY: a project file that
 * sets `tier` does not hide the user file's `fields`.
 *
 * Also applies the three composition rules that are the same on every surface —
 * TypeScript and Python alike — and belong with the precedence they depend on:
 * the tier/fields tie-break, the include/exclude subtraction, and the
 * `providerOverrides` membership guard. They run in that order, because each one
 * decides what the next one sees.
 */
export function resolveHarnessOptions(input: HarnessLayersInput): HarnessResolution {
  const notices: Notice[] = []
  const layers: ResolvedLayer[] = []
  const data = new Map<LayerLevel, Record<string, unknown> | null>()

  data.set("host", plainObject(input.hostOptions))

  // `""` is "no project", not "the current directory" — see `projectRoot` above.
  const projectRoot = input.projectRoot || undefined
  const projectLayers = input.projectLayers !== false

  function addFile(level: LayerLevel, path: string | undefined): void {
    if (path === undefined) return
    const read = input.read(path)
    layers.push({ level, path, signature: read.signature, present: read.data !== null })
    data.set(level, read.data)
  }

  if (projectRoot !== undefined && projectLayers) {
    addFile("project", safely(() => projectConfigPath(projectRoot)))
    addFile("legacyProject", safely(() => join(projectRoot, ...input.legacyProject)))
  }
  addFile("legacyUser", safely(() => join(homeDir(input.env), ...input.legacyUser)))

  // The user `.telem` directory is resolved even when the project layers are
  // gated off: the "a repo may not redirect config at itself" refusal is about
  // the environment, not about trust, and applies either way.
  const telemDir = safely(() => resolveTelemDir(input.env, projectRoot))
  if (telemDir?.warning !== undefined) {
    notices.push({ channel: "config-dir", key: telemDir.warning, message: telemDir.warning })
  }
  addFile(
    "user",
    telemDir === undefined ? undefined : safely(() => join(telemDir.dir, CONFIG_FILE_NAME)),
  )

  const values: MutableValues = {}
  const sources: MutableSources = {}
  for (const spec of TELEM_OPTIONS) {
    const coerce = COERCERS[spec.coercion]
    let resolved: unknown
    let level: LayerLevel | undefined
    for (const candidateLevel of LAYER_LEVELS) {
      if (candidateLevel === "env") break
      const layer = data.get(candidateLevel)
      if (!layer) continue
      // Own-property only: a key like `constructor` inherited from
      // Object.prototype is not config, and JSON.parse produces no other
      // inherited keys.
      if (!Object.prototype.hasOwnProperty.call(layer, spec.key)) continue
      const candidate = coerce(layer[spec.key])
      if (candidate !== undefined) {
        resolved = candidate
        level = candidateLevel
        break
      }
    }
    if (level === undefined) {
      const fromEnv = optionFromEnv(spec, input.env)
      if (fromEnv !== undefined) {
        resolved = fromEnv
        level = "env"
      }
    }
    if (level !== undefined) {
      values[spec.key] = resolved
      sources[spec.key] = level
    }
  }

  notices.push(...legacyNotices(layers, projectRoot))
  const project = projectNotice(layers, sources)
  if (project) notices.push(project)
  const composition = composeTierFields(values, sources)
  if (composition) notices.push(composition)
  // BEFORE the overrides guard: the guard checks membership against the include
  // the request will actually carry, which is the SUBTRACTED one.
  const providers = composeProviders(values)
  if (providers) notices.push(providers)
  const guard = guardProviderOverrides(values)
  if (guard) notices.push(guard)

  return {
    values: values as TelemOptions,
    sources: sources as Partial<Record<TelemOptionKey, LayerLevel>>,
    layers,
    notices,
  }
}

/** The unified file a deprecated one should move into. */
function unifiedTargetFor(
  level: LayerLevel,
  layers: readonly ResolvedLayer[],
  projectRoot: string | undefined,
): string {
  if (level === "legacyProject") {
    const project = layers.find((layer) => layer.level === "project")
    if (project) return project.path
    return projectRoot === undefined
      ? `.telem/${CONFIG_FILE_NAME}`
      : (safely(() => projectConfigPath(projectRoot)) ?? `.telem/${CONFIG_FILE_NAME}`)
  }
  const user = layers.find((layer) => layer.level === "user")
  return user ? user.path : `~/.telem/${CONFIG_FILE_NAME}`
}

/**
 * One deprecation notice per legacy file that is actually IN FORCE. A file that
 * is missing, malformed, or not an object says nothing here — the reader has
 * already spoken about the last two, and silence is right for the first.
 */
function legacyNotices(
  layers: readonly ResolvedLayer[],
  projectRoot: string | undefined,
): Notice[] {
  const notices: Notice[] = []
  for (const layer of layers) {
    if (layer.level !== "legacyProject" && layer.level !== "legacyUser") continue
    if (!layer.present) continue
    const target = unifiedTargetFor(layer.level, layers, projectRoot)
    notices.push({
      channel: `legacy:${layer.path}`,
      key: layer.signature ?? "gone",
      message:
        `[telem] ${layer.path} is deprecated: move these settings into ${target}, ` +
        "the one Telem config every harness reads. It still applies until you do — " +
        "above the user-level files, so nothing changes while you migrate.",
    })
  }
  return notices
}

/**
 * Visibility, not a gate: a checked-in project file that decides WHICH
 * PROVIDERS RUN is deciding what a search costs, so say which file did it. The
 * two keys that carry that power are `providersInclude` and `providerOverrides`;
 * `tier`/`fields`/`fullContent` shape the answer, not the spend, and stay quiet.
 *
 * ONCE PER EDIT, like the legacy notices: the key carries each supplying file's
 * STAT SIGNATURE, not just its path and the key names. Keyed on names alone, a
 * commit that changed `providersInclude` from `["exa"]` to `["exa", "serpapi"]`
 * — the edit that actually moves the spend — re-announced nothing, because the
 * statement's own subject ("this file is choosing your providers") had not
 * changed shape. Any edit to a file that supplies one of these keys now says so
 * again, and an edit that touches neither key stays quiet after the first time.
 */
function projectNotice(
  layers: readonly ResolvedLayer[],
  sources: MutableSources,
): Notice | undefined {
  const keys: string[] = []
  const paths = new Set<string>()
  const signatures: string[] = []
  for (const key of ["providersInclude", "providerOverrides"]) {
    const level = sources[key]
    if (level !== "project" && level !== "legacyProject") continue
    const layer = layers.find((entry) => entry.level === level)
    keys.push(key)
    if (layer && !paths.has(layer.path)) {
      paths.add(layer.path)
      signatures.push(`${layer.path}@${layer.signature ?? "gone"}`)
    }
  }
  if (!keys.length) return undefined
  const where = [...paths].join(" and ") || "the project config"
  return {
    channel: "project-providers",
    key: `${signatures.join("|")}|${keys.join(",")}`,
    message:
      `[telem] ${where} (in this project) is choosing search providers: ${keys.join(", ")}. ` +
      "Project config decides which providers run, and therefore what a search costs.",
  }
}

/**
 * A request may carry `tier` OR `fields`, never both (V2-2 answers both
 * with a 400). They resolve independently, so compose them here: the MORE
 * SPECIFIC level wins, and on a true same-level tie `fields` wins — it is the
 * finer instrument, and "fields replaces tier" is the direction the server
 * itself documents.
 *
 * Silently dropping a value the user wrote down is how a config becomes a
 * mystery, so the drop is announced (once per composition, via the sink).
 */
function composeTierFields(values: MutableValues, sources: MutableSources): Notice | undefined {
  const tier = values.tier
  const fields = values.fields
  if (typeof tier !== "string" || !Array.isArray(fields)) return undefined
  const tierRank = layerRank(sources.tier as LayerLevel)
  const fieldsRank = layerRank(sources.fields as LayerLevel)
  const keepTier = tierRank < fieldsRank
  if (keepTier) delete values.fields
  else delete values.tier
  return {
    channel: "tier-fields",
    key: `${tier}@${tierRank}|${(fields as string[]).join(",")}@${fieldsRank}`,
    message:
      `[telem] both tier (${tier}) and fields (${(fields as string[]).join(", ")}) are configured, ` +
      "but a request may carry only one — " +
      (keepTier ? "keeping tier, ignoring fields" : "keeping fields, ignoring tier") +
      " (the more specific source wins; on a tie, fields).",
  }
}

/**
 * The include/exclude composition rule — the third of the three, and the one
 * that keeps a config file from becoming a 400 on EVERY search.
 *
 *   **When both halves resolve, `exclude` is subtracted from `include` here and
 *   only the subtracted `include` is sent.**
 *
 * The server's rule 3 answers `search.providers.include` and `exclude` naming the
 * same provider with a 400, and answers an `include` that resolves to nothing
 * with a 400 as well. Both halves resolving is not exotic: they resolve PER KEY
 * over six levels, so a user file's `providersExclude` meets a project file's
 * `providersInclude` the moment two people configure the thing they each cared
 * about. Forwarding that pair verbatim made a checked-in config break every
 * search in the repository, with a message about the request rather than about
 * the file that wrote it.
 *
 * Subtracting is not a reinterpretation: `include` REPLACES the deployment's
 * default set, so once it resolves it already names the whole candidate
 * set, and "run these, minus those" is exactly `include \ exclude`. That is also
 * what the Python SDK client has always computed for the same pair
 * (`_resolve_search_options` rule 2), so the wire body is now the same bytes from
 * every surface rather than two dialects of one config file.
 *
 * Two outcomes are worth saying out loud, and one is not:
 *
 * - Names actually subtracted → say which, once per edit. The user wrote both
 *   halves down; the resolved set is neither of them.
 * - Subtraction empties `include` → the config states an empty provider set,
 *   which no search can run. Dropping BOTH halves is the only answer that still
 *   searches: the deployment's default set runs, loudly, instead of every call
 *   failing. (An `include: []` on the wire is the server's 400 by design — that
 *   answer belongs to a caller who explicitly asked for nothing, not to a pair of
 *   config files that happened to cancel out.
 * - Nothing subtracted (the halves are disjoint) → silent. `exclude` was already
 *   a no-op against a set `include` fully determines, and dropping a no-op is not
 *   news.
 *
 * `exclude` ALONE keeps riding verbatim: with no `include`, the set it subtracts
 * from is the deployment default, which this process cannot enumerate — so only
 * the server can apply it.
 *
 * Mirrored in `telem/config.py` (`_compose_providers`) and in the pi skill's
 * vendored reader; the shared `fixtures/wire` cases pin that the three produce
 * the same wire bytes.
 */
function composeProviders(values: MutableValues): Notice | undefined {
  const include = values.providersInclude as string[] | undefined
  const exclude = values.providersExclude as string[] | undefined
  if (include === undefined || exclude === undefined) return undefined

  const excluded = new Set(exclude)
  const kept = include.filter((name) => !excluded.has(name))
  const dropped = include.filter((name) => excluded.has(name))
  delete values.providersExclude

  // Once per EDIT: the key is the pair the statement is about, so it speaks
  // again when either half changes and stays quiet while they hold still.
  const key = `${include.join(",")}|${exclude.join(",")}`
  if (kept.length) {
    values.providersInclude = kept
    if (!dropped.length) return undefined
    return {
      channel: "providers-compose",
      key,
      message:
        `[telem] providersExclude removes ${dropped.join(", ")} from providersInclude: ` +
        `this search runs ${kept.join(", ")}. A request may not name the same provider in ` +
        "both halves, so the exclusion is applied to the config and only providersInclude " +
        "is sent.",
    }
  }
  delete values.providersInclude
  return {
    channel: "providers-compose",
    key,
    message:
      `[telem] providersExclude (${exclude.join(", ")}) removes every provider in ` +
      `providersInclude (${include.join(", ")}): this config resolves to an EMPTY provider ` +
      "set, which no search can run, so BOTH halves are dropped and the deployment's default " +
      "provider set is running instead.",
  }
}

/**
 * The membership guard, which is a CONTRACT rather than a repair:
 *
 *   **`providerOverrides` applies only alongside `providersInclude`, and only to
 *   providers named there.** Anything else is DROPPED rather than forwarded.
 *
 * The reason is what the client can KNOW, not what the server will do. Rule 3 of
 * the request contract is that an override must name a provider the request
 * actually selects, and the resolved `providersInclude` is the only statement of
 * that set a client holds. When `providersInclude` is unset the deployment's own
 * default set is running — a set this process cannot enumerate — so no override
 * can be checked against it, and an unverifiable override is not forwarded.
 *
 * Nothing here is a claim about how the server answers an override it did not
 * expect: it ACCEPTS one naming a provider inside its deployment default set,
 * which is exactly the case the client cannot see. The guard exists so the
 * meaning of a config file does not depend on a set the file's author cannot
 * enumerate either — not to prevent a 400.
 *
 * The consequence users trip over, so the notice says it: putting a provider in
 * `providersInclude` REPLACES the deployment's default set with that list — it
 * does not add to it. "Name it to use its override" and "run only what you
 * named" are the same edit.
 *
 * FUTURE WORK: the drop is a floor, not a ceiling. Once the router exposes the
 * `/v1/preprocessors`-informed EFFECTIVE SET (the providers a given key's
 * deployment would actually run, defaults included), this guard can check
 * against that set instead and let an override stand alongside the deployment
 * default set — at which point the contract above is the thing that changes, and
 * it changes in the spec first.
 *
 * The dropped names are said out loud with the fix, because the alternative —
 * an override that silently does nothing — is its own kind of mystery.
 */
function guardProviderOverrides(values: MutableValues): Notice | undefined {
  const overrides = values.providerOverrides as Record<string, Record<string, unknown>> | undefined
  if (overrides === undefined) return undefined
  const include = values.providersInclude as string[] | undefined
  const selected = new Set(include ?? [])
  const kept: Record<string, Record<string, unknown>> = Object.create(null)
  const dropped: string[] = []
  for (const name of Object.keys(overrides)) {
    if (selected.has(name)) kept[name] = overrides[name]
    else dropped.push(name)
  }
  if (!dropped.length) return undefined
  if (Object.keys(kept).length) values.providerOverrides = kept
  else delete values.providerOverrides

  const because =
    include === undefined
      ? "providerOverrides applies only alongside providersInclude, and providersInclude is not " +
        "set, so the deployment's own default provider set is running"
      : "providerOverrides applies only to providers named in the resolved providersInclude " +
        `(${include.join(", ")})`
  const plural = dropped.length > 1
  return {
    channel: "provider-overrides",
    key: `${dropped.join(",")}|${include === undefined ? "" : include.join(",")}`,
    message:
      `[telem] ignoring providerOverrides for ${dropped.join(", ")}: ${because}. ` +
      `Add ${dropped.map((name) => JSON.stringify(name)).join(", ")} to providersInclude in the ` +
      `same config to use ${plural ? "them" : "it"} — noting that providersInclude REPLACES the ` +
      "deployment's default provider set with exactly the providers you list, rather than adding " +
      "to it.",
  }
}
