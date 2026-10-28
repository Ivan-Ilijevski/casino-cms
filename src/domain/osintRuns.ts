import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { ENGINES, type Activity, type ActivityEvent, type Engine, type EngineRunResult } from './osintEngines.js'
import type { MergedReport } from './osintMerge.js'
import type { Confidence, EngineReport, OsintReason, Verdict } from './osintPrompt.js'
import type { OsintSubject } from './osintSubject.js'

/** Storage for AI screening runs. See migration 015_osint_runs. */

export const ENGINE_CHOICES = ['claude', 'codex', 'both'] as const
export type EngineChoice = (typeof ENGINE_CHOICES)[number]
export type RunStatus = 'running' | 'done' | 'failed'

export function isEngineChoice(v: unknown): v is EngineChoice {
  return typeof v === 'string' && (ENGINE_CHOICES as readonly string[]).includes(v)
}

export function enginesFor(choice: EngineChoice): Engine[] {
  return choice === 'both' ? [...ENGINES] : [choice]
}

interface RunRow {
  id: string
  player_id: string
  actor: string
  reason: OsintReason
  engines: EngineChoice
  status: RunStatus
  subject: string
  merged: string | null
  created_at: string
  finished_at: string | null
}

interface ResultRow {
  run_id: string
  engine: Engine
  status: RunStatus
  report: string | null
  queries: string
  activity: string
  cost_usd: number | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface EngineResultView {
  engine: Engine
  status: RunStatus
  report: EngineReport | null
  queries: string[]
  activity: Activity[]
  cost_usd: number | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface OsintRunView {
  id: string
  player_id: string
  actor: string
  reason: OsintReason
  engines: EngineChoice
  status: RunStatus
  subject: OsintSubject
  merged: MergedReport | null
  created_at: string
  finished_at: string | null
  results: EngineResultView[]
  images: OsintImageView[]
}

export interface OsintRunSummary {
  id: string
  actor: string
  reason: OsintReason
  engines: EngineChoice
  status: RunStatus
  verdict: Verdict | null
  findings: number | null
  created_at: string
  finished_at: string | null
}

const json = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function createRun(
  db: Db,
  input: { playerId: string; actor: string; reason: OsintReason; engines: EngineChoice; subject: OsintSubject }
): string {
  const id = randomUUID()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO osint_runs (id, player_id, actor, reason, engines, subject)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.playerId, input.actor, input.reason, input.engines, JSON.stringify(input.subject))
    const insert = db.prepare('INSERT INTO osint_engine_results (run_id, engine) VALUES (?, ?)')
    for (const engine of enginesFor(input.engines)) insert.run(id, engine)
  })()
  return id
}

/** Appended as they happen so the UI can show the searches while the run is still going. */
export function recordQuery(db: Db, runId: string, engine: Engine, query: string): void {
  db.prepare(
    `UPDATE osint_engine_results
        SET queries = json_insert(queries, '$[#]', ?)
      WHERE run_id = ? AND engine = ? AND status = 'running' AND json_array_length(queries) < 200`
  ).run(query.slice(0, 500), runId, engine)
}

const ACTIVITY_CAP = 400

/**
 * One step of the live log. Past the cap the oldest entries are not kept —
 * a runaway engine should not grow a row without bound — but `done` and
 * `error` always land, so the end of a run is never the part that is lost.
 */
export function recordActivity(db: Db, runId: string, engine: Engine, activity: ActivityEvent, now = Date.now()): void {
  const entry = JSON.stringify({ t: now, kind: activity.kind, text: activity.text.slice(0, 400) })
  const always = activity.kind === 'done' || activity.kind === 'error'
  db.prepare(
    `UPDATE osint_engine_results
        SET activity = json_insert(activity, '$[#]', json(?))
      WHERE run_id = ? AND engine = ? AND status = 'running'
        AND (? OR json_array_length(activity) < ?)`
  ).run(entry, runId, engine, always ? 1 : 0, ACTIVITY_CAP)
}

export function setEngineResult(db: Db, runId: string, engine: Engine, result: EngineRunResult): void {
  db.prepare(
    `UPDATE osint_engine_results
        SET status = ?, report = ?, queries = ?, cost_usd = ?, error = ?, finished_at = datetime('now')
      WHERE run_id = ? AND engine = ?`
  ).run(
    result.ok ? 'done' : 'failed',
    result.ok ? JSON.stringify(result.report) : null,
    JSON.stringify(result.queries.slice(0, 200)),
    result.ok ? result.costUsd : null,
    result.ok ? null : result.error.slice(0, 1000),
    runId,
    engine
  )
}

