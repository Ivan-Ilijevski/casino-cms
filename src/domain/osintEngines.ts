import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config.js'
import { REPORT_SCHEMA, sanitizeReport, type EngineReport } from './osintPrompt.js'

/**
 * Runs an AI screening through the `claude` and `codex` CLIs installed on this
 * host, headless, on the host's own login.
 *
 * The engines read arbitrary web pages, and a web page can carry instructions
 * aimed at whatever model reads it. So each run is boxed in before it starts,
 * not trusted to behave:
 *   - Claude gets exactly WebSearch and WebFetch (plus the structured-output
 *     tool the CLI adds itself). No Bash, no file tools. --safe-mode drops the
 *     host's hooks, plugins, skills and CLAUDE.md; --strict-mcp-config drops MCP.
 *   - Codex runs with its shell and exec tools DISABLED, not merely sandboxed:
 *     a read-only sandbox still lets a shell read ~/.ssh. --ignore-user-config
 *     drops the host's plugins/MCP while keeping its login.
 *   - Both run in an empty temp directory that is deleted afterwards, with no
 *     stdin, no shell interpolation of arguments, and a hard timeout.
 *
 * The CLI flags were checked against claude 2.1 and codex-cli 0.153.
 */

export const ENGINES = ['claude', 'codex'] as const
export type Engine = (typeof ENGINES)[number]

export type EngineRunResult =
  | { ok: true; report: EngineReport; queries: string[]; costUsd: number | null }
  | { ok: false; error: string; queries: string[] }

export interface RunOptions {
  signal: AbortSignal
  /** Every step the engine takes, as it happens — see the stream parsers. */
  onActivity?: (activity: ActivityEvent) => void
  /** Override the configured screening limits, e.g. for a profile run. */
  timeoutMs?: number
  maxUsd?: number
}

export interface OsintRunner {
  available(): Record<Engine, boolean>
  run(engine: Engine, prompt: string, opts: RunOptions): Promise<EngineRunResult>
}

type EngineConfig = Pick<
  Config,
  'osintClaudeBin' | 'osintCodexBin' | 'osintClaudeModel' | 'osintCodexModel' | 'osintTimeoutMs' | 'osintClaudeMaxUsd'
>

// ---------------------------------------------------------------------------
// Argument builders

export function claudeArgs(config: EngineConfig, prompt: string, maxUsd = config.osintClaudeMaxUsd): string[] {
  return [
    '-p',
    prompt,
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    'WebSearch,WebFetch',
    '--allowedTools',
    'WebSearch,WebFetch',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    ...(config.osintClaudeModel ? ['--model', config.osintClaudeModel] : []),
    '--max-budget-usd',
    String(maxUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(REPORT_SCHEMA)
  ]
}

export function codexArgs(
  config: EngineConfig,
  prompt: string,
  paths: { cwd: string; schema: string; out: string }
): string[] {
  return [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '-c',
    'web_search="live"',
    ...[
      'shell_tool',
      'unified_exec',
      'apps',
      'browser_use',
      'computer_use',
      'image_generation',
      'in_app_browser'
    ].flatMap((f) => ['--disable', f]),
    ...(config.osintCodexModel ? ['--model', config.osintCodexModel] : []),
    '--json',
    '--output-schema',
    paths.schema,
    '--output-last-message',
    paths.out,
    '--cd',
    paths.cwd,
    prompt
  ]
}

// ---------------------------------------------------------------------------
// Stream parsers — one line of the CLI's JSONL output at a time
//
// Each line becomes zero or more ACTIVITY entries: what the engine is doing, in
// words an admin can follow while it runs. Searches and page opens double as
// the run's query list.

export const ACTIVITY_KINDS = ['start', 'search', 'open', 'find', 'results', 'fetched', 'note', 'done', 'error'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export interface ActivityEvent {
  kind: ActivityKind
  text: string
}

/** As stored: `t` is epoch milliseconds. */
export interface Activity extends ActivityEvent {
  t: number
}

export type ClaudeEvent =
  | { kind: 'activity'; activity: ActivityEvent }
  | { kind: 'result'; ok: boolean; output: unknown; costUsd: number | null; error: string | null }

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const v = JSON.parse(trimmed)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const act = (kind: ActivityKind, text: string): { kind: 'activity'; activity: ActivityEvent } => ({
  kind: 'activity',
  activity: { kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 400) }
})

/** The final answer arrives as JSON; narrating it would dump the whole report into the log. */
const looksLikeJson = (text: string) => /^\s*[{[]/.test(text)

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** `claude -p --output-format stream-json --verbose`. */
export function parseClaudeLine(line: string): ClaudeEvent[] {
  const ev = parseLine(line)
  if (!ev) return []

  if (ev.type === 'system' && ev.subtype === 'init') {
    return typeof ev.model === 'string' ? [act('start', `модел ${ev.model}`)] : []
  }

  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return []
    const out: ClaudeEvent[] = []
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim() && !looksLikeJson(c.text)) {
        out.push(act('note', c.text))
      }
      if (c.type !== 'tool_use') continue
      const input = (c.input ?? {}) as Record<string, unknown>
      if (c.name === 'WebSearch' && typeof input.query === 'string') out.push(act('search', input.query))
      if (c.name === 'WebFetch' && typeof input.url === 'string') out.push(act('open', input.url))
      if (c.name === 'StructuredOutput') out.push(act('done', 'го составува извештајот'))
    }
    return out
  }

  // Tool results carry a structured summary alongside the text the model reads.
  if (ev.type === 'user') {
    const r = ev.tool_use_result
    if (!r || typeof r !== 'object' || Array.isArray(r)) return []
    const result = r as Record<string, unknown>
    if (Array.isArray(result.results)) {
      const links = (result.results as Array<{ content?: unknown }>).flatMap((x) =>
        Array.isArray(x?.content) ? (x.content as Array<{ title?: unknown }>) : []
      )
      const titles = links
        .map((l) => (typeof l.title === 'string' ? l.title : ''))
        .filter(Boolean)
        .slice(0, 3)
      return [act('results', `${links.length} резултати${titles.length ? `: ${titles.join(' · ')}` : ''}`)]
    }
    if (typeof result.url === 'string' && (typeof result.code === 'number' || typeof result.code === 'string')) {
      const kb = typeof result.bytes === 'number' ? ` · ${Math.round(result.bytes / 1024)} KB` : ''
      return [act('fetched', `${result.code} ${String(result.codeText ?? '')}${kb} · ${host(result.url)}`)]
    }
    return []
  }

  if (ev.type === 'result') {
    const ok = ev.subtype === 'success' && ev.is_error !== true
    const cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null
    return [
      {
        kind: 'result',
        ok,
        output: ev.structured_output ?? null,
        costUsd: cost,
        error: ok ? null : `claude: ${String(ev.subtype ?? 'error')}${typeof ev.result === 'string' && ev.result ? ` — ${ev.result.slice(0, 300)}` : ''}`
      }
    ]
  }
  return []
}

