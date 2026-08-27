// Per-key resolution over the `.telem` layers (spec, levels 2/5/6).
//
// Deliberately NOT here: the legacy `.opencode/.pi` files (level 3/4), the
// opencode plugin-tuple override (level 1), and the tier/fields tie-break. Those
// are surface-specific and stay with their surface — this module owns only the
// contract every surface shares, which is exactly what the shared corpus pins.

import { join } from "node:path"

import type { Env } from "./files.ts"
import { CONFIG_FILE_NAME, projectConfigPath, readTelemFile, resolveTelemDir } from "./files.ts"
import type { TelemOptionKey, TelemOptions } from "./options.ts"
import { COERCERS, TELEM_OPTIONS, optionFromEnv } from "./options.ts"

/** Which layer supplied a key. Top wins. */
export type SourceLevel = "project" | "user" | "env"

export type Resolution = {
  /** Only the keys that resolved; an absent key is simply not present. */
  values: TelemOptions
  /** The level each resolved key came from, keyed identically to `values`. */
  sources: Partial<Record<TelemOptionKey, SourceLevel>>
  /** Everything that was ignored, in layer order. Callers decide how to surface these. */
  warnings: string[]
  /** The user-level directory actually used (after any refused relocation). */
  telemDir: string
}

export type ResolveInput = {
  env: Env
  /** The harness's project directory. Omitted = no project layer (the SDK's stance). */
  projectRoot?: string
}

/**
 * Resolve every option key against project file > user file > env.
 *
 * Precedence is per KEY, not per file: a project file that sets `tier` does not
 * hide the user file's `fields`. Reading never throws and never fails a call —
 * every problem becomes a warning plus an absent layer.
 */
export function resolveOptions(input: ResolveInput): Resolution {
  const { env, projectRoot } = input
  const warnings: string[] = []

  const project = projectRoot ? readTelemFile(projectConfigPath(projectRoot)) : { data: null }
  if (project.warning) warnings.push(project.warning)

  const telemDir = resolveTelemDir(env, projectRoot)
  if (telemDir.warning) warnings.push(telemDir.warning)
  const userFile = readTelemFile(join(telemDir.dir, CONFIG_FILE_NAME))
  if (userFile.warning) warnings.push(userFile.warning)

  const layers: { level: SourceLevel; data: Record<string, unknown> | null }[] = [
    { level: "project", data: project.data },
    { level: "user", data: userFile.data },
  ]

  const values: Record<string, unknown> = {}
  const sources: Record<string, SourceLevel> = {}
  for (const spec of TELEM_OPTIONS) {
    const coerce = COERCERS[spec.coercion]
    let resolved: unknown
    let level: SourceLevel | undefined
    for (const layer of layers) {
      if (!layer.data) continue
      // Own-property only: a key like `constructor` inherited from Object.prototype
      // is not config, and JSON.parse produces no other inherited keys.
      if (!Object.prototype.hasOwnProperty.call(layer.data, spec.key)) continue
      const candidate = coerce(layer.data[spec.key])
      if (candidate !== undefined) {
        resolved = candidate
        level = layer.level
        break
      }
    }
    if (level === undefined) {
      const fromEnv = optionFromEnv(spec, env)
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

  return {
    values: values as TelemOptions,
    sources: sources as Partial<Record<TelemOptionKey, SourceLevel>>,
    warnings,
    telemDir: telemDir.dir,
  }
}
