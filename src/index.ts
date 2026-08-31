import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createHash, randomUUID } from "node:crypto"

// The unified config contract lives in ONE place for every Telem surface —
// option table, `.telem` file layer, six-level resolution. It is
// imported as source with an explicit `.ts` extension, which is what the three
// ways this file is consumed all understand: `node --test` type stripping, the
// esbuild bundle that becomes `@telemai/opencode-plugin`, and the Bun loader a
// real opencode uses on the raw file. `config-core` is `erasableSyntaxOnly`
// precisely so that stays true.
import {
  createConfigReader,
  createNoticeSink,
  readCredentials,
  resolveHarnessOptions,
} from "../config-core/index.ts"
import type { TelemOptions } from "../config-core/index.ts"

const HISTORY_TEXT_CAP = 128000 // per-message cap; opencode tool results can embed whole files

const TOOL_INPUT_CAP = 128000

// telem_fetch (fetch-interactions spec): client-side mirror of the server's
// web_fetch_max_urls default, and the per-URL inline-content cap (the backend's
// inline cap — 5 × 20000 also keeps a full batch inside 100 KB of output).
const FETCH_MAX_URLS = 5
const FETCH_CONTENT_CAP = 20000

// ---------------------------------------------------------------------------
// Configuration (unified config spec). Resolved PER CALL, inside every
// tool execute — nothing is frozen at module load, so editing a config file or
// exporting an env var takes effect on the very next tool call without
// restarting opencode.
//
// Precedence is per KEY, top wins:
//   1. the opencode plugin-tuple options object (below)
//   2. project `<root>/.telem/telem.json`          ← the one file every harness reads
//   3. project `.opencode/telem.json`              ← DEPRECATED, own level
//   4. `~/.config/opencode/telem.json`             ← DEPRECATED, above (5) on purpose
//   5. user `~/.telem/telem.json`                  ← honors TELEM_CONFIG_DIR
//   6. `TELEM_*` env
//
// Levels 2-6 and every rule they obey (coercion, empty-means-absent, the
// tier/fields tie-break, the providerOverrides guard) live in `config-core` and
// are shared byte-for-behavior with the pi extension and the Python readers.
// Credentials (`TELEM_BASE_URL`/`TELEM_API_KEY`) have no file key — they stay
// env-only — but are read per call all the same.
// ---------------------------------------------------------------------------

const LEGACY_PROJECT_CONFIG_PATH = [".opencode", "telem.json"]
const LEGACY_USER_CONFIG_PATH = [".config", "opencode", "telem.json"]

type TelemConfig = TelemOptions & { baseUrl: string; apiKey?: string }

// Module scope: the plugin is one long-lived process, so the parse cache and the
// notice sink outlive individual calls. The cache re-reads a file when its stat
// signature moves and the sink repeats a statement only when what it describes
// changes — together, one warning per EDIT rather than one per search.
const readConfigFile = createConfigReader((message: string) => console.warn(message))
const emitNotices = createNoticeSink((message: string) => console.warn(message))

// `projectRoot` is opencode's own project directory (PluginInput.directory).
// The cwd is only the fallback for hosts that do not supply one — it is not the
// project root in general (opencode's server process can run anywhere), and it
// can THROW when opencode outlives the directory it was started in, in which
// case the project layers are simply absent rather than fatal. A host that hands
// over an EMPTY STRING is likewise "no project": config-core treats `""` as
// absent rather than joining it into a relative `.telem/telem.json`.
//
// `hostOptions` is level 1: the object opencode hands the plugin factory from a
// `["@telemai/opencode-plugin", { ... }]` tuple in opencode.json. Unlike every
// other level it is STATIC for the life of this plugin instance — the host reads
// the tuple once at load, so an edit there needs an opencode restart. That is
// the host's reload semantics, accepted as-is; the file layers are the ones that
// follow an edit.
function resolveTelemConfig(projectRoot?: string, hostOptions?: unknown): TelemConfig {
  let root: string | undefined
  try {
    root = projectRoot ?? process.cwd()
  } catch {
    root = undefined
  }
  const resolved = resolveHarnessOptions({
    env: process.env,
    hostOptions,
    projectRoot: root,
    legacyProject: LEGACY_PROJECT_CONFIG_PATH,
    legacyUser: LEGACY_USER_CONFIG_PATH,
    read: readConfigFile,
  })
  emitNotices(resolved.notices)

  // Credentials resolve `env → ~/.telem/credentials.json` (the SDK's arg→env→file
  // chain), so the key `create-telemai` writes reaches opencode too — env-only left
  // an installed-but-not-exported key unreachable (401 Missing API key).
  const creds = readCredentials(process.env, root)
  const config: TelemConfig = {
    ...resolved.values,
    baseUrl: (process.env.TELEM_BASE_URL ?? creds.baseUrl ?? "https://router.telem.ai").replace(
      /\/+$/,
      "",
    ),
  }
  const apiKey = process.env.TELEM_API_KEY ?? creds.apiKey
  if (apiKey) config.apiKey = apiKey
  return config
}

// The V2 `search` block, or null when nothing was configured — a body
// without the block means "server defaults", which is the common case.
// The two provider halves are forwarded exactly as configured: include REPLACES
// the deployment set and exclude then subtracts, both server-side, so the
// plugin never subtracts client-side and never resolves an overlap itself.
// `provider_overrides` has already been through the membership guard, so what
// arrives here names only providers this request actually selects.
function buildSearchBlock(options: TelemOptions): Record<string, unknown> | null {
  const block: Record<string, unknown> = {}
  if (options.tier !== undefined) block.tier = options.tier
  if (options.fields !== undefined) block.fields = options.fields
  const providers: Record<string, unknown> = {}
  if (options.providersInclude !== undefined) providers.include = options.providersInclude
  if (options.providersExclude !== undefined) providers.exclude = options.providersExclude
  if (Object.keys(providers).length) block.providers = providers
  if (options.fullContent !== undefined) block.include_full_content = options.fullContent
  if (options.providerOverrides !== undefined) {
    // The map is built on a null prototype (config-core), which JSON.stringify
    // serializes exactly like a plain object — spread it into one anyway so the
    // body carries nothing exotic.
    block.provider_overrides = { ...options.providerOverrides }
  }
  return Object.keys(block).length ? block : null
}

// ---------------------------------------------------------------------------
// Trajectory v5 identity (the design notes
// The plugin computes a wire payload keyed on the opencode session's
// own observable state — a hashed context-window id, its last compaction, and
// its revert state — so every writer of a given node derives the same key
// without any shared client memory.
const HARNESS_ID = "opencode"
// Fixed UUID namespace for every client-side uuid5 (never changes).
const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810"
// Sentinel for a missing key component (a session with no compaction/revert yet).
const NONE = "none"

function sha256hex(x: string): string {
  return createHash("sha256").update(x).digest("hex")
}

// Length-prefix a variable component so concatenation is injective even when a
// component itself contains ":" — "12:foo:bar" can never collide with "3:foo" +
// "3:bar". Applied to every component of every uuid5 name and hashed name.
function lp(s: string): string {
  return String(Buffer.byteLength(s, "utf8")) + ":" + s
}

// uuid5 (RFC 4122 v5, sha1-based): sha1(namespace_bytes ++ utf8(name)), first 16
// bytes with the version nibble set to 5 and the variant bits to 0b10.
function uuid5(namespace: string, name: string): string {
  const nsb = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(nsb).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant 0b10
  const x = b.toString("hex")
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

// Hashed context-window id: the raw opencode session id never leaves the machine
// bare inside a key — only its hash does.
function contextWindowHash(sid: string): string {
  return sha256hex(sid)
}

// session_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(comp) + lp(rev)): the
// deterministic identity of one context-window generation. It moves when the
// session compacts (comp changes) or reverts (rev changes) — a new generation.
function sessionKey(sid: string, comp: string, rev: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(contextWindowHash(sid)) + lp(comp) + lp(rev))
}

// fingerprint = H(lp(harness) + lp(sid)): a stable per-session token. It hashes
// the RAW sid (the hash is what leaves the machine, so no id leaks) and includes
// the harness so ids from different harnesses never collide.
function fingerprint(sid: string): string {
  return sha256hex(lp(HARNESS_ID) + lp(sid))
}

// snapshot_node_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(msg) + lp("snap")):
// the id of an ancestor's spawn-point snapshot, keyed on the ancestor's context
// window and the message at which it spawned. The lp("snap") tag keeps it in a
// different space from that session's own session_key.
function snapshotNodeKey(sid: string, msg: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(contextWindowHash(sid)) + lp(msg) + lp("snap"))
}

// The id of the LAST compaction part across all of a session's messages (in
// order), or "none". A compaction appends a stable `compaction` part.
function lastCompactionId(msgs: any[]): string {
  let last = NONE
  for (const message of msgs ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type === "compaction" && typeof part.id === "string") last = part.id
    }
  }
  return last
}

