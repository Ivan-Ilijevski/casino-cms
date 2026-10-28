import { describe, expect, test } from 'vitest'
import { mergeReports, normalizeUrl } from '../src/domain/osintMerge.js'
import type { EngineReport, Finding } from '../src/domain/osintPrompt.js'

function finding(over: Partial<Finding> = {}): Finding {
  return {
    category: 'adverse_media',
    title: 'Уапсен за измама со ДДВ',
    detail: '',
    severity: 'medium',
    match_confidence: 'medium',
    match_basis: 'Име и град',
    sources: [{ url: 'https://www.example.mk/vest/123', title: 'Вест', published: null }],
    ...over
  }
}

function report(over: Partial<EngineReport> = {}): EngineReport {
  return {
    verdict: 'possible_match',
    summary: 'резиме',
    findings: [],
    accounts: [],
    images: [],
    suggested_tags: [],
    searches_performed: [],
    limitations: '',
    ...over
  }
}

test('normalizeUrl ignores scheme, www, trailing slash and tracking params', () => {
  expect(normalizeUrl('https://www.example.mk/vest/123/?utm_source=x&fbclid=y')).toBe(
    normalizeUrl('http://example.mk/vest/123')
  )
  expect(normalizeUrl('https://example.mk/a?id=1')).not.toBe(normalizeUrl('https://example.mk/a?id=2'))
})

describe('mergeReports', () => {
  test('a finding both engines cite from the same page is corroborated once', () => {
    const merged = mergeReports({
      claude: report({ findings: [finding({ severity: 'low' })] }),
      codex: report({
        findings: [
          finding({
            title: 'Completely different wording',
            severity: 'high',
            sources: [
              { url: 'http://example.mk/vest/123/', title: 'Вест', published: null },
              { url: 'https://other.mk/x', title: 'Друга', published: '2025-01-01' }
            ]
          })
        ]
      })
    })!

    expect(merged.findings).toHaveLength(1)
    expect(merged.findings[0]).toMatchObject({ engines: ['claude', 'codex'], corroborated: true, severity: 'high' })
    // The duplicate link is folded; the extra one is kept.
    expect(merged.findings[0]!.sources.map((s) => s.url)).toEqual([
      'https://www.example.mk/vest/123',
      'https://other.mk/x'
    ])
  })

  test('near-identical titles in one category pair up without a shared link', () => {
    const merged = mergeReports({
      claude: report({ findings: [finding({ title: 'Уапсен за измама со ДДВ во Скопје' })] }),
      codex: report({
        findings: [finding({ title: 'Уапсен за измама со ДДВ', sources: [{ url: 'https://b.mk/1', title: 'b', published: null }] })]
      })
    })!
    expect(merged.findings).toHaveLength(1)
    expect(merged.findings[0]!.corroborated).toBe(true)
  })

  test('single-engine findings stay, marked uncorroborated and listed after corroborated ones', () => {
    const merged = mergeReports({
      claude: report({
        findings: [
          finding({ title: 'Само Claude', category: 'business', severity: 'high', sources: [{ url: 'https://a.mk/solo', title: 'a', published: null }] }),
          finding()
        ]
      }),
      codex: report({ findings: [finding()] })
    })!
    expect(merged.findings.map((f) => [f.title, f.engines, f.corroborated])).toEqual([
      ['Уапсен за измама со ДДВ', ['claude', 'codex'], true],
      ['Само Claude', ['claude'], false]
    ])
  })

  test('two alike findings from ONE engine are not merged into each other', () => {
    const merged = mergeReports({ claude: report({ findings: [finding(), finding()] }) })!
    expect(merged.findings).toHaveLength(2)
    expect(merged.findings.every((f) => !f.corroborated)).toBe(true)
  })

  test('takes the more cautious verdict and flags the disagreement', () => {
    const merged = mergeReports({
      claude: report({ verdict: 'no_match' }),
      codex: report({ verdict: 'likely_match' })
    })!
    expect(merged.verdict).toBe('likely_match')
    expect(merged.disagreement).toBe(true)
    expect(merged.verdicts).toEqual({ claude: 'no_match', codex: 'likely_match' })

    const agreed = mergeReports({ claude: report({ verdict: 'no_match' }), codex: report({ verdict: 'no_match' }) })!
    expect(agreed.disagreement).toBe(false)
    expect(mergeReports({ claude: report({ verdict: 'no_match' }), codex: report({ verdict: 'insufficient_data' }) })!.verdict).toBe(
      'insufficient_data'
    )
  })

  test('unions suggested tags and records which engine proposed each', () => {
    const merged = mergeReports({
      claude: report({ suggested_tags: [{ tag: 'pep', rationale: 'пратеник' }] }),
      codex: report({ suggested_tags: [{ tag: 'pep', rationale: 'MP' }, { tag: 'watchlist', rationale: 'медиуми' }] })
    })!
    expect(merged.suggested_tags).toEqual([
      { tag: 'pep', rationale: 'пратеник', engines: ['claude', 'codex'] },
      { tag: 'watchlist', rationale: 'медиуми', engines: ['codex'] }
    ])
  })

  test('nothing to merge when every engine failed', () => {
    expect(mergeReports({})).toBeNull()
  })
})
