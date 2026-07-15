import { Router } from 'express'
import { getCard } from '../../domain/accounts.js'
import { audit } from '../../domain/audit.js'
import { confirmIntent, createIntent, setPin } from '../../domain/pos.js'
import type { OrderRequestItem, PayMethod } from '../../domain/orders.js'
import { param, pushBalanceForCard, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

/**
 * Point of sale: staff take an order face-to-face and the customer taps their
 * card on the same Android tablet (Web NFC).
 *
 * Two steps on purpose. `intent` prices the cart and decides server-side whether
 * this payment is one of the 1-in-8 that gets PIN-checked; `confirm` charges it.
 * If the client made that decision it would simply never ask for a PIN.
 *
 * Ordinary staff may take payments — they run the bar. Only admins set PINs.
 */
export function posRouter(deps: StaffDeps): Router {
  const router = Router()

  router.post('/pos/intent', (req, res) => {
    const { cardUid, items, pay, forcePin } = req.body ?? {}

    if (typeof cardUid !== 'string' || cardUid.trim() === '') {
      res.status(400).json({ ok: false, code: 'unknown_card', error: 'cardUid is required' })
      return
    }
    if (!Array.isArray(items)) {
      res.status(400).json({ ok: false, code: 'empty', error: 'items must be an array' })
      return
    }

    const result = createIntent(deps.db, {
      cardUid,
      items: items as OrderRequestItem[],
      pay: pay === 'points' ? 'points' : ('cash' as PayMethod),
      staff: req.staff!.username,
      // Test/demo seam only; harmless in production because the real decision is
      // still made and stored server-side either way.
      ...(typeof forcePin === 'boolean' ? { forcePin } : {})
    })

    if (!result.ok) {
      res.status(400).json(result)
      return
    }
    res.json(result)
  })

  router.post('/pos/confirm', (req, res) => {
    const { intentId, pin } = req.body ?? {}
    if (typeof intentId !== 'string' || intentId.trim() === '') {
      res.status(400).json({ ok: false, code: 'unknown_intent', error: 'intentId is required' })
      return
    }

    const result = confirmIntent(deps.db, {
      intentId,
      ...(typeof pin === 'string' ? { pin } : {})
    })

    if (!result.ok) {
      res.status(400).json(result)
      return
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'pos.charge',
      entityType: 'order',
      entityId: result.orderId,
      details: { cardId: result.cardId, balanceDeni: result.balanceDeni }
    })

    // Keep a terminal that's mid-session from showing a stale balance, and put
    // the drink on the bar's live feed.
    pushBalanceForCard(deps, result.cardId)
    deps.events.emit('order.created', { orderId: result.orderId })

    res.json(result)
  })

  router.post('/cards/:id/pin', requireRole('admin'), (req, res) => {
    const cardId = param(req, 'id')
    if (!getCard(deps.db, cardId)) {
      res.status(404).json({ error: 'no such card' })
      return
    }

    const { pin } = req.body ?? {}
    if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) {
      res.status(400).json({ error: 'pin must be exactly 4 digits' })
      return
    }

    setPin(deps.db, cardId, pin)
    // Deliberately records only that a PIN was set — never the PIN itself.
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'card.set_pin',
      entityType: 'card',
      entityId: cardId
    })
    res.json({ ok: true })
  })

  return router
}