// The id of the last ASSISTANT message — the ancestor's spawn message under the
// freeze invariant. MUST be assistant, not last-of-any-role: a queued or
// steering user message appended to a blocked ancestor must not move the key.
function lastAssistantMessage(msgs: any[]): { id: string; timeMs?: number } | undefined {
  let found: { id: string; timeMs?: number } | undefined
  for (const message of msgs ?? []) {
    if (message?.info?.role === "assistant" && typeof message.info.id === "string") {
      const t = message.info.time?.created
      found = { id: message.info.id, timeMs: typeof t === "number" ? t : undefined }
    }
  }
  return found
}

type HistoryMessage = { role: string; content: string; reasoning?: string }

type FlattenOpts = {
  streamedReasoning?: Map<string, string>
  // The tool call this history is being built for (telem_search or telem_fetch);
  // its own part in the snapshot is still "pending {}" because the input is
  // written after execution starts, so it gets rendered from the live args.
  currentCall?: { messageID: string; args: unknown; tool: string }
}

function toolMarker(part: any, override?: { status: string; input: unknown }): string {
  // Compact acting-trace marker; full tool outputs can embed whole files, so
  // only the tool name, status, and a truncated input are forwarded.
  const status = override?.status ?? part?.state?.status ?? "unknown"
  let input = ""
  try {
    const raw = override ? override.input : part?.state?.input
    if (raw !== undefined) input = " " + JSON.stringify(raw).slice(0, TOOL_INPUT_CAP)
  } catch {
    // non-serializable input; omit
  }
  return `[tool ${part?.tool ?? "?"}: ${status}${input}]`
}

function isEmptyInput(input: any): boolean {
  return (
    input === undefined ||
    (typeof input === "object" && input !== null && Object.keys(input).length === 0)
  )
}

// The flattened entry PLUS the opencode message it came from. The wire shape has
// no id field and never will (`HistoryMessage` is the contract), but the history
// delta needs identity to say "this exact message, with these exact bytes, has
// already gone out" — and identity cannot live on the flattened shape, where a
// third byte-identical message is indistinguishable from the first two. So the
// id rides alongside, at build time only (spec, "Identity").
type FlatMessage = { id: string; entry: HistoryMessage }

function flattenMessagesWithIds(data: any[], opts?: FlattenOpts): FlatMessage[] {
  const history: FlatMessage[] = []
  const source = data ?? []
  for (let index = 0; index < source.length; index++) {
    const message = source[index]
    const role = message?.info?.role
    if (role !== "user" && role !== "assistant") continue
    // ToolContext carries no call id, so the current call is only identified
    // when it is the single unstarted part of the executing tool in its
    // message; parallel pending calls stay as-is rather than risk mislabeling.
    let claimed: any
    if (opts?.currentCall && message?.info?.id === opts.currentCall.messageID) {
      const candidates = (message?.parts ?? []).filter(
        (p: any) =>
          p?.type === "tool" &&
          p?.tool === opts.currentCall!.tool &&
          p?.state?.status === "pending" &&
          isEmptyInput(p?.state?.input),
      )
      if (candidates.length === 1) claimed = candidates[0]
    }
    const contentPieces: string[] = []
    const reasoningPieces: string[] = []
    for (const part of message?.parts ?? []) {
      if (part?.type === "text" && typeof part.text === "string") contentPieces.push(part.text)
      else if (part?.type === "reasoning") {
        // The stored row lags the stream: deltas are bus-events only and the
        // full text is written at reasoning-end, after tools already run. So
        // for in-flight messages the streamed copy is the complete one.
        const stored = typeof part.text === "string" ? part.text : ""
        const streamed = opts?.streamedReasoning?.get(part.id) ?? ""
        const text = streamed.length > stored.length ? streamed : stored
        if (text) reasoningPieces.push(text)
      } else if (part?.type === "tool")
        contentPieces.push(
          part === claimed
            ? toolMarker(part, { status: "running", input: opts!.currentCall!.args })
            : toolMarker(part),
        )
    }
    const content = contentPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    const reasoning = reasoningPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    if (!content && !reasoning) continue
    const entry: HistoryMessage = { role, content }
    if (reasoning) entry.reasoning = reasoning
    // A message with no id of its own is identified by WHERE it sat. An insert
    // above it then reads as "changed" and re-sends it whole — the safe
    // direction. NUL is not producible by an opencode message id, so the
    // fallback can never collide with a real one.
    const id = typeof message?.info?.id === "string" ? message.info.id : "\u0000pos:" + index
    history.push({ id, entry })
  }
  return history
}

// The wire projection: what every caller outside the delta machinery wants.
function flattenMessages(data: any[], opts?: FlattenOpts): HistoryMessage[] {
  return flattenMessagesWithIds(data, opts).map((message) => message.entry)
}

// The V2 capability gate. The renderer below reads ONE shape —
// the normalized envelope — and has no alias ladder to fall back on, so a
// pre-V2 server must fail the tool loudly rather than render an empty result
// set that reads like "the web had nothing". `normalized_schema_version` is the
// interaction-level echo; only telem_search is gated (a fetch interaction never
// carries a search envelope).
function assertV2Envelope(interaction: any): void {
  const version = interaction?.normalized_schema_version
  if (!Number.isInteger(version) || (version as number) < 2) {
    throw new Error(
      `Telem server answered without the normalized search envelope (normalized_schema_version=${version}); ` +
        "upgrade the backend or point TELEM_BASE_URL at a current deployment",
    )
  }
}

// telem-render:begin
// ---------------------------------------------------------------------------
// Search rendering — the V2 normalized envelope (search I/O normalization
//-) turned into the text the model reads. PORTABLE BY CONTRACT: this
// whole region is copied verbatim into the openclaw plugin, so it may not touch
// anything host-specific (no opencode client, no tool context, no env) — it is
// a pure function of one interaction body.
//
// Render budget ( the contract, final):
//   - `summary` renders WHOLE (the server already caps it at 1000 chars);
//   - `excerpt` renders at most 4 entries of at most 1000 chars each, with an
//     elision note when entries were dropped (real entries measure 1-14 KB);
//   - `full_content` is NEVER rendered inline — depth is telem_fetch's job;
//   - per-result `[<provider>]` tag: the schema keeps every provider's list
//     separate ( — no merged list, no global rank), so every row says who
//     found it;
//   - the query-level `answer`/`related` block leads each query section;
//   - a failed or degraded run contributes ONE line instead of rows;
//   - only a BATCH carries a total cap; a single-query render has none.
// A field that a tier did not request, or that a provider could not supply, is
// simply absent from the output — the envelope's own presence rule.
//
// Values are single-line by construction — provider markdown cannot outrank the
// renderer's structure.
// ---------------------------------------------------------------------------

const RENDER_EXCERPT_MAX_ENTRIES = 4
const RENDER_EXCERPT_MAX_CHARS = 1000
const RENDER_RELATED_MAX_ITEMS = 6
const RENDER_TOTAL_CAP = 128000

// EVERY provider value goes through here before it is rendered. Real summaries
// and excerpts are markdown with newlines (a parallel summary opens with `#`
// and `##` headings), and a value allowed to start a line would forge the
// renderer's own structure — a heading outranking `### Query N`, or a bare line
// that reads as content nobody attributed. Folding interior whitespace keeps
// every byte of the value on the line its label owns.
function line(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ") : ""
}

// One result row. URL is the only required field, so it anchors the row;
// everything else is a labelled line that appears only when it carries content.
function renderRow(provider: string, row: any): string {
  const lines = [`[${provider}] URL: ${line(row?.url)}`]
  const title = line(row?.title)
  if (title) lines.push(`Title: ${title}`)
  const summary = line(row?.summary)
  if (summary) lines.push(`Summary: ${summary}`)

  const entries = (Array.isArray(row?.excerpt) ? row.excerpt : [])
    .map((entry: unknown) => line(entry))
    .filter(Boolean)
  if (entries.length) {
    lines.push("Excerpt:")
    for (const entry of entries.slice(0, RENDER_EXCERPT_MAX_ENTRIES)) {
      // The ellipsis marks the cut and sits OUTSIDE the budget, exactly as the
      // server's own the contract does for summaries.
      const cut = entry.length > RENDER_EXCERPT_MAX_CHARS
      lines.push(`- ${cut ? entry.slice(0, RENDER_EXCERPT_MAX_CHARS) + "…" : entry}`)
    }
    const dropped = entries.length - RENDER_EXCERPT_MAX_ENTRIES
    if (dropped > 0) lines.push(`…(${dropped} more excerpt entries)`)
  }

  const published = line(row?.publish_date)
  if (published) lines.push(`Published: ${published}`)
  const source = row?.source
  if (source && typeof source === "object") {
    // The domain is already in the URL, so it only earns a line when the
    // provider named a publication or an author to go with it.
    const name = line(source.name) || line(source.domain)
    const author = line(source.author)
    if (author) lines.push(`Source: ${name ? `${name} by ${author}` : `by ${author}`}`)
    else if (line(source.name)) lines.push(`Source: ${name}`)
  }
  // `full_content` is deliberately not rendered here — see the budget above.
  return lines.join("\n")
}

