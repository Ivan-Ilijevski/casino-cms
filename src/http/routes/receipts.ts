import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import { businessDay } from '../../domain/businessDay.js'
import {
  finishPrint,
  isPrintOutcome,
  listReceipts,
  receiptDetail,
  receiptImage,
  startPrint
} from '../../domain/receiptHistory.js'
import { formatReceiptNumber } from '../../domain/receiptNumbers.js'
import { param, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DEVICE = 64
const MAX_ERROR = 300

/** Route ids are integers; anything else is simply not a receipt. */
function intParam(raw: string): number | null {
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null
}

/**
 * Fiscal receipt history and the print log.
 *
 * The same roles that run Каса, since they are the ones standing at the printer when a
 * receipt fails to come out. The bar tablet reaches none of this: staffAuth's
 * BAR_ALLOWED is default-deny, so it needs no entry.
 *
 * The tablet reports its own print attempts because only it can see the printer — the
 * server never talks Bluetooth. That makes the log a record of what the tablet said
 * happened, which is the most anyone can know about a thermal printer with no status
 * channel back.
 */
export function receiptsRouter(deps: StaffDeps): Router {
  const router = Router()
  const canPrint = requireRole('admin', 'staff')

  router.get('/receipts', canPrint, (req, res) => {
    const day = req.query.day
    if (day !== undefined && (typeof day !== 'string' || !DAY.test(day))) {
      res.status(400).json({ error: 'day must be YYYY-MM-DD' })
      return
    }
    res.json(
      listReceipts(deps.db, {
        // The venue's fiscal day, not UTC's — the same day receipt numbers restart on.
        day: day ?? businessDay(deps.config.timeZone, deps.now?.() ?? new Date()),
        unprinted: req.query.unprinted === '1'
      })
    )
  })

  router.get('/receipts/:id', canPrint, (req, res) => {
    const id = intParam(param(req, 'id'))
    const detail = id === null ? undefined : receiptDetail(deps.db, id)
    if (!detail) {
      res.status(404).json({ error: 'no such receipt' })
      return
    }
    res.json(detail)
  })

  router.get('/receipts/:id/image', canPrint, async (req, res) => {
    const id = intParam(param(req, 'id'))
    if (id === null) {
      res.status(404).json({ error: 'no such receipt' })
      return
    }

    let result
    try {
      result = await receiptImage(deps.db, deps.config, id)
    } catch {
      // Only a receipt with no stored image calls out; a dead network must answer.
      res.status(502).json({ error: 'receipt rendering failed', code: 'upstream_error' })
      return
    }
    if (!result.ok) {
      res.status(result.status).json({ error: 'error' in result ? result.error : result.code, code: result.code })
      return
    }
    res.set('Content-Type', result.contentType)
    res.set('Cache-Control', 'no-store')
    res.send(result.png)
  })

  /**
   * Opens a print attempt. The answer says whether the paper must carry КОПИЈА, and
   * the tablet draws the band only when told to — it never decides that itself.
   */
  router.post('/receipts/:id/prints', canPrint, (req, res) => {
    const id = intParam(param(req, 'id'))
    const { device } = req.body ?? {}
    const started =
      id === null
        ? undefined
        : startPrint(deps.db, {
            receiptId: id,
            actor: req.staff!.username,
            device: typeof device === 'string' && device.trim() !== '' ? device.slice(0, MAX_DEVICE) : null
          })
    if (!started) {
      res.status(404).json({ error: 'no such receipt' })
      return
    }

    // A second paper copy of a fiscal document is worth knowing who asked for. An
    // original — including the retry of one that never came out whole — is not a
    // staff decision, it is the sale.
    if (started.copy) {
      audit(deps.db, {
        actor: req.staff!.username,
        action: 'receipt.reprint',
        entityType: 'receipt',
        entityId: String(id),
        details: {
          number: formatReceiptNumber(started.receipt.seq),
          day: started.receipt.day,
          orderId: started.receipt.orderId,
          printId: started.printId
        }
      })
    }

    res.json({ printId: started.printId, copy: started.copy })
  })

  router.post('/receipts/prints/:printId', canPrint, (req, res) => {
    const printId = intParam(param(req, 'printId'))
    const { status, percent, error } = req.body ?? {}

    if (!isPrintOutcome(status)) {
      res.status(400).json({ error: 'status must be sent, interrupted or failed' })
      return
    }
    if (percent !== undefined && percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100)) {
      res.status(400).json({ error: 'percent must be an integer from 0 to 100' })
      return
    }

    const outcome =
      printId === null
        ? 'unknown'
        : finishPrint(deps.db, printId, {
            status,
            percent: typeof percent === 'number' ? percent : null,
            error: typeof error === 'string' && error !== '' ? error.slice(0, MAX_ERROR) : null
          })

    if (outcome === 'unknown') {
      res.status(404).json({ error: 'no such print' })
      return
    }
    // 409 rather than 200: the report was not applied, and a client that thinks it was
    // is wrong about what the log says. Pos.tsx ignores it either way.
    if (outcome === 'already_finished') {
      res.status(409).json({ error: 'print already finished' })
      return
    }
    res.json({ ok: true })
  })

  return router
}
