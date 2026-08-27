// The file layer of the unified config: where the files live, and the
// tolerance rules for reading one. Mirrored byte-for-behavior by
// `telem/_config_files.py`; the shared corpus in `fixtures/` is what keeps the
// two from drifting.
//
// Node built-ins only — this module is imported by plugins that ship as bundles
// with zero runtime dependencies.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"

import { trimBlank } from "./options.ts"

/** Dot-directory, not a bare `telem/`: `telem/` is a live Python package name. */
export const TELEM_DIR_NAME = ".telem"
export const CONFIG_FILE_NAME = "telem.json"
/** Machine-written, 0600, never valid inside an options file. */
export const CREDENTIALS_FILE_NAME = "credentials.json"
/** Relocates the user directory, `GH_CONFIG_DIR`-style: the value IS the dir. */
export const CONFIG_DIR_ENV = "TELEM_CONFIG_DIR"

export type Env = Record<string, string | undefined>

export type TelemDir = {
  /** Absolute path of the user-level Telem directory. */
  dir: string
  /** Present only when a requested relocation was refused. */
  warning?: string
}

export type TelemFileRead = {
  /** The parsed object, or `null` when the file is ABSENT for any reason. */
  data: Record<string, unknown> | null
  /** Present when something was ignored — a malformed or unreadable file. */
  warning?: string
}

/**
 * The user's home directory, from the env bag. Exported because the harness
 * surfaces also locate their DEPRECATED host-native user files under it
 * (`~/.config/opencode/telem.json`, `~/.config/pi/telem.json`), which are NOT
 * under `TELEM_CONFIG_DIR` — that variable relocates the `.telem` directory,
 * never another tool's config.
 */
export function homeDir(env: Env): string {
  // `USERPROFILE` is the Windows home; `homedir` is the last resort so a bag
  // without either still resolves to something real.
  return env.HOME || env.USERPROFILE || homedir()
}

/**
 * Is `candidate` the project root or inside it? A LEXICAL check on resolved
 * paths: no symlink resolution (realpath's behavior on a not-yet-existing path
 * differs between Node and Python, and this corpus pins the two together) and
 * no case folding (a case-insensitive filesystem can therefore be talked past).
 * It is a guardrail against a repo redirecting config at itself, not a security
 * boundary — a hostile repo can already run code through the harness.
 */
function isInside(candidate: string, projectRoot: string): boolean {
  const root = resolve(projectRoot)
  const target = resolve(candidate)
  return target === root || target.startsWith(root + sep)
}

/**
 * The user-level Telem directory: `~/.telem`, or `TELEM_CONFIG_DIR` when it is
 * set to a non-empty value.
 *
 * A relocation that points INSIDE `projectRoot` is REFUSED with a warning (r1
 * config-redirect-into-repo finding): a checked-in `.telem` must never be able
 * to promote itself to the user level, where the project-file notices do not
 * apply. Callers with no project (the SDK) pass no root and are not checked.
 */
export function resolveTelemDir(env: Env, projectRoot?: string): TelemDir {
  const fallback = join(homeDir(env), TELEM_DIR_NAME)
  const raw = env[CONFIG_DIR_ENV]
  const requested = raw === undefined ? "" : trimBlank(raw)
  if (!requested) return { dir: fallback }
  if (projectRoot && isInside(requested, projectRoot)) {
    return {
      dir: fallback,
      warning:
        `[telem] ignoring ${CONFIG_DIR_ENV}=${requested}: it points inside the project ` +
        `(${resolve(projectRoot)}); using ${fallback} instead`,
    }
  }
  // Relative values resolve against the process cwd, matching every other tool
  // that takes a directory from the environment.
  return { dir: isAbsolute(requested) ? requested : resolve(requested) }
}

/** `<projectRoot>/.telem/telem.json`. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, TELEM_DIR_NAME, CONFIG_FILE_NAME)
}

/** `<telem dir>/telem.json`, plus any warning from resolving that directory. */
export function userConfigPath(env: Env, projectRoot?: string): { path: string; warning?: string } {
  const { dir, warning } = resolveTelemDir(env, projectRoot)
  return warning === undefined
    ? { path: join(dir, CONFIG_FILE_NAME) }
    : { path: join(dir, CONFIG_FILE_NAME), warning }
}

/** `<telem dir>/credentials.json`, plus any warning from resolving that directory. */
export function credentialsPath(env: Env, projectRoot?: string): { path: string; warning?: string } {
  const { dir, warning } = resolveTelemDir(env, projectRoot)
  return warning === undefined
    ? { path: join(dir, CREDENTIALS_FILE_NAME) }
    : { path: join(dir, CREDENTIALS_FILE_NAME), warning }
}