// The query-level block. These keys are per RUN, but they answer the
// QUERY, so the section carries one block: the first answer any provider
// returned, and the related items pooled across providers (questions first,
// then searches), deduped and capped.
function renderQueryBlock(runs: any[]): string[] {
  const lines: string[] = []
  let answer = ""
  const questions: string[] = []
  const searches: string[] = []
  for (const run of runs) {
    const payload = run?.output_payload
    if (!payload || typeof payload !== "object") continue
    if (!answer) answer = line(payload.answer)
    const related = payload.related
    if (!related || typeof related !== "object") continue
    for (const item of Array.isArray(related.questions) ? related.questions : []) {
      const text = line(item)
      if (text) questions.push(text)
    }
    for (const item of Array.isArray(related.searches) ? related.searches : []) {
      const text = line(item)
      if (text) searches.push(text)
    }
  }
  if (answer) lines.push(`Answer: ${answer}`)
  const related = [...new Set([...questions, ...searches])].slice(0, RENDER_RELATED_MAX_ITEMS)
  if (related.length) lines.push(`Related: ${related.join(", ")}`)
  return lines
}

// Everything one query produced: its block, then each run's contribution in run
// order (rows, or a single line for a run that failed or degraded).
function renderQuerySection(runs: any[]): string {
  const blocks: string[] = []
  const rowBlocks: string[] = []
  for (const run of runs) {
    const provider = line(run?.preprocessor_name) || "unknown"
    const payload = run?.output_payload
    const rows = Array.isArray(payload?.results) ? payload.results : null
    const error = run?.error
    if (run?.status === "failed" || (!rows && error)) {
      // ONE line, like every other value: provider errors are often multi-line
      // (`…\nFor more information check: …`) and an untagged continuation line
      // reads like content.
      const message = line(error?.message) || line(error?.type) || "unknown error"
      rowBlocks.push(`[${provider}] failed: ${message}`)
      continue
    }
    if (!rows?.length) {
      // A SUCCEEDED run whose normalize raised ships the minimal envelope —
      // no rows plus one `normalize_failed` warning. Say so, or the run is
      // invisible next to its healthy siblings and reads as "nothing found".
      // A genuinely empty result set carries no such warning and stays silent.
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
      const degraded = warnings.find((warning: any) => warning?.code === "normalize_failed")
      if (degraded) {
        const message = line(degraded.message) || "normalize_failed"
        rowBlocks.push(`[${provider}] no rows (${message})`)
      }
      continue
    }
    for (const row of rows) rowBlocks.push(renderRow(provider, row))
  }
  const head = renderQueryBlock(runs)
  if (head.length) blocks.push(head.join("\n"))
  blocks.push(...(rowBlocks.length ? rowBlocks : ["No results found."]))
  return blocks.join("\n\n")
}

function formatSearchResults(interaction: any): string {
  // Group the runs by the query that produced them. A batch request runs N
  // queries as ONE interaction and the backend tags every run with a 0-based
  // batch_index and its query text; a single-query interaction has every run at
  // batch_index 0 and renders as one unlabelled section.
  const groups = new Map<number, { query: string; runs: any[] }>()
  for (const run of interaction?.preprocessor_runs ?? []) {
    const index = typeof run?.batch_index === "number" ? run.batch_index : 0
    let group = groups.get(index)
    if (!group) groups.set(index, (group = { query: "", runs: [] }))
    // The query is a value too — the MODEL supplies it (page text copied into a
    // search is a real path), so it goes through the same fold and can never
    // forge a section header or a provider row from inside its own label.
    if (!group.query) group.query = line(run?.query)
    group.runs.push(run)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group)

  // One query (or a response carrying no runs): field-level caps only.
  if (ordered.length <= 1) return renderQuerySection(ordered[0]?.runs ?? [])

  // A batch: one labelled section per query so the model can attribute every
  // row to the query that produced it, plus the one total cap in the renderer —
  // a 32-query batch is the only realistic way to blow up a tool result.
  const text = ordered
    .map((group, i) => {
      const label = group.query ? `Query ${i + 1}: ${group.query}` : `Query ${i + 1}`
      return `### ${label}\n${renderQuerySection(group.runs)}`
    })
    .join("\n\n")
  if (text.length <= RENDER_TOTAL_CAP) return text
  return (
    text.slice(0, RENDER_TOTAL_CAP) +
    `\n\n…(batch output truncated at ${RENDER_TOTAL_CAP} characters — re-run the remaining queries in a smaller batch)`
  )
}
// telem-render:end

// telem_fetch pre-validation (fetch-interactions spec): friendly errors
// BEFORE any network request — the server's 400s stay the authority, this only
// saves the round trip. Returns the trimmed, deduped URL list.
function validateFetchUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("telem_fetch requires at least one URL in `urls`.")
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("telem_fetch: every item in `urls` must be a URL string.")
    }
  }
  const trimmed = (raw as string[]).map((url) => url.trim())
  for (const url of trimmed) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `telem_fetch only reads http(s) URLs, got ${JSON.stringify(url)}. ` +
          "Pass absolute URLs starting with http:// or https://.",
      )
    }
  }
  const urls = [...new Set(trimmed)]
  if (urls.length > FETCH_MAX_URLS) {
    throw new Error(
      `telem_fetch reads at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length}). ` +
        "Split the read into multiple calls.",
    )
  }
  return urls
}

// One section per fetched URL. Succeeded rows carry the page's inline content,
// capped at FETCH_CONTENT_CAP per URL (the backend's own inline cap — the note
// covers both the client-side cut and a backend-truncated row). Failed rows
// render their status and error briefly.
function formatFetchedRow(row: any): string {
  const url = typeof row?.url === "string" ? row.url : ""
  const title = typeof row?.title === "string" ? row.title : ""
  const status = typeof row?.status === "string" ? row.status : "unknown"
  const header = `### ${url}` + (title ? `\nTitle: ${title}` : "") + `\nStatus: ${status}`
  if (status !== "succeeded") {
    const error = row?.error
    const brief =
      error && (error.type || error.message)
        ? `\nError: ${[error.type, error.message].filter(Boolean).join(": ")}`
        : ""
    return header + brief
  }
  const content = typeof row?.content === "string" ? row.content : ""
  const truncated = content.length > FETCH_CONTENT_CAP || row?.content_truncated === true
  const note = truncated ? `\n\n[Content truncated at ${FETCH_CONTENT_CAP} characters]` : ""
  return `${header}\n\n${content.slice(0, FETCH_CONTENT_CAP)}${note}`
}

// Render a fetch interaction. The current backend runs fetch as a FIRST-stage
// unit: one `web_fetch` preprocessor run per URL (batch_index order), each
// carrying its fetched_results row. Older backends ran it as the
// `web_fetch_cache` postprocessor — kept as a fallback so the tool works
// against either deployment.
// A missing run or an empty batch degrades to a clear message, never a throw.
function formatFetchResults(interaction: any): string {
  const preRuns = (interaction?.preprocessor_runs ?? []).filter(
    (r: any) => r?.preprocessor_name === "web_fetch",
  )
  const rows: any[] = []
  if (preRuns.length > 0) {
    preRuns.sort((a: any, b: any) => (a?.batch_index ?? 0) - (b?.batch_index ?? 0))
    for (const run of preRuns) {
      const fetched = run?.output_payload?.fetched_results
      if (Array.isArray(fetched)) rows.push(...fetched)
    }
  } else {
    // Older backend: fetch ran as the web_fetch_cache postprocessor.
    const run = (interaction?.postprocessor_runs ?? []).find(
      (r: any) => r?.postprocessor_name === "web_fetch_cache",
    )
    const fetched = run?.output_payload?.fetched_results
    if (Array.isArray(fetched)) rows.push(...fetched)
  }
  if (rows.length === 0) {
    return "The fetch produced no results (the backend returned no web fetch output)."
  }
  return rows.map(formatFetchedRow).join("\n\n")
}

// ---------------------------------------------------------------------------
// Incremental history, phase 1: an ancestor's context travels ONCE per snapshot.
// Today the same flattened ancestor history is re-sent byte-identically on every
// single call — 82% of this plugin's wire — and the backend is first-writer-wins
// on node content, so every re-send after the first is already a no-op.
//
// What makes dropping it safe is PROOF, not byte counting. An ancestor node
// whose FIRST arrival carries no context is stored with a null context frozen
// forever — unrepairable in the Telem backend and in obs, and it empties the conversation
// title of a purely-delegating root. So context is omitted only for a snapshot
// this instance has PROVEN delivered and only to a backend that has
// PROVEN it implements the skip-and-report guard. Both proofs are
// per (baseUrl, key) scope, because node ids are derived from the account key
// server-side: flip either and every belief about that world is void.
// ---------------------------------------------------------------------------

// Snapshot keys are one-way hashes that can never be mapped back to a session,
// so idle-eviction is impossible and the cache is bounded by count alone
// (the same bound openclaw's trackers use). An eviction costs one redundant full
// re-send — the safe direction.
const DELIVERED_CAP = 4096
// A process sees one or two scopes in its life. Bounded anyway; forgetting a
// capability just re-learns it from the next response, and until then nothing is
// omitted — again the safe direction.
const CAPABILITY_CAP = 64

