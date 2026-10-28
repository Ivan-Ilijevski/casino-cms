import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import {
  claudeArgs,
  codexArgs,
  createCliOsintRunner,
  parseClaudeLine,
  parseCodexLine,
  runProcess
} from '../src/domain/osintEngines.js'
import { buildPrompt, REPORT_SCHEMA, sanitizeReport } from '../src/domain/osintPrompt.js'
import { buildSubject, disclosedFields } from '../src/domain/osintSubject.js'

const REPORT = {
  verdict: 'possible_match',
  summary: 'Можен погодок.',
  findings: [
    {
      category: 'pep',
      title: 'Советник во општина',
      detail: 'детали',
      severity: 'medium',
      match_confidence: 'medium',
      match_basis: 'Име и град',
      sources: [{ url: 'https://example.mk/a', title: 'Општина', published: null }]
    }
  ],
  suggested_tags: [{ tag: 'pep', rationale: 'јавна функција' }],
  searches_performed: ['"Иван Илијевски" Скопје'],
  limitations: ''
}

describe('argument builders', () => {
  test('claude gets web tools only, no host customisations, structured output', () => {
    const args = claudeArgs(DEFAULT_CONFIG, 'PROMPT')
    const after = (flag: string) => args[args.indexOf(flag) + 1]

    expect(args.slice(0, 2)).toEqual(['-p', 'PROMPT'])
    expect(args).toContain('--safe-mode')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(after('--tools')).toBe('WebSearch,WebFetch')
    expect(after('--allowedTools')).toBe('WebSearch,WebFetch')
    expect(after('--output-format')).toBe('stream-json')
    expect(JSON.parse(after('--json-schema')!)).toEqual(REPORT_SCHEMA)
    expect(args.join(' ')).not.toMatch(/Bash|dangerously|bypassPermissions/)
  })

  test('codex has its shell disabled, not just sandboxed, and ignores host config', () => {
    const args = codexArgs({ ...DEFAULT_CONFIG, osintCodexModel: 'gpt-x' }, 'PROMPT', {
      cwd: '/tmp/x',
      schema: '/tmp/x/schema.json',
      out: '/tmp/x/report.json'
    })
    const joined = args.join(' ')

    expect(args[0]).toBe('exec')
    expect(args.at(-1)).toBe('PROMPT')
    expect(joined).toContain('--sandbox read-only')
    expect(joined).toContain('--disable shell_tool')
    expect(joined).toContain('--disable unified_exec')
    expect(joined).toContain('--ignore-user-config')
    expect(joined).toContain('--ephemeral')
    expect(joined).toContain('-c web_search="live"')
    expect(joined).toContain('--model gpt-x')
    expect(joined).not.toMatch(/dangerously|workspace-write|full-access/)
  })

  test('the schema is OpenAI-strict: every object closed, every property required', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false)
        expect(Object.keys(n.properties as object).sort()).toEqual([...(n.required as string[])].sort())
      }
      Object.values(n).forEach(walk)
    }
    walk(REPORT_SCHEMA)
  })
})