/**
 * Read `~/.telem/credentials.json` into `{ apiKey?, baseUrl? }`. NEVER throws.
 *
 * The mirror of the Python SDK's `read_credentials`, so every surface resolves
 * the key the SAME way — `arg? → TELEM_API_KEY env → credentials.json` — and the
 * one file `create-telemai` writes reaches the plugins too (the opencode/pi/
 * openclaw plugins previously read env only, so an installed-but-not-exported key
 * never arrived: a `401 Missing API key`).
 *
 * SILENT by design, unlike the options readers: this feeds a plugin's own auth,
 * and a library that prints to a host's stderr because a credentials file it was
 * never told about is malformed gets vendored around. A missing / malformed /
 * partial file supplies nothing and the caller's env/defaults stand. `apiKey` and
 * `baseUrl` are taken only when present and a non-empty string; every other key is
 * ignored. Passing `projectRoot` engages the same "refuse a credentials dir inside
 * the repo" guard as the options readers.
 */
export function readCredentials(env: Env, projectRoot?: string): { apiKey?: string; baseUrl?: string } {
  let data: unknown
  try {
    data = readTelemFile(credentialsPath(env, projectRoot).path).data
  } catch {
    // credentialsPath itself can throw (a relative TELEM_CONFIG_DIR reaching a
    // deleted cwd); this runs on every search, so it must degrade, never raise.
    return {}
  }
  if (typeof data !== "object" || data === null) return {}
  const record = data as Record<string, unknown>
  const out: { apiKey?: string; baseUrl?: string } = {}
  if (typeof record.apiKey === "string" && record.apiKey) out.apiKey = record.apiKey
  if (typeof record.baseUrl === "string" && record.baseUrl) out.baseUrl = record.baseUrl
  return out
}

/**
 * UTF-8, strictly. `ignoreBOM: true` is the literal opposite of what it sounds
 * like — it means "hand me the BOM as a character rather than eating it" — and
 * that is what we want, because Python's `bytes.decode("utf-8")` eats nothing
 * and the BOM is then stripped by ONE shared rule below. Left on the default,
 * TextDecoder would silently swallow a first BOM that Python still saw, and a
 * two-BOM file would read as valid here and malformed there.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Read one config file. It NEVER throws: a missing, unreadable, malformed, or
 * non-object file is simply ABSENT, and the next precedence level supplies the
 * keys instead — a stray keystroke in telem.json can never fail a search.
 *
 * A MISSING file is silent (not having one is the normal case); anything else
 * returns exactly one warning, so a broken file is visible without being noisy.
 * Parsing is strict `JSON.parse`: no comments, no trailing commas (r3 dropped
 * JSONC precisely to keep this line identical in both languages), and no
 * `NaN`/`Infinity` (JSON has no such literals — Python's parser accepts them by
 * default, so its mirror passes a `parse_constant` that refuses).
 *
 * Bytes are decoded FATALLY rather than with replacement characters: a file that
 * is not valid UTF-8 is a file we cannot claim to have read, and silently using
 * `�`-corrupted values diverged from the Python mirror, which raises.
 *
 * A single leading U+FEFF is then stripped — Windows Notepad writes one and
 * `JSON.parse` rejects it, so the byte-order mark alone made a correct config
 * unreadable on both sides. Exactly ONE is stripped: a file with two is still
 * malformed, identically in both languages.
 *
 * Host-parser limits (documented, not policed — `providerOverrides` params are
 * verbatim passthrough and the server owns their shape):
 *  - NUMBERS agree only within IEEE-754 double range and precision, which is the
 *    interoperable range RFC 8259 describes. Outside it the hosts differ and
 *    cannot be reconciled: `12345678901234567890` parses exactly in Python and
 *    rounds to `12345678901234567000` here; `1e999` is `Infinity` here and
 *    `float("inf")` there; `1.0` keeps its point in Python and loses it here.
 *  - DEPTH: this parser is iterative and has survived 10,000,000 levels; Python's
 *    is recursive and gives up (as a warning, never a raise) around 9,998.
 * The corpus therefore stays inside the range where both agree, and each side's
 * own tests pin where it stops.
 */
export function readTelemFile(path: string): TelemFileRead {
  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === "ENOENT" || code === "ENOTDIR") return { data: null }
    return { data: null, warning: `[telem] ignoring ${path}: ${errorText(error)}` }
  }
  let raw: string
  try {
    raw = UTF8.decode(bytes)
  } catch {
    return { data: null, warning: `[telem] ignoring ${path}: not valid UTF-8` }
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { data: null, warning: `[telem] ignoring ${path}: ${errorText(error)}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { data: null, warning: `[telem] ignoring ${path}: expected a JSON object` }
  }
  return { data: parsed as Record<string, unknown> }
}

function errorText(error: unknown): string {
  const message = (error as Error)?.message
  return message ? message : "unreadable"
}

/**
 * A stat signature (`mtimeMs:size`) for a path, or `null` when it cannot be
 * stat'd. The plugins key their per-call parse cache on this, so a file is
 * re-read — and a malformed one re-warned — once per EDIT, not once per call.
 * Size rides along with the mtime because two writes can land in one millisecond.
 */
export function fileSignature(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

export { normalizeEmpty, trimBlank } from "./options.ts"