export function finishRun(db: Db, runId: string, merged: MergedReport | null): void {
  db.prepare(
    `UPDATE osint_runs SET status = ?, merged = ?, finished_at = datetime('now')
      WHERE id = ? AND status = 'running'`
  ).run(merged ? 'done' : 'failed', merged ? JSON.stringify(merged) : null, runId)
}

export function getRun(db: Db, runId: string): OsintRunView | undefined {
  const row = db.prepare('SELECT * FROM osint_runs WHERE id = ?').get(runId) as RunRow | undefined
  if (!row) return undefined
  const results = db
    .prepare('SELECT * FROM osint_engine_results WHERE run_id = ? ORDER BY engine')
    .all(runId) as ResultRow[]
  return {
    ...row,
    subject: json<OsintSubject>(row.subject, { name: '', variants: [], city: null, dob: null, phone: null, email: null }),
    merged: json<MergedReport | null>(row.merged, null),
    results: results.map((r) => ({
      engine: r.engine,
      status: r.status,
      report: json<EngineReport | null>(r.report, null),
      queries: json<string[]>(r.queries, []),
      activity: json<Activity[]>(r.activity, []),
      cost_usd: r.cost_usd,
      error: r.error,
      started_at: r.started_at,
      finished_at: r.finished_at
    })),
    images: listImages(db, runId)
  }
}

