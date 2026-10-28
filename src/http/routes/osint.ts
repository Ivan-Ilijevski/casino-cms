import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import express, { Router, type Response } from 'express'
import { audit } from '../../domain/audit.js'
import { addTag, getPlayer, tagsFor } from '../../domain/customers.js'
import type { Engine } from '../../domain/osintEngines.js'
import { IMAGE_MAX_BYTES, sniffImage } from '../../domain/osintImages.js'
import { buildPrompt, isOsintReason, OSINT_REASONS, SUGGESTIBLE_TAGS } from '../../domain/osintPrompt.js'
import {
  countRunning,
  createRun,
  deleteImage,
  deleteImagesByFace,
  deletePlayerPhoto,
  deleteRun,
  enginesFor,
  ENGINE_CHOICES,
  FACE_VERDICTS,
  getImageBytes,
  getPlayerPhoto,
  getRun,
  isEngineChoice,
  listRuns,
  lookupHistory,
  playerPhotoMeta,
  runningRunFor,
  setFaceResults,
  setPlayerPhoto,
  type FaceResult
} from '../../domain/osintRuns.js'
import { OsintScreenings } from '../../domain/osintScreening.js'
import { buildSubject, disclosedFields } from '../../domain/osintSubject.js'
import { param, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

/**
 * Public-source research on a guest, for KYC/AML due diligence. Admins only.
 *
 * Two very different things share this tab:
 *
 *   Link lookups — the browser opens a public site itself. The server fetches
 *   nothing; it only records who opened which source, on whom and why. The
 *   client navigates only after that write succeeds, so there is no unlogged path.
 *
 *   AI screening — the server runs the Claude and/or Codex CLI, which search the
 *   web about the guest and return a cited report. That DOES disclose guest
 *   details to Anthropic/OpenAI (never the document number — see
 *   osintSubject.ts) and DOES store the result, so it is audited when started and
 *   when deleted, and nothing it suggests takes effect without an admin's click.
 */

/** Two CLIs each, fanning out web searches — more than this at once is a runaway, not due diligence. */
const MAX_CONCURRENT_RUNS = 2

const NO_ENGINES: Record<Engine, boolean> = { claude: false, codex: false }

/**
 * Every image this router serves came from somewhere untrusted — a web page, or
 * an upload. The type is the one sniffed from the bytes at storage time, and the
 * headers stop a browser from re-interpreting it as anything else.
 */
function sendImage(res: Response, contentType: string, bytes: Buffer, cache: string): void {
  res.set({
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': cache
  })
  res.send(bytes)
}

/**
 * face-api's model weights, served from the installed package. An allowlist, not
 * a directory: the package also ships age/gender and expression models, and
 * those inferences are exactly what this feature must not be able to make.
 */
const FACE_MODEL_FILES = new Set(
  ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model'].flatMap((m) => [
    `${m}.bin`,
    `${m}-weights_manifest.json`
  ])
)

function faceModelDir(): string | null {
  try {
    const dir = join(dirname(createRequire(import.meta.url).resolve('@vladmandic/face-api/package.json')), 'model')
    return existsSync(dir) ? dir : null
  } catch {
    return null
  }
}

