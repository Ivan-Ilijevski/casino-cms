import type { Engine } from './osintEngines.js'
import {
  normalizeUrl,
  type AccountEntry,
  type Confidence,
  type EngineReport,
  type Finding,
  type ImageEntry,
  type ReportSource,
  type Severity,
  type SuggestibleTag,
  type Verdict
} from './osintPrompt.js'

export { normalizeUrl }

/**
 * Cross-checks what two engines found, without asking a third model to do it.
 *
 * A merge done by an LLM could quietly invent the agreement it was asked to
 * find. This is plain code: two findings are the same finding when they cite
 * the same page, or when they sit in the same category under near-identical
 * titles. A finding both engines reached independently is "corroborated"; one
 * only a single engine reported is shown as such, never hidden.
 *
 * The overall verdict is the more cautious of the two, and a disagreement
 * between the engines is surfaced rather than averaged away.
 */

export interface MergedFinding extends Finding {
  engines: Engine[]
  corroborated: boolean
}

export interface MergedTag {
  tag: SuggestibleTag
  rationale: string
  engines: Engine[]
}

export interface MergedAccount extends AccountEntry {
  engines: Engine[]
}

export interface MergedImage extends ImageEntry {
  engines: Engine[]
  corroborated: boolean
}

export interface MergedReport {
  engines: Engine[]
  verdict: Verdict
  verdicts: Partial<Record<Engine, Verdict>>
  disagreement: boolean
  summaries: Partial<Record<Engine, string>>
  findings: MergedFinding[]
  /** Absent on runs merged before profile search existed — read with `?? []`. */
  accounts: MergedAccount[]
  images: MergedImage[]
  suggested_tags: MergedTag[]
  limitations: Partial<Record<Engine, string>>
}

/** Higher = more cause for a human to look. insufficient_data outranks a clean no_match. */
const VERDICT_RANK: Record<Verdict, number> = {
  no_match: 0,
  insufficient_data: 1,
  possible_match: 2,
  likely_match: 3
}
const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 }
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

function sameFinding(a: Finding, b: Finding): boolean {
  const urls = new Set(a.sources.map((s) => normalizeUrl(s.url)))
  if (b.sources.some((s) => urls.has(normalizeUrl(s.url)))) return true
  return a.category === b.category && jaccard(tokens(a.title), tokens(b.title)) >= 0.6
}

function unionSources(a: ReportSource[], b: ReportSource[]): ReportSource[] {
  const seen = new Set(a.map((s) => normalizeUrl(s.url)))
  return [...a, ...b.filter((s) => !seen.has(normalizeUrl(s.url)))]
}

export function mergeReports(reports: Partial<Record<Engine, EngineReport>>): MergedReport | null {
  const entries = (Object.entries(reports) as Array<[Engine, EngineReport | undefined]>).filter(
    (e): e is [Engine, EngineReport] => e[1] !== undefined
  )
  if (entries.length === 0) return null

  const merged: MergedFinding[] = []
  const accounts = new Map<string, MergedAccount>()
  const images = new Map<string, MergedImage>()
  const tags = new Map<SuggestibleTag, MergedTag>()
  const verdicts: Partial<Record<Engine, Verdict>> = {}
  const summaries: Partial<Record<Engine, string>> = {}
  const limitations: Partial<Record<Engine, string>> = {}

  for (const [engine, report] of entries) {
    verdicts[engine] = report.verdict
    summaries[engine] = report.summary
    limitations[engine] = report.limitations

    for (const finding of report.findings) {
      // Only pair with a finding another engine made, and only once — two
      // findings from the SAME engine are two findings, however alike.
      const twin = merged.find((m) => !m.engines.includes(engine) && sameFinding(m, finding))
      if (twin) {
        twin.engines.push(engine)
        twin.corroborated = true
        twin.sources = unionSources(twin.sources, finding.sources)
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[twin.severity]) twin.severity = finding.severity
        if (CONFIDENCE_RANK[finding.match_confidence] > CONFIDENCE_RANK[twin.match_confidence]) {
          twin.match_confidence = finding.match_confidence
        }
      } else {
        merged.push({ ...finding, sources: [...finding.sources], engines: [engine], corroborated: false })
      }
    }

    for (const a of report.accounts ?? []) {
      const key = normalizeUrl(a.url)
      const existing = accounts.get(key)
      if (!existing) {
        accounts.set(key, { ...a, engines: [engine] })
      } else if (!existing.engines.includes(engine)) {
        existing.engines.push(engine)
        existing.handle ??= a.handle
        if (CONFIDENCE_RANK[a.match_confidence] > CONFIDENCE_RANK[existing.match_confidence]) {
          existing.match_confidence = a.match_confidence
        }
      }
    }

    for (const img of report.images ?? []) {
      const key = normalizeUrl(img.image_url ?? img.page_url)
      const existing = images.get(key)
      if (!existing) {
        images.set(key, { ...img, engines: [engine], corroborated: false })
      } else if (!existing.engines.includes(engine)) {
        existing.engines.push(engine)
        existing.corroborated = true
        existing.image_url ??= img.image_url
        if (CONFIDENCE_RANK[img.match_confidence] > CONFIDENCE_RANK[existing.match_confidence]) {
          existing.match_confidence = img.match_confidence
        }
      }
    }

    for (const t of report.suggested_tags) {
      const existing = tags.get(t.tag)
      if (existing) existing.engines.push(engine)
      else tags.set(t.tag, { tag: t.tag, rationale: t.rationale, engines: [engine] })
    }
  }

  merged.sort(
    (a, b) =>
      Number(b.corroborated) - Number(a.corroborated) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      CONFIDENCE_RANK[b.match_confidence] - CONFIDENCE_RANK[a.match_confidence]
  )

  const all = Object.values(verdicts) as Verdict[]
  const verdict = all.reduce((worst, v) => (VERDICT_RANK[v] > VERDICT_RANK[worst] ? v : worst))

  return {
    engines: entries.map(([e]) => e),
    verdict,
    verdicts,
    disagreement: new Set(all).size > 1,
    summaries,
    findings: merged,
    accounts: [...accounts.values()].sort(
      (a, b) => b.engines.length - a.engines.length || CONFIDENCE_RANK[b.match_confidence] - CONFIDENCE_RANK[a.match_confidence]
    ),
    images: [...images.values()].sort(
      (a, b) => Number(b.corroborated) - Number(a.corroborated) || CONFIDENCE_RANK[b.match_confidence] - CONFIDENCE_RANK[a.match_confidence]
    ),
    suggested_tags: [...tags.values()],
    limitations
  }
}
