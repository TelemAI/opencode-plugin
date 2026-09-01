// The single source of the Telem config vocabulary, its file layer, and the
// per-key resolution every harness surface shares.

export {
  COERCERS,
  COERCION_JSON_TYPE,
  TELEM_OPTION_KEYS,
  TELEM_OPTIONS,
  asFlag,
  asName,
  asNameList,
  asOverridesMap,
  coerceOption,
  csvValue,
  normalizeEmpty,
  optionFromEnv,
  trimBlank,
} from "./options.ts"
export type {
  CoercionClass,
  JsonType,
  TelemOptionKey,
  TelemOptionSpec,
  TelemOptions,
} from "./options.ts"

export {
  CONFIG_DIR_ENV,
  CONFIG_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  TELEM_DIR_NAME,
  credentialsPath,
  fileSignature,
  homeDir,
  projectConfigPath,
  readCredentials,
  readTelemFile,
  resolveTelemDir,
  userConfigPath,
} from "./files.ts"
export type { Env, TelemDir, TelemFileRead } from "./files.ts"

export { resolveOptions } from "./resolve.ts"
export type { Resolution, ResolveInput, SourceLevel } from "./resolve.ts"

export { isBehind, noticeAlreadyShown, updateCommandFor } from "./version.ts"

export {
  LAYER_LEVELS,
  createConfigReader,
  createNoticeSink,
  layerRank,
  resolveHarnessOptions,
} from "./layers.ts"
export type {
  CachedRead,
  ConfigReader,
  HarnessLayersInput,
  HarnessResolution,
  LayerLevel,
  Notice,
  ResolvedLayer,
} from "./layers.ts"