export type CodexEvent = { kind: 'activity'; activity: ActivityEvent } | { kind: 'error'; message: string }

/**
 * `codex exec --json`. The final answer is read from --output-last-message, not the stream.
 *
 * A web_search item's action has several shapes: `search` with a single `query`
 * OR a batch in `queries` (Codex fans several queries into one call), plus
 * `open_page` and `find_in_page`. Reading only `query` silently lost every
 * batched search.
 */
export function parseCodexLine(line: string): CodexEvent[] {
  const ev = parseLine(line)
  if (!ev) return []

  if (ev.type === 'item.completed') {
    const item = (ev.item ?? {}) as Record<string, unknown>

    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      return [looksLikeJson(item.text) ? act('done', 'го составува извештајот') : act('note', item.text)]
    }

    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? (item.summary as Array<{ text?: unknown }>).map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ')
        : typeof item.text === 'string'
          ? item.text
          : ''
      return summary.trim() ? [act('note', summary)] : []
    }

    if (item.type !== 'web_search') return []
    const action = (item.action ?? {}) as Record<string, unknown>
    const queries = Array.isArray(action.queries)
      ? (action.queries as unknown[]).filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      : []
    if (queries.length > 0) return queries.map((q) => act('search', q))
    if (typeof action.query === 'string' && action.query) return [act('search', action.query)]
    if (action.type === 'open_page' && typeof action.url === 'string' && action.url) return [act('open', action.url)]
    if (action.type === 'find_in_page' && typeof action.url === 'string') {
      const pattern = typeof action.pattern === 'string' ? `„${action.pattern}“ во ` : ''
      return [act('find', `${pattern}${action.url}`)]
    }
    if (typeof action.url === 'string' && action.url) return [act('open', action.url)]
    if (typeof item.query === 'string' && item.query) return [act('search', item.query)]
    return []
  }

  if (ev.type === 'turn.completed') {
    const usage = (ev.usage ?? {}) as Record<string, unknown>
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    return [act('done', `токени: влез ${n('input_tokens')}, излез ${n('output_tokens')}`)]
  }

  if (ev.type === 'error' || ev.type === 'turn.failed') {
    const err = ev.error as { message?: unknown } | undefined
    const message = typeof ev.message === 'string' ? ev.message : typeof err?.message === 'string' ? err.message : ev.type
    return [{ kind: 'error', message: `codex: ${message}` }]
  }
  return []
}

/** Searches and opened pages, in order — the run's query list. */
function asQuery(a: ActivityEvent): string | null {
  return a.kind === 'search' || a.kind === 'open' ? a.text : null
}

// ---------------------------------------------------------------------------
// Process

export interface ProcessOutcome {
  code: number | null
  stderrTail: string
  timedOut: boolean
  aborted: boolean
}