describe('stream parsers', () => {
  const steps = (events: Array<{ kind: string; activity?: { kind: string; text: string } }>) =>
    events.map((e) => (e.kind === 'activity' ? [e.activity!.kind, e.activity!.text] : e))

  // Trimmed from real `claude -p --output-format stream-json --verbose` output.
  test('claude: every step becomes an activity; the result carries the structured output', () => {
    const lines = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-5"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"Иван Илијевски Скопје"}}]}}',
      '{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"Web search results"}]},"tool_use_result":{"query":"Иван Илијевски Скопје","results":[{"tool_use_id":"s1","content":[{"title":"Прв","url":"https://a.mk"},{"title":"Втор","url":"https://b.mk"}]}],"searchCount":1}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"WebFetch","input":{"url":"https://example.mk/a","prompt":"x"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result"}]},"tool_use_result":{"bytes":154054,"code":200,"codeText":"OK","result":"...","durationMs":3302,"url":"https://www.example.mk/a"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Ќе проверам уште еден извор."}]}}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"StructuredOutput","input":{}}]}}`,
      `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.42,"structured_output":${JSON.stringify(REPORT)}}`,
      'not json at all'
    ]
    expect(steps(lines.flatMap(parseClaudeLine))).toEqual([
      ['start', 'модел claude-sonnet-5'],
      ['search', 'Иван Илијевски Скопје'],
      ['results', '2 резултати: Прв · Втор'],
      ['open', 'https://example.mk/a'],
      ['fetched', '200 OK · 150 KB · example.mk'],
      ['note', 'Ќе проверам уште еден извор.'],
      ['done', 'го составува извештајот'],
      { kind: 'result', ok: true, output: REPORT, costUsd: 0.42, error: null }
    ])
  })

  test('claude: a budget stop is a failed result', () => {
    const [ev] = parseClaudeLine('{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":2.01}')
    expect(ev).toMatchObject({ kind: 'result', ok: false, error: 'claude: error_max_budget_usd' })
  })

  // Trimmed from real `codex exec --json` output.
  test('codex: single, batched and page actions all become activities; started items do not', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Ќе ги проверам варијантите на името.\\n"}}',
      '{"type":"item.started","item":{"id":"item_1","type":"web_search","query":"","action":{"type":"other"}}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"web_search","query":"Ivan Ilijevski","action":{"type":"search","query":"Ivan Ilijevski"}}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"web_search","action":{"type":"open_page","url":"https://example.mk/a"}}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"web_search","action":{"type":"find_in_page","url":"https://example.mk/a","pattern":"Илијевски"}}}',
      '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"{\\"verdict\\":\\"no_match\\"}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":155440,"output_tokens":2202}}',
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}'
    ]
    expect(steps(lines.flatMap(parseCodexLine))).toEqual([
      ['note', 'Ќе ги проверам варијантите на името.'],
      ['search', 'Ivan Ilijevski'],
      ['open', 'https://example.mk/a'],
      ['find', '„Илијевски“ во https://example.mk/a'],
      ['done', 'го составува извештајот'],
      ['done', 'токени: влез 155440, излез 2202'],
      { kind: 'error', message: 'codex: usage limit reached' }
    ])
  })

  // Regression: Codex batches several queries into one call as `action.queries`.
  // Only `action.query` was read, so every real Codex run showed 0 searches and
  // its live panel looked frozen while it was working normally.
  test('codex: a batched search yields one activity per query', () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"web_search","id":"exec-d642dc83","query":"\\"Јана Ѓорѓевиќ\\" ...","action":{"type":"search","queries":["\\"Јана Ѓорѓевиќ\\"","\\"Jana Gjorgjevikj\\"","\\"Jana Đorđević\\"","\\"Jana Gorgevik\\""]}}}'
    expect(steps(parseCodexLine(line))).toEqual([
      ['search', '"Јана Ѓорѓевиќ"'],
      ['search', '"Jana Gjorgjevikj"'],
      ['search', '"Jana Đorđević"'],
      ['search', '"Jana Gorgevik"']
    ])
  })
})

describe('sanitizeReport', () => {
  test('drops findings with no retrievable source and says so', () => {
    const out = sanitizeReport({
      ...REPORT,
      findings: [
        REPORT.findings[0],
        { ...REPORT.findings[0], title: 'Без извор', sources: [] },
        { ...REPORT.findings[0], title: 'Лош линк', sources: [{ url: 'javascript:alert(1)', title: 'x', published: null }] }
      ]
    })!
    expect(out.findings.map((f) => f.title)).toEqual(['Советник во општина'])
    expect(out.limitations).toContain('2 наод(и) без проверлив извор се отфрлени')
  })

  test('a match verdict with no surviving evidence falls back to insufficient_data', () => {
    const out = sanitizeReport({ ...REPORT, verdict: 'likely_match', findings: [{ ...REPORT.findings[0], sources: [] }] })!
    expect(out.verdict).toBe('insufficient_data')
  })

  test('refuses tags outside the suggestible set and anything that is not a report', () => {
    const out = sanitizeReport({
      ...REPORT,
      suggested_tags: [{ tag: 'self_excluded', rationale: 'x' }, { tag: 'vip', rationale: 'x' }, { tag: 'watchlist', rationale: 'y' }]
    })!
    expect(out.suggested_tags).toEqual([{ tag: 'watchlist', rationale: 'y' }])
    expect(sanitizeReport(null)).toBeNull()
    expect(sanitizeReport({ verdict: 'guilty' })).toBeNull()
  })
})