/** Only these reference-photo types; GIF is fine for a found photo, not for an ID-style portrait. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function osintRouter(deps: StaffDeps): Router {
  const router = Router()
  const screenings = deps.osint ? new OsintScreenings(deps.db, deps.osint) : null
  const available = (): Record<Engine, boolean> => deps.osint?.available() ?? NO_ENGINES

  router.post('/customers/:id/osint-lookup', requireRole('admin'), (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const { source, reason } = req.body ?? {}
    if (typeof source !== 'string' || source.trim() === '') {
      res.status(400).json({ error: 'source is required' })
      return
    }
    if (!isOsintReason(reason)) {
      res.status(400).json({ error: `reason must be one of ${OSINT_REASONS.join(', ')}` })
      return
    }
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.lookup',
      entityType: 'player',
      entityId: player.id,
      details: { source: source.trim().slice(0, 64), reason }
    })
    res.json({ ok: true })
  })

  /** Everything the tab needs in one read: name spellings, engines, link history, past runs. */
  router.get('/customers/:id/osint', requireRole('admin'), (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const subject = buildSubject(player)
    res.json({
      variants: subject.variants,
      disclosed: disclosedFields(subject),
      engines: available(),
      lookups: lookupHistory(deps.db, player.id),
      runs: listRuns(deps.db, player.id),
      photo: playerPhotoMeta(deps.db, player.id)
    })
  })

  router.post('/customers/:id/osint-runs', requireRole('admin'), (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const { reason, engines } = req.body ?? {}
    if (!isOsintReason(reason)) {
      res.status(400).json({ error: `reason must be one of ${OSINT_REASONS.join(', ')}` })
      return
    }
    if (!isEngineChoice(engines)) {
      res.status(400).json({ error: `engines must be one of ${ENGINE_CHOICES.join(', ')}` })
      return
    }
    const wanted = enginesFor(engines)
    const up = available()
    const missing = wanted.filter((e) => !up[e])
    if (!screenings || missing.length > 0) {
      res.status(503).json({ error: `engine not available: ${(missing.length ? missing : wanted).join(', ')}`, code: 'engine_unavailable' })
      return
    }
    const running = runningRunFor(deps.db, player.id)
    if (running) {
      res.status(409).json({ error: 'a screening is already running for this guest', code: 'already_running', runId: running })
      return
    }
    if (countRunning(deps.db) >= MAX_CONCURRENT_RUNS) {
      res.status(429).json({ error: 'too many screenings running — try again when one finishes', code: 'busy' })
      return
    }

    const subject = buildSubject(player)
    const profile = reason === 'profile'
    const runId = createRun(deps.db, { playerId: player.id, actor: req.staff!.username, reason, engines, subject })
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.ai_run',
      entityType: 'player',
      entityId: player.id,
      details: { runId, reason, engines, fields: disclosedFields(subject), ...(profile ? { images: true } : {}) }
    })
    void screenings.start(
      runId,
      wanted,
      buildPrompt(subject, reason),
      profile
        ? {
            timeoutMs: deps.config.osintProfileTimeoutMs,
            maxUsd: deps.config.osintProfileClaudeMaxUsd,
            collectImages: true
          }
        : {}
    )
    res.status(202).json({ run: getRun(deps.db, runId) })
  })

  router.get('/customers/:id/osint-runs/:runId', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    if (!run || run.player_id !== param(req, 'id')) {
      res.status(404).json({ error: 'no such screening' })
      return
    }
    res.json(run)
  })

  /**
   * Deletes the report outright — findings, sources, searches. A run that is
   * still going is stopped first. The audit trail keeps that a run happened and
   * was deleted, and deliberately does NOT keep a copy of what it found.
   */
  router.delete('/customers/:id/osint-runs/:runId', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    if (!run || run.player_id !== param(req, 'id')) {
      res.status(404).json({ error: 'no such screening' })
      return
    }
    screenings?.cancel(run.id)
    deleteRun(deps.db, run.id)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.ai_delete',
      entityType: 'player',
      entityId: run.player_id,
      details: { runId: run.id, reason: run.reason, status: run.status, verdict: run.merged?.verdict ?? null }
    })
    res.json({ ok: true })
  })

  /** Only a tag the run itself proposed — this is the admin's click, not a general tag endpoint. */
  router.post('/customers/:id/osint-runs/:runId/apply-tag', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    if (!run || run.player_id !== param(req, 'id')) {
      res.status(404).json({ error: 'no such screening' })
      return
    }
    const tag = (req.body ?? {}).tag
    const suggested = run.merged?.suggested_tags.some((t) => t.tag === tag) ?? false
    if (typeof tag !== 'string' || !(SUGGESTIBLE_TAGS as readonly string[]).includes(tag) || !suggested) {
      res.status(400).json({ error: 'tag was not suggested by this screening' })
      return
    }
    addTag(deps.db, run.player_id, tag, req.staff!.username)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'player.tag',
      entityType: 'player',
      entityId: run.player_id,
      details: { tag, via: 'osint', runId: run.id }
    })
    res.json({ tags: tagsFor(deps.db, run.player_id) })
  })

  // --- Profile photos -------------------------------------------------------

  router.get('/customers/:id/osint-runs/:runId/images/:imageId', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    const image = run && run.player_id === param(req, 'id') ? getImageBytes(deps.db, run.id, Number(param(req, 'imageId'))) : undefined
    if (!image) {
      res.status(404).json({ error: 'no such image' })
      return
    }
    sendImage(res, image.content_type, image.bytes, 'private, max-age=3600')
  })

  /** `?face=different` removes every photo judged a different face; otherwise one photo by id. */
  router.delete('/customers/:id/osint-runs/:runId/images', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    if (!run || run.player_id !== param(req, 'id') || req.query.face !== 'different') {
      res.status(404).json({ error: 'no such screening, or no filter given' })
      return
    }
    const count = deleteImagesByFace(deps.db, run.id, 'different')
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.image_delete',
      entityType: 'player',
      entityId: run.player_id,
      details: { runId: run.id, count, face: 'different' }
    })
    res.json({ ok: true, count })
  })

  router.delete('/customers/:id/osint-runs/:runId/images/:imageId', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    const imageId = Number(param(req, 'imageId'))
    const deleted = run && run.player_id === param(req, 'id') ? deleteImage(deps.db, run.id, imageId) : undefined
    if (!run || !deleted) {
      res.status(404).json({ error: 'no such image' })
      return
    }
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.image_delete',
      entityType: 'player',
      entityId: run.player_id,
      details: { runId: run.id, imageId, page_url: deleted.page_url }
    })
    res.json({ ok: true })
  })

  // --- Reference photo & face comparison -----------------------------------

  /**
   * The guest's reference photo. Refused without ?consent=1: comparing faces is
   * biometric processing, and the guest's explicit consent is its lawful basis —
   * the API records who took that consent rather than letting a client skip it.
   */
  router.put(
    '/customers/:id/photo',
    requireRole('admin'),
    express.raw({ type: PHOTO_TYPES, limit: IMAGE_MAX_BYTES }),
    (req, res) => {
      const player = getPlayer(deps.db, param(req, 'id'))
      if (!player) {
        res.status(404).json({ error: 'no such guest' })
        return
      }
      if (req.query.consent !== '1') {
        res.status(400).json({ error: "the guest's consent is required", code: 'consent_required' })
        return
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : null
      const type = bytes ? sniffImage(bytes) : null
      if (!bytes || !type || !PHOTO_TYPES.includes(type)) {
        res.status(400).json({ error: 'send a JPEG, PNG or WebP photo', code: 'not_an_image' })
        return
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      setPlayerPhoto(deps.db, player.id, { content_type: type, bytes, sha256, consent_by: req.staff!.username })
      audit(deps.db, {
        actor: req.staff!.username,
        action: 'player.photo_set',
        entityType: 'player',
        entityId: player.id,
        details: { consent: true, sha256: sha256.slice(0, 16) }
      })
      res.json({ photo: playerPhotoMeta(deps.db, player.id) })
    }
  )

  // Cached by URL: the client appends ?v=<sha256>, so a replaced photo is a new URL.
  router.get('/customers/:id/photo', requireRole('admin'), (req, res) => {
    const photo = getPlayerPhoto(deps.db, param(req, 'id'))
    if (!photo) {
      res.status(404).json({ error: 'no photo' })
      return
    }
    sendImage(res, photo.content_type, photo.bytes, 'private, max-age=86400')
  })

  router.delete('/customers/:id/photo', requireRole('admin'), (req, res) => {
    const playerId = param(req, 'id')
    if (!deletePlayerPhoto(deps.db, playerId)) {
      res.status(404).json({ error: 'no photo' })
      return
    }
    audit(deps.db, { actor: req.staff!.username, action: 'player.photo_delete', entityType: 'player', entityId: playerId })
    res.json({ ok: true })
  })

  /**
   * Face comparison results, computed in the admin's browser. Only the outcome
   * arrives here — the face descriptors never leave the browser.
   */
  router.post('/customers/:id/osint-runs/:runId/face-results', requireRole('admin'), (req, res) => {
    const run = getRun(deps.db, param(req, 'runId'))
    if (!run || run.player_id !== param(req, 'id')) {
      res.status(404).json({ error: 'no such screening' })
      return
    }
    if (!playerPhotoMeta(deps.db, run.player_id)) {
      res.status(400).json({ error: 'the guest has no reference photo', code: 'no_reference' })
      return
    }
    const raw = (req.body ?? {}).results
    const results: FaceResult[] = []
    for (const r of Array.isArray(raw) ? raw.slice(0, 100) : []) {
      const imageId = Number(r?.imageId)
      const verdict = r?.verdict
      const distance = r?.distance === null ? null : Number(r?.distance)
      const faces = Number(r?.faces)
      if (
        !Number.isInteger(imageId) ||
        !(FACE_VERDICTS as readonly string[]).includes(verdict) ||
        (distance !== null && !(distance >= 0 && distance <= 2)) ||
        !(Number.isInteger(faces) && faces >= 0 && faces <= 100)
      ) {
        res.status(400).json({ error: 'each result needs imageId, verdict, distance (0-2 or null) and faces' })
        return
      }
      results.push({ imageId, verdict, distance, faces })
    }
    const updated = setFaceResults(deps.db, run.id, results)
    const count = (v: string) => results.filter((r) => r.verdict === v).length
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'osint.face_compare',
      entityType: 'player',
      entityId: run.player_id,
      details: {
        runId: run.id,
        compared: updated,
        match: count('match'),
        possible: count('possible'),
        different: count('different'),
        no_face: count('no_face')
      }
    })
    res.json({ ok: true, updated })
  })

  const modelDir = faceModelDir()
  router.get('/face-models/:file', requireRole('admin'), (req, res) => {
    const file = param(req, 'file')
    if (!modelDir || !FACE_MODEL_FILES.has(file)) {
      res.status(404).json({ error: 'no such model file' })
      return
    }
    res.set('Cache-Control', 'private, max-age=604800')
    res.sendFile(join(modelDir, file))
  })

  return router
}