/**
 * spawn with no shell, no stdin, stdout split into lines. On timeout or abort
 * the child gets SIGTERM and, if it is still there five seconds later, SIGKILL.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; timeoutMs: number; onLine: (line: string) => void }
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let timedOut = false
    let aborted = false
    let stderr = ''
    let buffer = ''
    let killTimer: NodeJS.Timeout | undefined

    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    const onAbort = () => {
      aborted = true
      stop()
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        opts.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })

    const finish = (code: number | null) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal.removeEventListener('abort', onAbort)
      if (buffer) opts.onLine(buffer)
      resolve({ code, stderrTail: stderr.trim().slice(-600), timedOut, aborted })
    }
    child.on('error', (err) => {
      stderr += String(err.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

function failure(outcome: ProcessOutcome, fallback: string): string {
  if (outcome.aborted) return 'cancelled'
  if (outcome.timedOut) return 'timeout'
  return outcome.stderrTail ? `${fallback}: ${outcome.stderrTail}` : fallback
}

// ---------------------------------------------------------------------------

export function createCliOsintRunner(config: EngineConfig): OsintRunner {
  const bins: Record<Engine, string> = { claude: config.osintClaudeBin, codex: config.osintCodexBin }

  // `--version` is cheap but not free; the answer is cached for a minute so
  // opening a guest tab does not fork two processes every time.
  let cached: { at: number; value: Record<Engine, boolean> } | null = null
  const probe = (bin: string): boolean =>
    bin !== '' && spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0

  async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'cms-osint-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function runClaude(prompt: string, opts: Required<RunOptions>): Promise<EngineRunResult> {
    const { signal, onActivity } = opts
    const queries: string[] = []
    let result: Extract<ClaudeEvent, { kind: 'result' }> | null = null
    onActivity({
      kind: 'start',
      text: `claude стартуван · лимит ${Math.round(opts.timeoutMs / 60000)} мин, $${opts.maxUsd}`
    })

    const outcome = await inTempDir((cwd) =>
      runProcess(bins.claude, claudeArgs(config, prompt, opts.maxUsd), {
        cwd,
        signal,
        timeoutMs: opts.timeoutMs,
        onLine: (line) => {
          for (const ev of parseClaudeLine(line)) {
            if (ev.kind === 'activity') {
              const q = asQuery(ev.activity)
              if (q) queries.push(q)
              onActivity(ev.activity)
            } else {
              result = ev
            }
          }
        }
      })
    )

    const final = result as Extract<ClaudeEvent, { kind: 'result' }> | null
    if (outcome.aborted || outcome.timedOut || !final) {
      return { ok: false, error: failure(outcome, `claude exited with code ${outcome.code}`), queries }
    }
    if (!final.ok) return { ok: false, error: final.error ?? 'claude: error', queries }
    const report = sanitizeReport(final.output)
    if (!report) return { ok: false, error: 'claude: answer did not match the report schema', queries }
    return { ok: true, report, queries, costUsd: final.costUsd }
  }

  async function runCodex(prompt: string, opts: Required<RunOptions>): Promise<EngineRunResult> {
    const { signal, onActivity } = opts
    const queries: string[] = []
    let streamError: string | null = null
    onActivity({
      kind: 'start',
      text: `codex стартуван${config.osintCodexModel ? ` · модел ${config.osintCodexModel}` : ''} · лимит ${Math.round(opts.timeoutMs / 60000)} мин`
    })

    return inTempDir(async (cwd) => {
      const schema = join(cwd, 'schema.json')
      const out = join(cwd, 'report.json')
      await writeFile(schema, JSON.stringify(REPORT_SCHEMA))

      const outcome = await runProcess(bins.codex, codexArgs(config, prompt, { cwd, schema, out }), {
        cwd,
        signal,
        timeoutMs: opts.timeoutMs,
        onLine: (line) => {
          for (const ev of parseCodexLine(line)) {
            if (ev.kind === 'activity') {
              const q = asQuery(ev.activity)
              if (q) queries.push(q)
              onActivity(ev.activity)
            } else {
              streamError = ev.message
              onActivity({ kind: 'error', text: ev.message })
            }
          }
        }
      })

      if (outcome.aborted || outcome.timedOut) return { ok: false, error: failure(outcome, 'codex'), queries }

      const text = await readFile(out, 'utf8').catch(() => '')
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      const report = sanitizeReport(parsed)
      if (!report) {
        const why = streamError ?? failure(outcome, `codex exited with code ${outcome.code}`)
        return { ok: false, error: text ? `codex: answer did not match the report schema` : why, queries }
      }
      return { ok: true, report, queries, costUsd: null }
    })
  }

  return {
    available() {
      if (!cached || Date.now() - cached.at > 60_000) {
        cached = { at: Date.now(), value: { claude: probe(bins.claude), codex: probe(bins.codex) } }
      }
      return cached.value
    },
    async run(engine, prompt, opts) {
      const full: Required<RunOptions> = {
        signal: opts.signal,
        onActivity: opts.onActivity ?? (() => {}),
        timeoutMs: opts.timeoutMs ?? config.osintTimeoutMs,
        maxUsd: opts.maxUsd ?? config.osintClaudeMaxUsd
      }
      try {
        return engine === 'claude' ? await runClaude(prompt, full) : await runCodex(prompt, full)
      } catch (err) {
        return { ok: false, error: `${engine}: ${(err as Error).message}`, queries: [] }
      }
    }
  }
}