describe('subject', () => {
  const player = {
    name: 'Иван Илијевски',
    city: 'Скопје',
    dob: '1990-05-01',
    phone: '+38970000000',
    email: '',
    doc_id: 'A1234567'
  }

  test('never carries the document number, into the prompt or anywhere else', () => {
    const subject = buildSubject(player)
    expect(JSON.stringify(subject)).not.toContain('A1234567')
    expect(buildPrompt(subject, 'aml')).not.toContain('A1234567')
    expect(disclosedFields(subject)).toEqual(['name', 'city', 'dob', 'phone'])
  })

  test('the prompt searches every spelling and states the purpose', () => {
    const prompt = buildPrompt(buildSubject(player), 'aml', new Date('2026-09-16T10:00:00Z'))
    expect(prompt).toContain('"Иван Илијевски", "Ivan Ilijevski"')
    expect(prompt).toContain('Today is 2026-09-16')
    expect(prompt).toContain('AML')
    expect(prompt).toMatch(/untrusted data/)
  })
})

describe('process runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cms-osint-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function fakeBin(name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!${process.execPath}\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('a hung engine is killed at the timeout', async () => {
    const started = Date.now()
    const outcome = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 200,
      onLine: () => {}
    })
    expect(outcome.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test('aborting stops the child and reports it as cancelled', async () => {
    const ac = new AbortController()
    const bin = fakeBin('hang-claude', 'setInterval(() => {}, 1000)')
    const runner = createCliOsintRunner({ ...DEFAULT_CONFIG, osintClaudeBin: bin })
    setTimeout(() => ac.abort(), 100)
    await expect(runner.run('claude', 'p', { signal: ac.signal })).resolves.toEqual({
      ok: false,
      error: 'cancelled',
      queries: []
    })
  })

  test('claude end to end against a fake CLI: queries stream out, the report is sanitised', async () => {
    const bin = fakeBin(
      'fake-claude',
      `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'WebSearch',input:{query:'q1'}}]}}))
       console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.1,structured_output:${JSON.stringify(REPORT)}}))`
    )
    const seen: string[] = []
    const runner = createCliOsintRunner({ ...DEFAULT_CONFIG, osintClaudeBin: bin })
    const result = await runner.run('claude', 'p', {
      signal: new AbortController().signal,
      onActivity: (a) => seen.push(`${a.kind}:${a.text}`)
    })

    expect(seen).toEqual([expect.stringMatching(/^start:claude стартуван/), 'search:q1'])
    expect(result).toMatchObject({ ok: true, costUsd: 0.1, queries: ['q1'] })
    expect(result.ok && result.report.findings).toHaveLength(1)
  })

  test('codex end to end against a fake CLI: the answer is read from --output-last-message', async () => {
    const bin = fakeBin(
      'fake-codex',
      `const fs = require('node:fs')
       const args = process.argv.slice(2)
       const out = args[args.indexOf('--output-last-message') + 1]
       if (!fs.existsSync(args[args.indexOf('--output-schema') + 1])) process.exit(3)
       console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'search',query:'q2'}}}))
       fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(REPORT))})`
    )
    const runner = createCliOsintRunner({ ...DEFAULT_CONFIG, osintCodexBin: bin })
    const result = await runner.run('codex', 'p', { signal: new AbortController().signal })

    expect(result).toMatchObject({ ok: true, costUsd: null, queries: ['q2'] })
  })

  test('an engine that dies without answering fails with its stderr', async () => {
    const bin = fakeBin('dead-codex', `console.error('Not logged in'); process.exit(1)`)
    const runner = createCliOsintRunner({ ...DEFAULT_CONFIG, osintCodexBin: bin })
    const result = await runner.run('codex', 'p', { signal: new AbortController().signal })
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain('Not logged in')
  })

  test('availability: an empty or missing binary is unavailable', () => {
    const runner = createCliOsintRunner({
      ...DEFAULT_CONFIG,
      osintClaudeBin: '',
      osintCodexBin: join(dir, 'does-not-exist')
    })
    expect(runner.available()).toEqual({ claude: false, codex: false })
  })
})