export function listRuns(db: Db, playerId: string, limit = 50): OsintRunSummary[] {
  return db
    .prepare(
      `SELECT id, actor, reason, engines, status,
              json_extract(merged, '$.verdict') AS verdict,
              json_array_length(merged, '$.findings') AS findings,
              created_at, finished_at
         FROM osint_runs
        WHERE player_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(playerId, limit) as OsintRunSummary[]
}

export function deleteRun(db: Db, runId: string): boolean {
  return db.prepare('DELETE FROM osint_runs WHERE id = ?').run(runId).changes > 0
}

export function runningRunFor(db: Db, playerId: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM osint_runs WHERE player_id = ? AND status = 'running' LIMIT 1")
    .get(playerId) as { id: string } | undefined
  return row?.id
}

export function countRunning(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM osint_runs WHERE status = 'running'").get() as { n: number }).n
}

/**
 * A run lives in this process's memory. After a restart nothing is driving a
 * row still marked running, so it would spin in the UI forever and block the
 * guest's next run — mark it failed at boot instead.
 */
export function failInterruptedRuns(db: Db): number {
  return db.transaction(() => {
    db.prepare(
      `UPDATE osint_engine_results SET status = 'failed', error = 'interrupted', finished_at = datetime('now')
        WHERE status = 'running'`
    ).run()
    return db
      .prepare("UPDATE osint_runs SET status = 'failed', finished_at = datetime('now') WHERE status = 'running'")
      .run().changes
  })()
}

export interface LookupHistory {
  count: number
  last_at: string
  last_actor: string
  last_reason: string | null
}

/** Per link-launcher source: how often it was opened for this guest, and the latest time by whom. */
export function lookupHistory(db: Db, playerId: string): Record<string, LookupHistory> {
  const rows = db
    .prepare(
      `SELECT g.source, g.count, l.created_at AS last_at, l.actor AS last_actor,
              json_extract(l.details, '$.reason') AS last_reason
         FROM (SELECT json_extract(details, '$.source') AS source, COUNT(*) AS count, MAX(id) AS last_id
                 FROM audit_log
                WHERE action = 'osint.lookup' AND entity_type = 'player' AND entity_id = ?
                GROUP BY 1) g
         JOIN audit_log l ON l.id = g.last_id
        WHERE g.source IS NOT NULL`
    )
    .all(playerId) as Array<LookupHistory & { source: string }>
  return Object.fromEntries(rows.map(({ source, ...rest }) => [source, rest]))
}

// ---------------------------------------------------------------------------
// Profile photos (migration 016_osint_profile)

export const FACE_VERDICTS = ['match', 'possible', 'different', 'no_face'] as const
export type FaceVerdict = (typeof FACE_VERDICTS)[number]

export interface OsintImageView {
  id: number
  origin: 'report' | 'account'
  image_url: string | null
  page_url: string
  description: string | null
  match_confidence: Confidence
  engines: Engine[]
  status: 'stored' | 'failed'
  content_type: string | null
  error: string | null
  face_verdict: FaceVerdict | null
  face_distance: number | null
  faces: number | null
  face_checked_at: string | null
  created_at: string
}

export function insertImage(
  db: Db,
  runId: string,
  img: {
    origin: 'report' | 'account'
    image_url: string | null
    page_url: string
    description: string
    match_confidence: Confidence
    engines: Engine[]
    status: 'stored' | 'failed'
    content_type?: string
    bytes?: Buffer
    sha256?: string
    error?: string
  }
): void {
  db.prepare(
    `INSERT INTO osint_images
       (run_id, origin, image_url, page_url, description, match_confidence, engines, status, content_type, bytes, sha256, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    img.origin,
    img.image_url,
    img.page_url,
    img.description,
    img.match_confidence,
    JSON.stringify(img.engines),
    img.status,
    img.content_type ?? null,
    img.bytes ?? null,
    img.sha256 ?? null,
    img.error ?? null
  )
}

/** Metadata only — the bytes are served one at a time by getImageBytes. */
export function listImages(db: Db, runId: string): OsintImageView[] {
  const rows = db
    .prepare(
      `SELECT id, origin, image_url, page_url, description, match_confidence, engines, status, content_type, error,
              face_verdict, face_distance, faces, face_checked_at, created_at
         FROM osint_images WHERE run_id = ? ORDER BY id`
    )
    .all(runId) as Array<Omit<OsintImageView, 'engines'> & { engines: string }>
  return rows.map((r) => ({ ...r, engines: json<Engine[]>(r.engines, []) }))
}

export function getImageBytes(db: Db, runId: string, imageId: number): { content_type: string; bytes: Buffer } | undefined {
  return db
    .prepare(
      `SELECT content_type, bytes FROM osint_images
        WHERE run_id = ? AND id = ? AND status = 'stored' AND bytes IS NOT NULL`
    )
    .get(runId, imageId) as { content_type: string; bytes: Buffer } | undefined
}

export function deleteImage(db: Db, runId: string, imageId: number): { page_url: string } | undefined {
  const row = db.prepare('SELECT page_url FROM osint_images WHERE run_id = ? AND id = ?').get(runId, imageId) as
    | { page_url: string }
    | undefined
  if (!row) return undefined
  db.prepare('DELETE FROM osint_images WHERE run_id = ? AND id = ?').run(runId, imageId)
  return row
}

export function deleteImagesByFace(db: Db, runId: string, verdict: FaceVerdict): number {
  return db.prepare('DELETE FROM osint_images WHERE run_id = ? AND face_verdict = ?').run(runId, verdict).changes
}

export interface FaceResult {
  imageId: number
  verdict: FaceVerdict
  distance: number | null
  faces: number
}

/** Only stored images of this run are touched; anything else in the batch is ignored. */
export function setFaceResults(db: Db, runId: string, results: FaceResult[]): number {
  const update = db.prepare(
    `UPDATE osint_images
        SET face_verdict = ?, face_distance = ?, faces = ?, face_checked_at = datetime('now')
      WHERE run_id = ? AND id = ? AND status = 'stored'`
  )
  return db.transaction(() =>
    results.reduce((n, r) => n + update.run(r.verdict, r.distance, r.faces, runId, r.imageId).changes, 0)
  )()
}

// ---------------------------------------------------------------------------
// The guest's reference photo

export interface PlayerPhotoMeta {
  sha256: string
  consent_by: string
  consent_at: string
}

export function playerPhotoMeta(db: Db, playerId: string): PlayerPhotoMeta | null {
  return (
    (db
      .prepare('SELECT sha256, consent_by, consent_at FROM player_photos WHERE player_id = ?')
      .get(playerId) as PlayerPhotoMeta | undefined) ?? null
  )
}

export function getPlayerPhoto(db: Db, playerId: string): { content_type: string; bytes: Buffer } | undefined {
  return db.prepare('SELECT content_type, bytes FROM player_photos WHERE player_id = ?').get(playerId) as
    | { content_type: string; bytes: Buffer }
    | undefined
}

/** Replacing the photo re-records consent: the consent was given for a photo, and this is a new one. */
export function setPlayerPhoto(
  db: Db,
  playerId: string,
  photo: { content_type: string; bytes: Buffer; sha256: string; consent_by: string }
): void {
  db.prepare(
    `INSERT INTO player_photos (player_id, content_type, bytes, sha256, consent_by, consent_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(player_id) DO UPDATE SET
       content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256,
       consent_by = excluded.consent_by, consent_at = excluded.consent_at`
  ).run(playerId, photo.content_type, photo.bytes, photo.sha256, photo.consent_by)
}

export function deletePlayerPhoto(db: Db, playerId: string): boolean {
  return db.prepare('DELETE FROM player_photos WHERE player_id = ?').run(playerId).changes > 0
}