// Insertion-ordered LRU set: re-adding refreshes recency, and the oldest key is
// the first one `keys` yields.
function createLruSet(cap: number) {
  const entries = new Map<string, true>()
  return {
    has: (key: string): boolean => entries.has(key),
    add(key: string): void {
      entries.delete(key)
      entries.set(key, true)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    remove(key: string): void {
      entries.delete(key)
    },
  }
}

// The same bound over values. Recency is refreshed on WRITE only: a read must
// stay side-effect-free, because the history delta reads the watermark while
// building a request that has not been acknowledged yet.
function createLruMap<V>(cap: number) {
  const entries = new Map<string, V>()
  return {
    get: (key: string): V | undefined => entries.get(key),
    set(key: string, value: V): void {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

// The cache scope. The API key is HASHED here and nowhere held or logged raw —
// this string ends up as a Map key, not on the wire and not in a warning.
function cacheScope(baseUrl: string, apiKey?: string): string {
  return baseUrl + " " + sha256hex(apiKey ?? "")
}

// One flat cache keyed by scope AND snapshot, so the LRU bound is a true total
// and a scope flip simply misses instead of needing its own eviction policy.
// NUL is not producible by either component (a uuid and a hashed url+key).
function deliveredKey(scope: string, snapshotKey: string): string {
  return scope + "\u0000" + snapshotKey
}

// Phase 1 is ON by default (owner decision, 2026-08-26). Read per CALL, like the
// rest of the config: flipping it takes effect on the next search.
//
//   ancestors | (unset)  phase 1: an ancestor's context once per snapshot
//   history              phase 1 AND the history delta (phase 2) — still opt-in
//   off                  the pre-phase-1 wire, both halves — the kill switch
//
// On by default is safe because the mode is only HALF the gate. Omitting an
// ancestor context ALSO requires the server-capability probe: this exact
// (baseUrl, key) scope must already have answered with a `missing_snapshots`
// key, which only a backend carrying the guard emits. Against an old or
// third-party backend the probe never fires, so the plugin keeps sending full
// contexts — byte-identical to the pre-wave plugin — and the default can never
// strand a node whose context nobody stored. `off` short-circuits the mode half
// and remains the instant, no-deploy rollback lever the Telem backend's one-way-door checklist
// depends on.
//
// The two halves are gated differently ON PURPOSE, which is also why phase 2 did
// NOT ride this flip: the history delta asks nothing of the server (it is still
// `message_history`, just fewer entries), so nothing but this variable holds it
// back. It applies the moment "history" is set, and only then.
//
// An unrecognized value resolves to the DEFAULT, not to `off`: the rollback lever
// is the exact word `off` (after trim + lowercase) and nothing else, so an
// operator reaching for it should verify the value that landed, not the intent.
// TELEM_INCREMENTAL_FORCE is not a second mode — it is the differential
// harness's test-only bypass of the capability probe, never production.
function incrementalMode(): string {
  const raw = (process.env.TELEM_INCREMENTAL ?? "").trim().toLowerCase()
  return raw === "off" || raw === "history" ? raw : "ancestors"
}

// One ancestor entry this call chose not to send the context for. The `entry`
// is the very object inside `metadata.ancestors`, so restoring is a swap on the
// body that is about to be re-serialized — same node_key, same everything else.
type OmittedContext = { key: string; entry: Record<string, unknown>; context: HistoryMessage[] }

// Filled in by buildTrajectory: the scope this POST will use, plus — only once
// the ancestor list is final — the snapshot keys the request carries FULL
// context for. That is exactly the set a 2xx proves delivered. Bookkeeping that
// throws leaves the list empty, so a degraded call can never mark a delivery
// that never went out.
//
// Phase 2 rides on the same object: it is the one place a call's two
// unacknowledged promises live until the response either proves or discards them.
type DeliveryPlan = {
  scope: string
  sentWithContext: string[]
  // The other half of the same ledger: what this request WITHHELD. Kept whole —
  // key, the entry object as it rides in the body, and the context that was
  // materialized this call and merely not sent — because the guard's 409 asks
  // for exactly this back. Empty is also the gate: a 409 on a request
  // that omitted nothing is a plain error, never a retry.
  omitted: OmittedContext[]
  // Set when self's own `session.get` threw (or bookkeeping degraded wholesale).
  // The epoch is then a guess — rev is reported as "none" whatever the session
  // really did — and a delta computed against a guessed generation is exactly
  // the one loss this design forbids, so a degraded call sends the history in FULL.
  epochDegraded: boolean
  // What this call's history delta committed to. Published only once the delta
  // is final, for the same reason `sentWithContext` is: a call that never got
  // that far must not advance a baseline.
  history?: HistorySend
}

// ---------------------------------------------------------------------------
// The guard's refusal. When an omitted snapshot's row is
// missing, the backend refuses the whole request with HTTP 409 BEFORE any
// provider runs, before billing, before an interaction row exists — the Phase B
// transaction rolls back whole, so nothing of the request persisted. The client
// answers by restoring the withheld contexts and re-sending once.
// ---------------------------------------------------------------------------

const MISSING_SNAPSHOTS = "missing_snapshots"

// One POST, with the error body read HERE: the 409 discriminator and the text
// the tool error carries are the same bytes, and a Response body can only be
// consumed once.
async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: any,
): Promise<{ response: Response; detail: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  const detail = response.ok ? "" : await response.text().catch(() => "")
  return { response, detail }
}

// The typed code, from either envelope the two doors use: FastAPI's `detail` on
// /v1/interactions, the `{"error": {...}}` envelope on /v1/fetch. The
// bare top-level read is pure defense — a proxy that unwraps, a future door that
// does not wrap. Undefined means "this body names no code we can read", which
// includes a body that is not JSON at all.
function refusalCode(detail: string): string | undefined {
  let body: any
  try {
    body = JSON.parse(detail)
  } catch {
    return undefined
  }
  for (const shape of [body?.detail, body?.error, body]) {
    const code = shape && typeof shape === "object" ? shape.code : undefined
    if (typeof code === "string" && code) return code
  }
  return undefined
}

// Is this 409 the guard asking for the contexts back?
//
// Two judgement calls, both deliberate, because a defensive parse has to decide
// what an ambiguous body means:
//
//   - NO code readable (unparseable body, a proxy's plain-text 409, an envelope
//     shape we do not know) => TREAT IT AS THE REFUSAL. The retry is a standard
//     full request re-sending the same node_keys, so a wrong guess costs one
//     round trip; guessing the other way costs the user a failed tool call on
//     the one condition this whole path exists to heal.
//   - A code that is present and is NOT `missing_snapshots` => NOT the refusal.
//     The server named a different reason; restoring contexts cannot address it,
//     and re-POSTing a request it just refused for a stated reason is a blind
//     retry of a non-idempotent call. Surface it.
//
// And the gate above both: the request must have omitted something. A 409 on a
// request that withheld nothing is somebody else's error.
function isMissingSnapshotsRefusal(status: number, detail: string, plan: DeliveryPlan): boolean {
  if (status !== 409 || !plan.omitted.length) return false
  const code = refusalCode(detail)
  return code === undefined || code === MISSING_SNAPSHOTS
}

// ---------------------------------------------------------------------------
// Phase 2 — the exporter-parity history delta (spec 2026-08-24).
//
// Full transmission re-sends the whole accumulated conversation on every call.
// The delta is NOT "what's new" — that form died in review, because the
// snapshot's tail message mutates in place (markers go pending→running→
// completed, reasoning grows) and "new messages only" therefore sends nothing
// for calls 2 onward in a turn, losing the whole turn's reasoning. It is instead
// "whatever preserves the exporter's observable projections of the snapshot":
// the reasoning multiset that survives the goal cut, the user-turn ledger, the
// `[tool telem_search:` marker positions, and the first user message.
//
// Two invariants the four rules silently depend on:
//   - they operate on the FLATTENED list (what the exporter consumes), and
//   - the delta is an order-preserving SUBSEQUENCE of it: never an append,
//     never a re-order. R4's "boosters" are earlier entries retained in place.
// ---------------------------------------------------------------------------

// What `previous_search_index` cuts on, verbatim. A `telem_fetch` tail does NOT
// match it — which is why R3 pins the last message separately.
const SEARCH_MARKER = "[tool telem_search:"

// One watermark per opencode session per scope. A session's history is not
// large in count (messages, not bytes), but a long-lived opencode process sees
// many sessions; bounded like the phase-1 caches, and for the same reason —
// eviction costs one redundant FULL send, which is the safe direction.
const HISTORY_WATERMARK_CAP = 256

// The generation a watermark belongs to. `session_key` alone is not
// enough: it is not monotonic (an undone revert reproduces an old key) and it is
// best-effort (a failed `session.get` silently reports rev=none). The last
// flattened message id plus the count pin it down — a revert makes the list
// non-append-only, and that is visible as "the message I last saw at the end is
// no longer at or before where I left it".
type HistoryEpoch = { sessionKey: string; lastMsgId: string; msgCount: number }

// message id -> hash of the flattened (content, reasoning) LAST PROVEN SENT.
type HistoryWatermark = { epoch: HistoryEpoch; hashes: Map<string, string> }

// What one call promised to the baseline, held until the response decides.
type HistorySend = {
  sessionID: string
  epoch: HistoryEpoch
  sent: Array<{ id: string; hash: string }>
}

function historyKey(scope: string, sessionID: string): string {
  return scope + "\u0000" + sessionID
}

// The hash is over the CAPPED bytes — exactly what would go on the wire. That is
// what makes HISTORY_TEXT_CAP truncation parity-safe: a mutation the cap hides
// from this hash is hidden from the exporter by the same cap. NUL separates the
// two fields so a content/reasoning boundary can never be forged.
function historyHash(entry: HistoryMessage): string {
  return sha256hex(entry.content + "\u0000" + (entry.reasoning ?? ""))
}

// What one call selected, and the hashes that selection commits to.
type HistorySelection = { entries: HistoryMessage[]; sent: Array<{ id: string; hash: string }> }

// Everything, with its hash: the first call of a generation, and every call the
// epoch rules refuse to trust.
function fullHistorySend(flat: FlatMessage[]): HistorySelection {
  return {
    entries: flat.map((message) => message.entry),
    sent: flat.map((message) => ({ id: message.id, hash: historyHash(message.entry) })),
  }
}

// R1-R4 over one flattened snapshot, against the hashes proven delivered.
function historyDelta(flat: FlatMessage[], hashes: Map<string, string>): HistorySelection {
  const include = new Set<number>()
  // The reasoning strings carried by R1-selected entries — and ONLY those. An
  // entry pulled in by R2/R3 is not evidence that its thought is being
  // re-attributed, so it does not open the R4 gate.
  const boosters = new Set<string>()
  const hashOf: string[] = []
  for (let i = 0; i < flat.length; i++) {
    const { id, entry } = flat[i]
    const hash = historyHash(entry)
    hashOf.push(hash)
    if (hashes.get(id) !== hash) {
      // R1 — new (this id has never gone out) or changed (its bytes moved),
      // sent whole. The mutating tail is by construction always changed, which
      // is what closes the mutation-loss class.
      include.add(i)
      if (entry.reasoning) boosters.add(entry.reasoning)
    } else if (entry.role === "user") {
      // R2 — every user turn, always: the goal cut and the opening-turn ledger
      // read index AND content, and `user_goal` must be present in every payload.
      include.add(i)
    } else if (entry.role === "assistant" && entry.content.includes(SEARCH_MARKER)) {
      // R3 — every telem_search-marker-bearing message, so `previous_search_index`
      // cuts in the same place it would on the full snapshot.
      include.add(i)
    }
  }
  // R3's other half: the LAST flattened message, always. A `telem_fetch` tail
  // matches no SEARCH_MARKER, and a tail byte-identical to an already-acked
  // message (two unclaimed pending calls render the same) is invisible to R1 —
  // yet it is the message the exporter reads the current call out of.
  if (flat.length) include.add(flat.length - 1)
  // R4 — duplicate boosters: EVERY earlier occurrence of a reasoning string this
  // delta's R1 set carries, not just one. With a single booster the third
  // occurrence under-emits (exported=2, a delta carrying one prior occurrence
  // counts 2 and skips both, while full emits occurrence 3); with all of them,
  // the delta's occurrence counts equal the full snapshot's for every string it
  // carries, and strings it does not carry are untouched on both paths.
  for (let i = 0; i < flat.length; i++) {
    if (include.has(i)) continue
    const reasoning = flat[i].entry.reasoning
    if (reasoning && boosters.has(reasoning)) include.add(i)
  }
  const chosen = [...include].sort((a, b) => a - b) // subsequence, never a re-order
  return {
    entries: chosen.map((i) => flat[i].entry),
    sent: chosen.map((i) => ({ id: flat[i].id, hash: hashOf[i] })),
  }
}

// Is the current snapshot the same append-only continuation the watermark was
// built on? The remembered last message must still be there, at or before where
// it sat. Gone (a revert truncated it) or pushed later (the list is not the one
// we measured) both mean the baseline describes a list that no longer exists.
function continuesEpoch(previous: HistoryEpoch, flat: FlatMessage[]): boolean {
  const at = flat.findIndex((message) => message.id === previous.lastMsgId)
  return at >= 0 && at <= previous.msgCount - 1
}

// Trajectory v5 wire contract this plugin produces on every telem_search, on
// `body.metadata` alongside `message_history`:
//   session_key       uuid5 identity of self's context-window generation
//   fingerprint       sha256 stable per-session token
//   node_key          random uuid4 for THIS search node (minted once per call)
//   kind              "search"
//   goal?             optional per-node label (forwarded whenever supplied)
//   parent_node_key   the DIRECT parent's snapshot key, or null if it was omitted
//   ancestors[]       root-first { session_key, fingerprint, node_key(snapshot),
//                     parent_node_key, context } for every fully-materialised
//                     ancestor (both SDK reads succeeded)
// The plugin owns the session: it always sends session_key (the context window)
// and never threads a model session_id — a request carrying session_key is a v5
// request. Bookkeeping never throws out of execute — any failure degrades to a
// best-effort self key with no ancestors.
// opencode instantiates EVERY runtime export of a plugin file as a plugin
// factory: a second export is called with the plugin input and whatever it
// returns is used as the hooks object. `buildSearchBlock` returning null was
// exactly the "null is not an object (evaluating N.config)" crash that took
// opencode down on every message. THE FACTORY IS THE ONLY EXPORT — keep
// helpers module-private and test them through TelemPlugin.
//
// `options` is opencode's plugin-tuple options object (level 1 of the config
// ladder) — `plugin: [["@telemai/opencode-plugin", { "tier": "max" }]]` in
// opencode.json. It is captured here because that is where the host hands it
// over; it is therefore static for this instance, unlike the file layers.
export const TelemPlugin: Plugin = async ({ client, directory }, options?: PluginOptions) => {
  // Reasoning text of in-flight assistant messages, sessionID -> partID -> text,
  // reassembled from bus events because the DB row read by client.session.messages
  // only receives the text at reasoning-end — after the tool is already executing.
  const reasoningBySession = new Map<string, Map<string, string>>()

  // Phase-1 belief, PER PLUGIN INSTANCE (opencode can instantiate a plugin file
  // more than once, and one instance's proof says nothing about another's):
  // `delivered` holds (scope, snapshot) pairs whose context is proven landed,
  // `capability` the scopes whose backend implements the guard.
  const delivered = createLruSet(DELIVERED_CAP)
  const capability = createLruSet(CAPABILITY_CAP)

  // Phase-2 belief, same instance and same scoping: per (scope, opencode
  // session), the generation it belongs to and the bytes proven delivered per
  // message id. Concurrent executes SHARE this — they read it at build time and
  // write it only at response time, which is what makes two overlapping deltas
  // the intended behavior rather than a lost message.
  const historyWatermarks = createLruMap<HistoryWatermark>(HISTORY_WATERMARK_CAP)

  // Does THIS call omit context for snapshots already delivered to `scope`?
  // Production waits for the server's own capability signal; the differential
  // harness (and only it) forces the answer, its cache being correct by
  // construction.
  //
  // "history" carries phase 1 too, and under exactly the same gate: the
  // ancestor half needs the backend guard whatever else the mode also turns on.
  function omitsDeliveredContext(scope: string): boolean {
    const mode = incrementalMode()
    if (mode !== "ancestors" && mode !== "history") return false
    if (process.env.TELEM_INCREMENTAL_FORCE === "1") return true
    return capability.has(scope)
  }

  // The history this call sends, and the promise it records against the
  // baseline. Called AFTER the trajectory is built, because the epoch is keyed
  // on self's `session_key` — the very thing buildTrajectory computes, and the
  // very thing a failed `session.get` leaves as a guess.
  //
  // Reads shared state; never writes it. The baseline moves in recordDelivery,
  // on a response — advancing here would jump the watermark past a send that
  // can still fail, and a message dropped from a delta is dropped forever.
  function planHistory(
    delivery: DeliveryPlan,
    sessionID: string,
    selfSessionKey: unknown,
    flat: FlatMessage[],
    full: HistoryMessage[],
  ): HistoryMessage[] {
    if (incrementalMode() !== "history") return full
    const epoch: HistoryEpoch = {
      sessionKey: typeof selfSessionKey === "string" ? selfSessionKey : NONE,
      lastMsgId: flat.length ? flat[flat.length - 1].id : NONE,
      msgCount: flat.length,
    }
    const previous = historyWatermarks.get(historyKey(delivery.scope, sessionID))
    // Full send on: the first call of a generation, a session_key that moved
    // (compaction or revert opened a new context window), a list that is no
    // longer the append-only continuation of the one measured, and any call
    // whose epoch the plugin could not compute confidently.
    const continuous =
      previous !== undefined &&
      !delivery.epochDegraded &&
      previous.epoch.sessionKey === epoch.sessionKey &&
      continuesEpoch(previous.epoch, flat)
    const chosen = continuous ? historyDelta(flat, previous.hashes) : fullHistorySend(flat)
    delivery.history = { sessionID, epoch, sent: chosen.sent }
    return chosen.entries
  }

  // Called only after a response came back ok AND its body parsed. Never at send
  // time: a parallel sibling would otherwise omit on the strength of a request
  // that can still fail before the backend's Phase B commits — which is exactly
  // how a permanently context-less node is born.
  //
  // Marking runs even when the mode is off. Passive learning costs nothing, is
  // never acted on while off, and means flipping the mode on does not need a
  // warm-up call to re-earn what this instance already proved.
  function recordDelivery(delivery: DeliveryPlan, body: unknown): void {
    const scope = delivery.scope
    for (const key of delivery.sentWithContext) delivered.add(deliveredKey(scope, key))
    advanceHistory(delivery)
    if (!body || typeof body !== "object") return
    // KEY PRESENCE, never truthiness — the healthy value is `[]`. A
    // backend without the guard omits the key entirely and so never grants
    // capability, which is what keeps an omitting client off an old server.
    if (!("missing_snapshots" in (body as Record<string, unknown>))) return
    capability.add(scope)
    // Reported keys are nodes the backend REFUSED to create: un-mark them so the
    // next call carries their full context again.
    const missing = (body as Record<string, unknown>).missing_snapshots
    if (Array.isArray(missing)) {
      for (const key of missing) delivered.remove(deliveredKey(scope, String(key)))
    }
  }

  // Put every withheld context back into the body this call already built.
  //
  // Un-marking comes FIRST and is not conditional on the retry succeeding: the
  // 409 falsified this instance's belief that those rows exist, and a sibling
  // building its body right now must carry their contexts too. A retry that
  // then fails leaves them unmarked, which is the safe direction — one
  // redundant full re-send.
  //
  // The keys move to `sentWithContext`, so the retry's 2xx marks exactly what
  // the retry actually carried, through the same recordDelivery as any call.
  function restoreOmittedContexts(delivery: DeliveryPlan): void {
    for (const { key, entry, context } of delivery.omitted) {
      delivered.remove(deliveredKey(delivery.scope, key))
      delete entry.context_omitted
      entry.context = context
      delivery.sentWithContext.push(key)
    }
    delivery.omitted = []
  }

  // The POST, plus the single in-call retry the guard's 409 asks for.
  //
  // The retried body is the SAME body object — same node_keys, same
  // message_history, same search block — with `context_omitted` swapped back
  // for `context`. The history baseline cannot have moved in between: it only
  // advances in recordDelivery, which only a 2xx reaches, so the retry re-sends
  // this call's delta unchanged, which is right because the 409 persisted
  // nothing.
  //
  // `signal` is threaded through both attempts: an abort between them aborts
  // the retry, exactly as it would have aborted the first send.
  async function postWithOmissionRetry(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    delivery: DeliveryPlan,
    signal: any,
  ): Promise<{ response: Response; detail: string }> {
    const first = await postOnce(url, headers, body, signal)
    if (!isMissingSnapshotsRefusal(first.response.status, first.detail, delivery)) return first
    restoreOmittedContexts(delivery)
    // Exactly once. `omitted` is now empty, so a second 409 cannot re-enter this
    // branch even in principle — it is surfaced as the tool error like any
    // non-ok, which is the behaviour the guard asks for.
    return await postOnce(url, headers, body, signal)
  }

  // The history baseline, moved by a proven response and by nothing else.
  //
  // UNION, never assign. Every entry is a statement of fact — "message
  // X went out with these exact bytes" — so folding a second call's sends into a
  // first call's watermark is right even when the two overlap; that is the
  // intended degradation of two in-flight deltas. Assigning would instead let a
  // late-resolving call erase a sibling's acknowledged send, and a message
  // dropped from every delta is dropped from the export forever.
  //
  // The one case that REPLACES is a generation change: a compaction or revert
  // moved `session_key`, and the previous window's message ids are no longer a
  // list this session has. Keeping them would only grow the map.
  function advanceHistory(delivery: DeliveryPlan): void {
    const send = delivery.history
    if (!send) return
    const key = historyKey(delivery.scope, send.sessionID)
    const current = historyWatermarks.get(key)
    if (!current || current.epoch.sessionKey !== send.epoch.sessionKey) {
      const hashes = new Map<string, string>()
      for (const { id, hash } of send.sent) hashes.set(id, hash)
      historyWatermarks.set(key, { epoch: send.epoch, hashes })
      return
    }
    for (const { id, hash } of send.sent) current.hashes.set(id, hash)
    // Out-of-order 2xx can rewind the epoch to an earlier call's. That is safe:
    // the remembered last message is then found at or before where it sat, so
    // the next call still continues rather than resending everything.
    current.epoch = send.epoch
    historyWatermarks.set(key, current) // refresh recency on the write, not the read
  }

  // Escape hatch (read at plugin init): keep the builtin webfetch usable. Only
  // the webfetch denies are skipped — the telem_* grants are always injected.
  const allowBuiltinWebfetch = process.env.TELEM_ALLOW_BUILTIN_WEBFETCH === "1"

  // Materialise one ancestor: TWO independently-failable SDK reads. The
  // Session object carries parentID (the walk pointer) and revert (the placement
  // input); the messages carry the last compaction, the spawn (last assistant)
  // message id, and the context. An ancestor is included only if BOTH succeed.
  // `withheld` is set only on an entry that omitted: the context this call DID
  // materialize and chose not to send. It is what the guard's 409 asks back for
  // so it is kept rather than recomputed — a second walk could read a
  // session that moved underneath us and answer a different question.
  type Lineage = {
    materialized: boolean
    key?: string
    entry?: Record<string, unknown>
    withheld?: HistoryMessage[]
  }

  async function buildTrajectory(
    selfId: string,
    selfMsgs: any[],
    nodeKey: string,
    delivery: DeliveryPlan,
    kind: string = "search",
  ): Promise<Record<string, unknown>> {
    // One decision for the whole chain, taken against the SAME scope the POST
    // will use (the caller resolved the config first).
    const omitDelivered = omitsDeliveredContext(delivery.scope)
    const selfComp = lastCompactionId(selfMsgs)
    let selfSession: any
    try {
      selfSession = (await client.session.get({ path: { id: selfId } }))?.data
    } catch {
      // Can't read self's parentID/revert: still emit a best-effort self key
      // (rev=none) with no ancestors. Bookkeeping never fails a search.
      //
      // For phase 2 this is a DEGRADE, not a detail: the self key that follows
      // is computed from a guessed rev, so it is not the generation identity
      // this call could actually confirm — and a delta against an unconfirmed
      // generation is a silent loss. The history goes out whole instead.
      delivery.epochDegraded = true
    }
    const selfRev = selfSession?.revert?.messageID ?? NONE
    const traj: Record<string, unknown> = {
      session_key: sessionKey(selfId, selfComp, selfRev),
      fingerprint: fingerprint(selfId),
      node_key: nodeKey,
      kind,
      parent_node_key: null,
      ancestors: [],
    }

    // Walk self -> ... -> root, child-first as discovered. A well-formed opencode
    // graph is an acyclic tree (a parent predates its child), but the store is not
    // trusted: a `visited` set bounds the walk so a corrupted/imported parentID
    // cycle (a->b->a, or a self-parent) can never hang execute — a hang would
    // slip past the degradation try/catch (which only catches throws) and stall
    // the whole tool call uninterruptibly.
    const lineage: Lineage[] = []
    const visited = new Set<string>([selfId])
    let cur: string | undefined = selfSession?.parentID
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      let s: any
      try {
        s = (await client.session.get({ path: { id: cur } }))?.data
      } catch {
        // No parentID readable -> cannot continue the walk; stop here.
        lineage.push({ materialized: false })
        break
      }
      if (!s) {
        lineage.push({ materialized: false })
        break
      }
      let msgs: any
      try {
        msgs = (await client.session.messages({ path: { id: cur } })).data
      } catch {
        // Key/context unreadable -> omit this ancestor, but its parentID is known
        // (session.get succeeded) so the walk can continue past the hole.
        lineage.push({ materialized: false })
        cur = s.parentID
        continue
      }
      const comp = lastCompactionId(msgs ?? [])
      const rev = s.revert?.messageID ?? NONE
      const lastAsst = lastAssistantMessage(msgs ?? [])
      const snapKey = snapshotNodeKey(cur, lastAsst?.id ?? NONE)
      // The entry is unchanged on every key EXCEPT `context`: the
      // fingerprint still fills the session row per call, and the always-sent
      // edge set is what keeps v5 self-heal independent of client memory.
      // `context_omitted` is functional, not decorative — it is the server's
      // licence to skip the row rather than freeze a null into it.
      const omitContext = omitDelivered && delivered.has(deliveredKey(delivery.scope, snapKey))
      // Materialized on EVERY call, omitting or not. Withholding is a send-time
      // decision — it materialized them this call and merely withheld them at
      // send time — which is precisely what makes the retry a swap rather
      // than a second walk of a session that may have moved since.
      const context = flattenMessages(msgs ?? [])
      lineage.push({
        materialized: true,
        key: snapKey,
        withheld: omitContext ? context : undefined,
        entry: {
          session_key: sessionKey(cur, comp, rev),
          fingerprint: fingerprint(cur),
          node_key: snapKey,
          parent_node_key: null,
          ...(omitContext ? { context_omitted: true } : { context }),
          // When the spawn actually happened: the spawn message's own harness
          // timestamp. The backend row's created_at is only "when the first
          // descendant reported", which lands in the same transaction as that
          // descendant's search — this carries the true delegation moment.
          spawned_at: lastAsst?.timeMs != null ? new Date(lastAsst.timeMs).toISOString() : null,
        },
      })
      cur = s.parentID
    }
    lineage.reverse() // root-first

    const ancestors: Record<string, unknown>[] = []
    const sentWithContext: string[] = []
    const omitted: OmittedContext[] = []
    for (let i = 0; i < lineage.length; i++) {
      const m = lineage[i]
      if (!m.materialized || !m.entry) continue
      const prev = lineage[i - 1] // the shallower (closer to root) member = real parent
      // NULL across a hole; never skip up to a surviving grandparent.
      m.entry.parent_node_key = prev && prev.materialized ? prev.key : null
      ancestors.push(m.entry)
      // The two halves of the ledger, read off the entry that actually shipped:
      // what carried context, and what withheld it (with the context kept).
      if (!m.key) continue
      if ("context" in m.entry) sentWithContext.push(m.key)
      else if (m.withheld) omitted.push({ key: m.key, entry: m.entry, context: m.withheld })
    }
    // The search node's parent is the DIRECT parent's snapshot specifically. If
    // the direct parent was omitted, NULL — never float to a grandparent (a
    // single-writer search node can never self-heal a wrong non-null edge).
    const direct = lineage[lineage.length - 1]
    traj.parent_node_key = direct && direct.materialized ? direct.key : null
    traj.ancestors = ancestors
    // Published at the very end, deliberately: anything that throws above leaves
    // the plan empty and the call marks nothing — and, with `omitted` empty too,
    // a degraded call cannot take the retry path either.
    delivery.sentWithContext = sentWithContext
    delivery.omitted = omitted
    return traj
  }

  return {
    // Make telem_search usable by EVERY agent — including subagents. opencode's
    // built-in subagents (explore, general) ship a "*": "deny" permission
    // ruleset that whitelists only their built-in tools, which silently filters
    // our plugin tool out of their toolset: a main agent that delegates to a
    // subagent would lose telem_search entirely and fall back to raw webfetch.
    // Injecting the grant here means the customer installs the plugin and it
    // just works, with no manual permission config. Top-level covers the
    // default agent and any custom subagent; the per-agent grants override the
    // two built-ins' explicit deny. Existing user config is never clobbered
    // (only fills what is unset), so an explicit deny by the customer still wins.
    config: async (config: any) => {
      config.permission ??= {}
      config.permission.telem_search ??= "allow"
      config.permission.telem_fetch ??= "allow"
      // Agent fetch traffic must flow through the backend: deny the builtin
      // webfetch wherever telem_fetch is granted (top-level AND per-agent — a
      // top-level deny alone does not reach explore/general, whose "*": "deny"
      // ruleset whitelists their own builtins, webfetch included). Same
      // fill-only-unset stance: a user's explicit config always wins.
      if (!allowBuiltinWebfetch) config.permission.webfetch ??= "deny"
      config.agent ??= {}
      const injected: Record<string, string> = { telem_search: "allow", telem_fetch: "allow" }
      if (!allowBuiltinWebfetch) injected.webfetch = "deny"
      for (const name of ["explore", "general"]) {
        config.agent[name] ??= {}
        config.agent[name].permission = {
          ...injected,
          ...(config.agent[name].permission ?? {}),
        }
      }
    },
    event: async ({ event }: { event: any }) => {
      const properties = event?.properties
      if (event?.type === "message.part.updated") {
        const part = properties?.part
        if (
          part?.type !== "reasoning" ||
          typeof part.sessionID !== "string" ||
          typeof part.id !== "string"
        )
          return
        let parts = reasoningBySession.get(part.sessionID)
        if (!parts) reasoningBySession.set(part.sessionID, (parts = new Map()))
        const text = typeof part.text === "string" ? part.text.slice(0, HISTORY_TEXT_CAP) : ""
        const prev = parts.get(part.id)
        // An update carries the full text so far; never let a stale/empty one
        // (e.g. the reasoning-start write) clobber accumulated deltas.
        if (prev === undefined || text.length >= prev.length) parts.set(part.id, text)
      } else if (event?.type === "message.part.delta") {
        if (properties?.field !== "text" || typeof properties?.delta !== "string") return
        const parts = reasoningBySession.get(properties.sessionID)
        const prev = parts?.get(properties.partID)
        // Unknown part id => not a reasoning part (text parts stream deltas too).
        if (parts === undefined || prev === undefined) return
        if (prev.length < HISTORY_TEXT_CAP)
          parts.set(properties.partID, (prev + properties.delta).slice(0, HISTORY_TEXT_CAP))
      } else if (event?.type === "session.idle" || event?.type === "session.deleted") {
        // session.idle carries {sessionID}; session.deleted carries {info: Session}
        // (SDK EventSessionDeleted has no sessionID field) — accept either shape.
        const endedSession =
          typeof properties?.sessionID === "string"
            ? properties.sessionID
            : typeof properties?.info?.id === "string"
              ? properties.info.id
              : undefined
        if (endedSession) {
          // Once the turn ends the DB rows are complete and authoritative;
          // dropping the session's map also keeps memory flat across sessions.
          reasoningBySession.delete(endedSession)
        }
      }
    },
    tool: {
      telem_search: tool({
        description:
          "Primary tool for public-web search. When multiple web-search tools are available, " +
          "prefer `telem_search` for current information, research, fact-checking, " +
          "documentation, comparisons, and source discovery. A single-index search tool — " +
          "including a host's built-in web search — returns one provider's view of the web; one " +
          "`telem_search` call fans out across up to nine providers and returns their results " +
          "provider-attributed in one normalized envelope, so you do not need to choose a " +
          "provider-specific search tool or run the same query through several tools. Use " +
          "another search tool only when the user explicitly requests it, Telem is unavailable, " +
          "or a required capability is not exposed here. Do not search at all when the answer " +
          "is already in your weights and is not time-sensitive, when the data is private or " +
          "internal rather than on the public web, or when you already have the one URL you " +
          "need — reading a known URL is `telem_fetch`'s job. Put related queries for one " +
          "research step in `queries`; they run concurrently in one interaction. You do not " +
          "manage or thread any session id. `telem_search` returns snippets; use `telem_fetch` " +
          "for full pages.",
        args: {
          queries: tool.schema
            .array(tool.schema.string().describe("A single search query."))
            .min(1)
            .describe(
              "One or more queries to search for. Pass several to run them concurrently as a " +
                "single interaction when the current step needs several searches for the current " +
                "task; each result block is labelled with its query. Give each query a different " +
                "facet of the task and make it stand on its own: [\"obligations for " +
                "general-purpose AI models under the EU AI Act in 2026\", \"how the amended EU AI " +
                "Act timeline changed the original dates\"], not [\"EU AI Act GPAI 2026\", \"EU " +
                "AI Act GPAI deadline\"]. Send at most 5 queries in one call; the backend rejects " +
                "more than 32.",
            ),
          goal: tool.schema
            .string()
            .optional()
            .describe(
              "A short label naming what THIS search step is for — the current task it serves, " +
                "in a few words, not the user's whole request and not this query's keywords. The " +
                "plugin owns the session here, so this field only labels the step in the " +
                "trajectory: send it on every search where you know the task.",
            ),
        },
        async execute(args, ctx) {
          // Drop blank/whitespace-only queries so an all-empty batch is caught here
          // rather than opening a goal-less interaction the backend can only reject.
          const queries = (args.queries ?? [])
            .map((q) => (typeof q === "string" ? q.trim() : ""))
            .filter(Boolean)
          if (!queries.length) {
            throw new Error("telem_search requires at least one non-empty query in `queries`.")
          }

          // Resolved HERE, per call: a telem.json edit or a newly exported env
          // var takes effect on the next search, with no opencode restart. It
          // resolves BEFORE the trajectory is built because the
          // (baseUrl, key) scope decides which ancestor contexts may be omitted,
          // and that decision has to be taken against the very scope this POST
          // then uses — resolving afterwards could omit against one world what
          // was only ever delivered to another.
          const config = resolveTelemConfig(directory, options)
          const delivery: DeliveryPlan = {
            scope: cacheScope(config.baseUrl, config.apiKey),
            sentWithContext: [],
            omitted: [],
            epochDegraded: false,
          }

          // v5: the plugin owns the session. There is no model-threaded
          // session_id and no "session or goal required" gate — the computed
          // session_key (the context window) identifies the search, and the
          // ancestor chain carries lineage. goal is just an optional node label.
          const messages = await client.session.messages({ path: { id: ctx.sessionID } })
          // Flattened WITH the source message ids: the wire shape is unchanged
          // (`history` below is exactly what it always was), but the phase-2
          // delta needs identity, and the flattened shape carries none.
          const flat = flattenMessagesWithIds(messages.data ?? [], {
            streamedReasoning: reasoningBySession.get(ctx.sessionID),
            currentCall: { messageID: ctx.messageID, args, tool: "telem_search" },
          })
          const history = flat.map((message) => message.entry)

          // Trajectory v5 wire payload: the search node's own key set plus the
          // root-first ancestor chain. Minted ONCE per execute call and held
          // across this call's backend retries so a retry is an idempotent
          // re-send of the same node.
          const nodeKey = randomUUID()
          const metadata: Record<string, unknown> = { message_history: history }
          // Bookkeeping must NEVER fail a search: any error degrades to a
          // best-effort self key with no ancestors, never throws out of execute.
          try {
            Object.assign(
              metadata,
              await buildTrajectory(ctx.sessionID, messages.data ?? [], nodeKey, delivery),
            )
          } catch {
            metadata.session_key = sessionKey(ctx.sessionID, lastCompactionId(messages.data ?? []), NONE)
            metadata.fingerprint = fingerprint(ctx.sessionID)
            metadata.node_key = nodeKey
            metadata.kind = "search"
            metadata.parent_node_key = null
            metadata.ancestors = []
            delivery.epochDegraded = true
          }
          // Phase 2: with the epoch now known, `message_history`
          // becomes the delta. Re-assigning an existing key leaves it where it
          // was in the object, so the wire keeps its order; in every mode but
          // "history" this hands back the same array it was given.
          metadata.message_history = planHistory(
            delivery,
            ctx.sessionID,
            metadata.session_key,
            flat,
            history,
          )
          // goal is an optional best-effort label on this search node (first-wins
          // per node on the backend). Sent whenever the model supplies one.
          if (args.goal) metadata.goal = args.goal
          // A single query keeps the legacy dict user_input so single-query traces stay
          // byte-identical; multiple queries are sent as a batch list, which the backend
          // runs concurrently as ONE interaction, tagging every run with its batch_index.
          const userInput =
            queries.length === 1 ? { query: queries[0] } : queries.map((query) => ({ query }))
          const body: Record<string, unknown> = {
            user_input: userInput,
            postprocessor_names: [],
            metadata,
          }
          // V2: provider selection lives in `search.providers`. Naming a
          // definition-backed provider in `preprocessor_names` is a 400 ("use
          // search.providers"), so telem_search never sends that key at all.
          // The block itself rides only on deviation — absent means defaults.
          const search = buildSearchBlock(config)
          if (search) body.search = search

          const headers: Record<string, string> = { "Content-Type": "application/json" }
          if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

          // A single POST — the search is not idempotent (each run bills providers
          // and creates an interaction), so a thrown transient failure is surfaced
          // rather than silently re-run. node_key is nonetheless minted once per
          // call (above), so any retry added at a safe layer stays a node no-op.
          //
          // The ONE exception is the guard's `missing_snapshots` 409,
          // and it does not weaken that stance: it is a PRE-EXECUTION refusal —
          // nothing ran, nothing billed, nothing persisted — so the retry is
          // this call's only execution, carrying the same node_keys.
          const { response, detail } = await postWithOmissionRetry(
            `${config.baseUrl}/v1/interactions`,
            headers,
            body,
            delivery,
            ctx.abort,
          )
          if (!response.ok) {
            throw new Error(`Telem search failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
          }
          const interaction = await response.json()
          // Delivery is proven HERE: ok plus a body that parsed. A
          // json throw skips this line, which is the "parse failure marks
          // nothing" rule, and a non-ok already threw above.
          //
          // Deliberately BEFORE the envelope gate: a pre-V2 answer fails the
          // SEARCH for the model, but it was still a real 2xx interaction whose
          // trajectory write (Phase B, committed before the search runs) landed —
          // those ancestor contexts are in the database either way.
          recordDelivery(delivery, interaction)
          // Refuse a pre-V2 answer before rendering anything (see the gate).
          assertV2Envelope(interaction)
          const sessionId = interaction.session_id ? String(interaction.session_id) : undefined

          // The session line is part of the output so the model itself learns the id
          // and can thread it into follow-up searches for the same goal; metadata
          // additionally surfaces it in the opencode tool-call UI.
          const header = sessionId ? `Telem search session: ${sessionId}\n\n` : ""
          return {
            output: header + formatSearchResults(interaction),
            metadata: sessionId ? { telem_session_id: sessionId } : undefined,
          }
        },
      }),
      telem_fetch: tool({
        description:
          "Read the full text of web pages by URL. telem_search returns snippets and " +
          "never reads pages; this tool is how pages are read here. Up to 5 http(s) " +
          "URLs per call, fetched together as one batch; for more pages make several " +
          "calls.",
        args: {
          urls: tool.schema
            .array(tool.schema.string().describe("An absolute http(s) URL to read."))
            .min(1)
            .describe(
              "The http(s) URLs of the pages to read, at most 5 per call. Duplicates are " +
                "removed.",
            ),
        },
        async execute(args, ctx) {
          // Friendly pre-validation, before any I/O.
          const urls = validateFetchUrls(args.urls)

          // Config first, for the same reason as telem_search: the omission
          // scope must be the scope this POST uses. The search block is
          // never attached here, but the base url and key are shared — and they
          // are exactly what the scope is made of.
          const config = resolveTelemConfig(directory, options)
          const delivery: DeliveryPlan = {
            scope: cacheScope(config.baseUrl, config.apiKey),
            sentWithContext: [],
            omitted: [],
            epochDegraded: false,
          }

          // Same context capture as telem_search, with this call's own pending
          // telem_fetch part rendered from the live args.
          const messages = await client.session.messages({ path: { id: ctx.sessionID } })
          const flat = flattenMessagesWithIds(messages.data ?? [], {
            streamedReasoning: reasoningBySession.get(ctx.sessionID),
            currentCall: { messageID: ctx.messageID, args, tool: "telem_fetch" },
          })
          const history = flat.map((message) => message.entry)

          // The SAME v5 trajectory payload as telem_search — a fetch is just
          // another event node in the session — with kind "fetch" as the
          // declared intent (the backend derives authoritatively from the
          // request shape and 400s on contradiction). Same degrade stance:
          // bookkeeping never fails the fetch.
          const nodeKey = randomUUID()
          const metadata: Record<string, unknown> = { message_history: history }
          try {
            Object.assign(
              metadata,
              await buildTrajectory(ctx.sessionID, messages.data ?? [], nodeKey, delivery, "fetch"),
            )
          } catch {
            metadata.session_key = sessionKey(ctx.sessionID, lastCompactionId(messages.data ?? []), NONE)
            metadata.fingerprint = fingerprint(ctx.sessionID)
            metadata.node_key = nodeKey
            metadata.kind = "fetch"
            metadata.parent_node_key = null
            metadata.ancestors = []
            delivery.epochDegraded = true
          }
          // ONE history watermark for both tools, exactly as ancestor delivery is
          // one watermark: a fetch snapshot is the same conversation, and the
          // exporter reads both through the same projections.
          metadata.message_history = planHistory(
            delivery,
            ctx.sessionID,
            metadata.session_key,
            flat,
            history,
          )

          // /v1/fetch (endpoint-split spec): the body carries the top-level
          // `urls` list and the backend assembles the fetch pipeline itself. The
          // endpoint is extra="forbid", so no legacy user_input key. The search
          // config is never attached: those knobs select SEARCH providers, and a
          // `search` block here is rejected — only the base url and key are
          // shared. `metadata.kind` stays: the endpoint refuses a kind that
          // CONTRADICTS it, and "fetch" agrees.
          const body: Record<string, unknown> = {
            urls,
            metadata,
          }

          const headers: Record<string, string> = { "Content-Type": "application/json" }
          if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

          // Same single POST and the same single omission retry as telem_search
          // (ONE helper, both tools) — a fetch delivers its
          // ancestors through the very same handler and can be refused by the
          // very same guard, only through the `{"error": {...}}` envelope.
          const { response, detail } = await postWithOmissionRetry(
            `${config.baseUrl}/v1/fetch`,
            headers,
            body,
            delivery,
            ctx.abort,
          )
          if (!response.ok) {
            throw new Error(`Telem fetch failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
          }
          const interaction = await response.json()
          // ONE watermark for both tools: a fetch delivers ancestors
          // through the same handler, so a fetch 2xx is delivery proof for a
          // later search exactly as a search's is for a later fetch.
          recordDelivery(delivery, interaction)
          const sessionId = interaction.session_id ? String(interaction.session_id) : undefined
          return {
            output: formatFetchResults(interaction),
            metadata: sessionId ? { telem_session_id: sessionId } : undefined,
          }
        },
      }),
    },
  }
}
