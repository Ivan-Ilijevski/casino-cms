import type { Db } from '../db/index.js'
import type { Engine, EngineRunResult, OsintRunner } from './osintEngines.js'
import { collectImages } from './osintImages.js'
import { mergeReports } from './osintMerge.js'
import type { EngineReport } from './osintPrompt.js'
import { finishRun, recordActivity, recordQuery, setEngineResult } from './osintRuns.js'

/**
 * Drives screening runs in the background: every chosen engine in parallel,
 * each result written the moment it lands, then the cross-check.
 *
 * One instance per staff app. The AbortControllers are what let DELETE stop a
 * run that is still searching — deleting only the rows would leave two CLIs
 * burning budget on a report nobody will ever see.
 */
export class OsintScreenings {
  private active = new Map<string, AbortController>()

  constructor(
    private db: Db,
    private runner: OsintRunner
  ) {}

  /** Resolves when the run is finished. Never rejects: the route does not await it. */
  start(
    runId: string,
    engines: Engine[],
    prompt: string,
    opts: { timeoutMs?: number; maxUsd?: number; collectImages?: boolean } = {}
  ): Promise<void> {
    const controller = new AbortController()
    this.active.set(runId, controller)

    const one = async (engine: Engine): Promise<[Engine, EngineRunResult]> => {
      const result = await this.runner
        .run(engine, prompt, {
          signal: controller.signal,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
          onActivity: (a) =>
            this.safely(() => {
              recordActivity(this.db, runId, engine, a)
              if (a.kind === 'search' || a.kind === 'open') recordQuery(this.db, runId, engine, a.text)
            })
        })
        .catch((err: unknown): EngineRunResult => ({ ok: false, error: String(err), queries: [] }))
      this.safely(() => setEngineResult(this.db, runId, engine, result))
      return [engine, result]
    }

    return Promise.all(engines.map(one))
      .then(async (results) => {
        const reports: Partial<Record<Engine, EngineReport>> = {}
        for (const [engine, r] of results) if (r.ok) reports[engine] = r.report
        const merged = mergeReports(reports)
        // Photos are fetched while the run still reads as running, so the report
        // never opens with a gallery that is about to change under it.
        if (merged && opts.collectImages && !controller.signal.aborted) {
          await collectImages(this.db, runId, merged, controller.signal).catch((err: unknown) =>
            console.error('[osint] image collection failed:', err)
          )
        }
        if (!controller.signal.aborted) this.safely(() => finishRun(this.db, runId, merged))
      })
      .catch((err: unknown) => console.error('[osint] run failed:', err))
      .finally(() => this.active.delete(runId))
  }

  cancel(runId: string): boolean {
    const controller = this.active.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** A write against a run that was deleted mid-flight updates nothing; anything else is logged, not thrown. */
  private safely(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.error('[osint] failed to record run progress:', err)
    }
  }
}
