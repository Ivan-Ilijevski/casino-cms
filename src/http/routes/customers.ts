import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import {
  addNote,
  addTag,
  auditForPlayer,
  cardsFor,
  customerStats,
  countCustomers,
  customerTimeline,
  deleteNote,
  EDITABLE_FIELDS,
  getPlayer,
  holdsForPlayer,
  listCustomers,
  notesFor,
  removeTag,
  sessionsForPlayer,
  setNotePinned,
  tagsFor,
  ticketsNearSessions,
  updatePlayer,
  type CustomerSort,
  type EditableField,
  type PlayerRow
} from '../../domain/customers.js'
import { listOrders } from '../../domain/orders.js'
import { activeSessionForCard } from '../../domain/sessions.js'
import { MAX_PLAYER_NAME_BYTES, utf8Bytes } from '../../wire/limits.js'
import { param, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

/** Identity a guest could be re-identified from. Admins only. */
const PII: EditableField[] = ['dob', 'doc_id']

const SORTS: CustomerSort[] = ['name', 'balance', 'last_seen', 'created']

/**
 * The whole guest is one page, so the reads are chatty by design: each tab
 * fetches its own slice rather than one endpoint returning everything.
 */
function intParam(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** Ordinary staff run the bar; they have no reason to see a passport number. */
function redact(player: PlayerRow, isAdmin: boolean): Partial<PlayerRow> {
  if (isAdmin) return player
  const copy: Partial<PlayerRow> = { ...player }
  for (const f of PII) delete copy[f]
  return copy
}

export function customersRouter(deps: StaffDeps): Router {
  const router = Router()
  const isAdmin = (req: { staff?: { role: string } }) => req.staff?.role === 'admin'

  /** Guest list — one row per person, not per card. */
  router.get('/customers', (req, res) => {
    const sort = SORTS.includes(req.query.sort as CustomerSort)
      ? (req.query.sort as CustomerSort)
      : 'name'
    const limit = intParam(req.query.limit, 200, 500)
    const offset = intParam(req.query.offset, 0, 100000)
    const rows = listCustomers(deps.db, {
      q: str(req.query.q),
      tag: str(req.query.tag),
      sort,
      limit,
      offset
    })
    // `total` is the count BEFORE the limit, so the list can say "200 of 412"
    // instead of confidently reporting 200 as the whole floor.
    res.json({
      rows,
      total: countCustomers(deps.db, { q: str(req.query.q), tag: str(req.query.tag) }),
      limit,
      offset
    })
  })

  router.get('/customers/:id', (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const cards = cardsFor(deps.db, player.id)
    const session = cards.map((c) => activeSessionForCard(deps.db, c.id)).find(Boolean) ?? null

    res.json({
      player: redact(player, isAdmin(req)),
      cards,
      tags: tagsFor(deps.db, player.id),
      stats: customerStats(deps.db, player.id),
      holds: holdsForPlayer(deps.db, player.id),
      session
    })
  })

  /**
   * Identity edits. The name is byte-capped, not char-capped: the terminal
   * copies it into char name[64] and Cyrillic is two bytes a letter.
   */
  router.patch('/customers/:id', requireRole('admin'), (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }

    const patch: Partial<Record<EditableField, string | null>> = {}
    for (const field of EDITABLE_FIELDS) {
      const value = (req.body ?? {})[field]
      if (value === undefined) continue
      if (value !== null && typeof value !== 'string') {
        res.status(400).json({ error: `${field} must be a string or null` })
        return
      }
      patch[field] = value === null || value.trim() === '' ? null : value.trim()
    }

    if (patch.name === null) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (patch.name !== undefined && utf8Bytes(patch.name) > MAX_PLAYER_NAME_BYTES) {
      res.status(400).json({
        error: `name is too long: ${utf8Bytes(patch.name)} bytes, the terminal accepts ${MAX_PLAYER_NAME_BYTES}`
      })
      return
    }

    const changed = updatePlayer(deps.db, player.id, patch)
    if (changed.length > 0) {
      // Field NAMES only. The audit log must not become a second copy of the
      // identity data it is there to police.
      audit(deps.db, {
        actor: req.staff!.username,
        action: 'player.update',
        entityType: 'player',
        entityId: player.id,
        details: { fields: changed }
      })
    }
    res.json({ player: getPlayer(deps.db, player.id), changed })
  })

  router.get('/customers/:id/timeline', (req, res) => {
    const kinds = str(req.query.type)?.split(',').filter(Boolean)
    res.json(
      customerTimeline(deps.db, param(req, 'id'), {
        kinds,
        from: str(req.query.from),
        to: str(req.query.to),
        limit: intParam(req.query.limit, 50, 200),
        before: Number(req.query.before) || undefined
      })
    )
  })

  router.get('/customers/:id/orders', (req, res) => {
    res.json(
      listOrders(deps.db, {
        playerId: param(req, 'id'),
        limit: intParam(req.query.limit, 50, 200)
      })
    )
  })

  router.get('/customers/:id/sessions', (req, res) => {
    res.json(
      sessionsForPlayer(deps.db, param(req, 'id'), {
        limit: intParam(req.query.limit, 50, 200),
        offset: intParam(req.query.offset, 0, 100000)
      })
    )
  })

  /**
   * Tickets are machine money with no card FK, so this is a time correlation.
   * The `confidence` field on every row is what the UI labels it with — do not
   * present these as confirmed cashouts.
   */
  router.get('/customers/:id/tickets', (req, res) => {
    res.json(ticketsNearSessions(deps.db, param(req, 'id'), intParam(req.query.limit, 50, 200)))
  })

  router.get('/customers/:id/audit', requireRole('admin'), (req, res) => {
    res.json(auditForPlayer(deps.db, param(req, 'id'), intParam(req.query.limit, 100, 500)))
  })

  router.get('/customers/:id/notes', (req, res) => {
    res.json(notesFor(deps.db, param(req, 'id')))
  })

  /** Any staff member may leave a note — the floor sees things the office doesn't. */
  router.post('/customers/:id/notes', (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const body = str((req.body ?? {}).body)
    if (!body) {
      res.status(400).json({ error: 'body is required' })
      return
    }
    const note = addNote(deps.db, player.id, body, req.staff!.username)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'player.note',
      entityType: 'player',
      entityId: player.id,
      details: { noteId: note.id }
    })
    res.json({ note })
  })

  router.post('/customers/:id/notes/:noteId/pin', (req, res) => {
    const pinned = (req.body ?? {}).pinned !== false
    if (!setNotePinned(deps.db, param(req, 'id'), Number(param(req, 'noteId')), pinned)) {
      res.status(404).json({ error: 'no such note' })
      return
    }
    res.json({ ok: true })
  })

  router.delete('/customers/:id/notes/:noteId', requireRole('admin'), (req, res) => {
    const playerId = param(req, 'id')
    const noteId = Number(param(req, 'noteId'))
    if (!deleteNote(deps.db, playerId, noteId)) {
      res.status(404).json({ error: 'no such note' })
      return
    }
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'player.note_delete',
      entityType: 'player',
      entityId: playerId,
      details: { noteId }
    })
    res.json({ ok: true })
  })

  router.get('/customers/:id/tags', (req, res) => {
    res.json(tagsFor(deps.db, param(req, 'id')))
  })

  /** Risk flags carry consequences, so only admins may set or clear one. */
  router.post('/customers/:id/tags', requireRole('admin'), (req, res) => {
    const player = getPlayer(deps.db, param(req, 'id'))
    if (!player) {
      res.status(404).json({ error: 'no such guest' })
      return
    }
    const tag = str((req.body ?? {}).tag)?.toLowerCase()
    if (!tag || !/^[a-z0-9_]{2,32}$/.test(tag)) {
      res.status(400).json({ error: 'tag must be 2-32 chars of a-z, 0-9 or _' })
      return
    }
    addTag(deps.db, player.id, tag, req.staff!.username)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'player.tag',
      entityType: 'player',
      entityId: player.id,
      details: { tag }
    })
    res.json({ tags: tagsFor(deps.db, player.id) })
  })

  router.delete('/customers/:id/tags/:tag', requireRole('admin'), (req, res) => {
    const playerId = param(req, 'id')
    // addTag lowercases before storing, so this must too or DELETE /tags/VIP
    // 404s against a stored `vip`.
    const tag = param(req, 'tag').toLowerCase()
    if (!removeTag(deps.db, playerId, tag)) {
      res.status(404).json({ error: 'no such tag' })
      return
    }
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'player.untag',
      entityType: 'player',
      entityId: playerId,
      details: { tag }
    })
    res.json({ tags: tagsFor(deps.db, playerId) })
  })

  /**
   * Records that a staff member opened a public source about this guest.
   *
   * The server FETCHES NOTHING. The OSINT panel is a link launcher: the browser
   * opens the source directly. All this endpoint does is make the lookup
   * accountable — who ran it, on whom, against which source, and why — which is
   * the whole reason the panel is allowed to exist. The client calls this and
   * only navigates once it succeeds, so there is no unlogged path.
   */
  const OSINT_REASONS = ['kyc', 'aml', 'self_exclusion', 'dispute', 'other']

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
    if (!OSINT_REASONS.includes(reason)) {
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

  return router
}
