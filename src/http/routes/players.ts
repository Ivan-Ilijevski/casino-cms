import { Router } from 'express'
import {
  addCardToPlayer,
  createPlayerWithCard,
  findCardByUid,
  getCard
} from '../../domain/accounts.js'
import { audit } from '../../domain/audit.js'
import { balanceOf, historyFor, postEntry } from '../../domain/ledger.js'
import { setPin } from '../../domain/pos.js'
import { activeSessionForCard, closeSession } from '../../domain/sessions.js'
import { MAX_PLAYER_NAME_BYTES, utf8Bytes } from '../../wire/limits.js'
import { param, pushBalanceForCard, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

export function playersRouter(deps: StaffDeps): Router {
  const router = Router()

  /** Cards tapped at a terminal that nobody owns yet — the registration inbox. */
  router.get('/unknown-taps', (_req, res) => {
    res.json(
      deps.db.prepare('SELECT * FROM unknown_card_taps ORDER BY last_seen DESC LIMIT 50').all()
    )
  })

  router.delete('/unknown-taps/:uid', requireRole('admin'), (req, res) => {
    deps.db.prepare('DELETE FROM unknown_card_taps WHERE card_uid = ?').run(param(req, 'uid'))
    res.json({ ok: true })
  })

  router.get('/players', (_req, res) => {
    res.json(
      deps.db
        .prepare(
          // Columns are listed, never `p.*`: migration 004 put dob and doc_id on
          // players, and this route has no admin guard. A wildcard here hands a
          // passport number to every barman, and would do it again silently the
          // next time an identity column is added.
          `SELECT p.id, p.name, p.created_at, p.phone, p.email, p.city,
                  COUNT(c.id) AS cards, COALESCE(SUM(c.balance_deni), 0) AS balance_deni
           FROM players p LEFT JOIN cards c ON c.player_id = p.id
           GROUP BY p.id ORDER BY p.name`
        )
        .all()
    )
  })

  router.get('/cards', (_req, res) => {
    res.json(
      deps.db
        .prepare(
          // has_pin, never the hash: a card without a PIN cannot be used at the POS.
          `SELECT c.id, c.card_uid, c.player_id, c.status, c.balance_deni, c.points, c.created_at,
                  p.name AS player_name,
                  CASE WHEN c.pin_hash IS NOT NULL THEN 1 ELSE 0 END AS has_pin
           FROM cards c
           JOIN players p ON p.id = c.player_id ORDER BY p.name`
        )
        .all()
    )
  })

  router.get('/cards/:id', (req, res) => {
    const card = getCard(deps.db, param(req, 'id'))
    if (!card) {
      res.status(404).json({ error: 'no such card' })
      return
    }
    // Same reason as GET /players: no wildcard, so 004's dob/doc_id stay out of
    // a response any authenticated staff member can fetch.
    const player = deps.db
      .prepare('SELECT id, name, created_at, phone, email, city FROM players WHERE id = ?')
      .get(card.player_id)
    res.json({
      card,
      player,
      session: activeSessionForCard(deps.db, card.id) ?? null,
      history: historyFor(deps.db, card.id, 200)
    })
  })

  /** Registers a tapped card to a new or existing player. */
  router.post('/cards', requireRole('admin'), (req, res) => {
    const { cardUid, playerName, playerId, pin } = req.body ?? {}
    if (typeof cardUid !== 'string' || cardUid.trim() === '') {
      res.status(400).json({ error: 'cardUid is required' })
      return
    }
    // Optional here, but the staff UI always sends one: a card with no PIN is
    // refused at the POS rather than silently skipping the spot-check.
    if (pin !== undefined && (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin))) {
      res.status(400).json({ error: 'pin must be exactly 4 digits' })
      return
    }
    if (findCardByUid(deps.db, cardUid)) {
      res.status(400).json({ error: 'that card is already registered' })
      return
    }
    if (typeof playerName === 'string' && utf8Bytes(playerName) > MAX_PLAYER_NAME_BYTES) {
      res.status(400).json({
        error: `name is too long: ${utf8Bytes(playerName)} bytes, the terminal accepts ${MAX_PLAYER_NAME_BYTES}`
      })
      return
    }

    const result = deps.db.transaction(() => {
      let cardId: string
      let resolvedPlayerId: string

      if (typeof playerId === 'string' && playerId) {
        const player = deps.db.prepare('SELECT id FROM players WHERE id = ?').get(playerId)
        if (!player) return null
        resolvedPlayerId = playerId
        // This branch used to insert its own row and forgot card_uid_canon, which
        // left every second card unauthenticatable at both readers.
        cardId = addCardToPlayer(deps.db, { playerId, cardUid }).id
      } else {
        if (typeof playerName !== 'string' || playerName.trim() === '') return null
        const created = createPlayerWithCard(deps.db, { name: playerName, cardUid })
        cardId = created.card.id
        resolvedPlayerId = created.player.id
      }

      if (typeof pin === 'string') setPin(deps.db, cardId, pin)

      // The tap has been claimed; clear it from the inbox.
      deps.db.prepare('DELETE FROM unknown_card_taps WHERE card_uid = ?').run(cardUid)
      return { cardId, resolvedPlayerId }
    })()

    if (!result) {
      res.status(400).json({ error: 'playerId or playerName is required' })
      return
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'card.register',
      entityType: 'card',
      entityId: result.cardId,
      details: { cardUid, playerId: result.resolvedPlayerId }
    })
    res.json({ card: getCard(deps.db, result.cardId) })
  })

  /** Manual balance/points correction. Audited, and pushed to the terminal. */
  router.post('/cards/:id/adjust', requireRole('admin'), (req, res) => {
    const card = getCard(deps.db, param(req, 'id'))
    if (!card) {
      res.status(404).json({ error: 'no such card' })
      return
    }

    const { unit, amount, reason } = req.body ?? {}
    if (unit !== 'deni' && unit !== 'points') {
      res.status(400).json({ error: "unit must be 'deni' or 'points'" })
      return
    }
    if (!Number.isInteger(amount) || amount === 0) {
      res.status(400).json({ error: 'amount must be a non-zero integer' })
      return
    }

    const current = balanceOf(deps.db, card.id, unit)
    if (current + amount < 0) {
      res.status(400).json({ error: `adjustment would take ${unit} negative (${current} + ${amount})` })
      return
    }

    postEntry(deps.db, {
      cardId: card.id,
      unit,
      amount,
      kind: 'adjustment',
      ref: typeof reason === 'string' ? reason : null,
      actor: req.staff!.username
    })
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'card.adjust',
      entityType: 'card',
      entityId: card.id,
      details: { unit, amount, reason: reason ?? null }
    })
    pushBalanceForCard(deps, card.id)

    res.json({
      card: getCard(deps.db, card.id),
      balanceDeni: balanceOf(deps.db, card.id, 'deni'),
      points: balanceOf(deps.db, card.id, 'points')
    })
  })

  router.post('/cards/:id/block', requireRole('admin'), (req, res) => {
    const card = getCard(deps.db, param(req, 'id'))
    if (!card) {
      res.status(404).json({ error: 'no such card' })
      return
    }

    deps.db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id)

    // Kick the terminal immediately rather than waiting for the next auth.
    const session = activeSessionForCard(deps.db, card.id)
    if (session) {
      deps.pushes?.pushLogout(session.sid)
      closeSession(deps.db, session.sid, 'logout_push')
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'card.block',
      entityType: 'card',
      entityId: card.id
    })
    res.json({ card: getCard(deps.db, card.id) })
  })

  router.post('/cards/:id/unblock', requireRole('admin'), (req, res) => {
    const card = getCard(deps.db, param(req, 'id'))
    if (!card) {
      res.status(404).json({ error: 'no such card' })
      return
    }
    deps.db.prepare(`UPDATE cards SET status = 'active' WHERE id = ?`).run(card.id)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'card.unblock',
      entityType: 'card',
      entityId: card.id
    })
    res.json({ card: getCard(deps.db, card.id) })
  })

  return router
}
