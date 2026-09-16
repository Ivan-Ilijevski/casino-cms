import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import {
  activeSessionsForMachine,
  createMachine,
  getMachine,
  isMachineStatus,
  listMachines,
  machineOrders,
  machineSessions,
  machineTickets,
  MACHINE_STATUSES,
  MAX_LABEL_LEN,
  MAX_TEXT_LEN,
  normaliseHost,
  updateMachine,
  type MachineInput,
  type MachinePatch,
  type MachineRow
} from '../../domain/machines.js'
import { closeSession } from '../../domain/sessions.js'
import { LINK_SILENT_MS, type TerminalLink } from '../../wire/tcpServer.js'
import { param, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

/**
 * Slot machines. Admin-only throughout; the bar tablet is already default-deny
 * by omission, so staffAuth's BAR_ALLOWED needs no entry.
 *
 * Two sources are merged here and they answer different questions. The `machines`
 * table says which cabinets exist and what they are called; the TCP server's
 * in-memory link list says which sockets are up right now. A machine can be in
 * one and not the other -- registered but unplugged, or plugged in and not yet
 * registered -- and both cases are shown rather than hidden.
 *
 * There is no delete. A machine is the thing sessions, orders and tickets are
 * attributed to, so removing a row would orphan that history; `out_of_service`
 * is the off switch, and it is advisory only -- nothing in the wire path reads
 * it, so a mis-set flag can never stop a guest playing.
 */

const BAD_LABEL = `label is required and must be at most ${MAX_LABEL_LEN} characters`
const BAD_TEXT = `text fields must be at most ${MAX_TEXT_LEN} characters`
const BAD_HOST = 'host must be an IP address or hostname, at most 64 characters'
const BAD_STATUS = `status must be one of ${MACHINE_STATUSES.join(', ')}`
const HOST_RE = /^[a-z0-9._:-]{1,64}$/

export type LinkState = 'online' | 'silent' | 'offline'

/**
 * What the live socket looks like from the staff app. `state` mirrors what the
 * firmware itself believes: it pings every 2 s and calls its own link down after
 * 6 s of silence (LINK_SILENT_MS), so a connection that has gone quiet is
 * reported as such rather than being trusted just because the socket is open.
 */
/**
 * The staff API speaks SQLite's "YYYY-MM-DD HH:MM:SS" in UTC everywhere, because
 * every other datetime it returns comes straight out of a column. These two come
 * from a live socket rather than a row, so they are shaped to match: fmtDateTime
 * and timeAgo in the web app both parse that exact form, and hand back NaN for a
 * real ISO-8601 string.
 */
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function linkView(link: TerminalLink, now: number) {
  const state: LinkState = now - link.lastRxAt < LINK_SILENT_MS ? 'online' : 'silent'
  return {
    connId: link.connId,
    machineId: link.machineId,
    host: link.host,
    port: link.port,
    connectedAt: sqlTime(link.connectedAt),
    lastRxAt: sqlTime(link.lastRxAt),
    deviceId: link.deviceId ?? null,
    fw: link.fw ?? null,
    proto: link.proto ?? null,
    frames: link.frames,
    lastType: link.lastType ?? null,
    state
  }
}

function textField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function machinesRouter(deps: StaffDeps): Router {
  const router = Router()

  const links = (): TerminalLink[] => deps.pushes?.listLinks?.() ?? []

  /** Registry row + whichever live socket resolved to it + who is playing on it. */
  function view(machine: MachineRow, live: TerminalLink[], now: number) {
    const link = live.find((l) => l.machineId === machine.id)
    return {
      ...machine,
      link: link ? linkView(link, now) : null,
      state: (link ? linkView(link, now).state : 'offline') as LinkState,
      players: activeSessionsForMachine(deps.db, machine.id).map((s) => ({
        sid: s.sid,
        playerId: s.player_id,
        name: s.player_name,
        openedAt: s.opened_at
      }))
    }
  }

  router.get('/machines', requireRole('admin'), (_req, res) => {
    const now = Date.now()
    const live = links()
    res.json({ machines: listMachines(deps.db).map((m) => view(m, live, now)) })
  })

  /**
   * Every live socket, registered or not. Declared before /machines/:id or the
   * param route would swallow "links".
   */
  router.get('/machines/links', requireRole('admin'), (_req, res) => {
    const now = Date.now()
    res.json({ links: links().map((l) => linkView(l, now)) })
  })

  /** Live machine feed for the admin screen; mirrors /orders/events. */
  router.get('/machines/events', requireRole('admin'), (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')

    const send = (event: string, payload: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    const offConnected = deps.events.on('machine.connected', (p) => send('machine.connected', p))
    const offDisconnected = deps.events.on('machine.disconnected', (p) =>
      send('machine.disconnected', p)
    )
    const offUpdated = deps.events.on('machine.updated', (p) => send('machine.updated', p))

    // Proxies drop idle connections; a comment keeps the stream warm.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      offConnected()
      offDisconnected()
      offUpdated()
    })
  })

  function readInput(
    body: Record<string, unknown>
  ): { error: string } | { ok: true; input: MachineInput } {
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '' || label.length > MAX_LABEL_LEN) return { error: BAD_LABEL }

    const host = body.host === undefined ? undefined : normaliseHost(body.host as string)
    if (host !== undefined && host !== null && !HOST_RE.test(host)) return { error: BAD_HOST }

    const text: Record<string, string | null | undefined> = {}
    for (const field of ['device_id', 'location', 'asset_no', 'serial', 'notes'] as const) {
      const value = textField(body[field])
      if (value !== undefined && value !== null && value.length > MAX_TEXT_LEN) {
        return { error: BAD_TEXT }
      }
      text[field] = value
    }
    return { ok: true, input: { label, host, ...text } }
  }

  router.post('/machines', requireRole('admin'), (req, res) => {
    const parsed = readInput(req.body ?? {})
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }

    let created: MachineRow
    try {
      created = createMachine(deps.db, parsed.input)
    } catch {
      // The only UNIQUE on this table is host; anything else would be a bug.
      res.status(400).json({ error: 'another machine already uses that host' })
      return
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'machine.create',
      entityType: 'machine',
      entityId: created.id,
      details: { label: created.label, host: created.host }
    })
    deps.events.emit('machine.updated', { machineId: created.id })
    res.json(created)
  })

  /**
   * Registers the cabinet on the other end of a live connection. This is the
   * whole onboarding story: plug a machine in, it shows up unregistered, name it.
   * The host and device_id come from the socket rather than from the client, so
   * an admin cannot mistype the one field that has to match.
   */
  router.post('/machines/adopt', requireRole('admin'), (req, res) => {
    const connId = typeof req.body?.connId === 'string' ? req.body.connId : ''
    const link = links().find((l) => l.connId === connId)
    if (!link) {
      res.status(404).json({ error: 'no such live connection' })
      return
    }
    if (link.machineId) {
      res.status(409).json({ error: 'that connection is already a registered machine' })
      return
    }

    const parsed = readInput({ ...(req.body ?? {}), host: link.host })
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }

    let created: MachineRow
    try {
      created = createMachine(deps.db, { ...parsed.input, device_id: link.deviceId ?? null })
    } catch {
      res.status(400).json({ error: 'another machine already uses that host' })
      return
    }

    // Bind the live socket now. listLinks() returns copies, so assigning to
    // `link` here would change nothing, and cms.c only re-sends hello on a
    // reconnect -- the cabinet would sit there reading as offline until then.
    deps.pushes?.adoptLink?.(link.connId, created.id)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'machine.adopt',
      entityType: 'machine',
      entityId: created.id,
      details: { label: created.label, host: created.host, deviceId: link.deviceId ?? null }
    })
    deps.events.emit('machine.updated', { machineId: created.id })
    res.json(created)
  })

  router.get('/machines/:id', requireRole('admin'), (req, res) => {
    const machine = getMachine(deps.db, param(req, 'id'))
    if (!machine) {
      res.status(404).json({ error: 'no such machine' })
      return
    }
    res.json(view(machine, links(), Date.now()))
  })

  router.get('/machines/:id/sessions', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }
    res.json({ sessions: machineSessions(deps.db, id) })
  })

  router.get('/machines/:id/orders', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }
    res.json({ orders: machineOrders(deps.db, id) })
  })

  router.get('/machines/:id/tickets', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }
    res.json({ tickets: machineTickets(deps.db, id) })
  })

  router.patch('/machines/:id', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }

    const body = req.body ?? {}
    const patch: MachinePatch = {}

    if (body.label !== undefined) {
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (label === '' || label.length > MAX_LABEL_LEN) {
        res.status(400).json({ error: BAD_LABEL })
        return
      }
      patch.label = label
    }

    if (body.host !== undefined) {
      const host = normaliseHost(body.host)
      if (host !== null && !HOST_RE.test(host)) {
        res.status(400).json({ error: BAD_HOST })
        return
      }
      patch.host = host
    }

    if (body.status !== undefined) {
      if (!isMachineStatus(body.status)) {
        res.status(400).json({ error: BAD_STATUS })
        return
      }
      patch.status = body.status
    }

    for (const field of ['device_id', 'location', 'asset_no', 'serial', 'notes'] as const) {
      if (body[field] === undefined) continue
      const value = textField(body[field])
      if (value !== null && (value === undefined || value.length > MAX_TEXT_LEN)) {
        res.status(400).json({ error: BAD_TEXT })
        return
      }
      patch[field] = value
    }

    let changed: readonly string[]
    try {
      changed = updateMachine(deps.db, id, patch)
    } catch {
      res.status(400).json({ error: 'another machine already uses that host' })
      return
    }

    if (changed.length > 0) {
      audit(deps.db, {
        actor: req.staff!.username,
        action: 'machine.update',
        entityType: 'machine',
        entityId: id,
        // Field names only -- details is handed back verbatim by GET /reports/audit.
        details: { fields: changed }
      })
      deps.events.emit('machine.updated', { machineId: id })
    }
    res.json(getMachine(deps.db, id))
  })

  /**
   * Advisory only. Nothing in src/wire reads machines.status, so a cabinet taken
   * out of service keeps authenticating cards and pouring drinks -- it simply
   * stops counting as a fault when it is offline.
   */
  router.post('/machines/:id/status', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }
    if (!isMachineStatus(req.body?.status)) {
      res.status(400).json({ error: BAD_STATUS })
      return
    }

    updateMachine(deps.db, id, { status: req.body.status })
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'machine.status',
      entityType: 'machine',
      entityId: id,
      details: { status: req.body.status }
    })
    deps.events.emit('machine.updated', { machineId: id })
    res.json(getMachine(deps.db, id))
  })

  /**
   * Logs the player out at the cabinet. logout_push is a message the firmware has
   * always understood, so the terminal returns to its idle screen rather than
   * showing a session the CMS has already closed.
   */
  router.post('/machines/:id/logout', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }

    const sessions = activeSessionsForMachine(deps.db, id)
    for (const session of sessions) {
      deps.pushes?.pushLogout(session.sid)
      closeSession(deps.db, session.sid, 'logout_push')
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'machine.logout',
      entityType: 'machine',
      entityId: id,
      details: { sessions: sessions.length }
    })
    res.json({ ok: true, sessions: sessions.length })
  })

  /**
   * Cuts the TCP link. cmsBridge reconnects on its own 2 s backoff, so this is a
   * way to force a re-hello (and so a re-identify), not a way to switch a machine
   * off.
   */
  router.post('/machines/:id/drop', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    if (!getMachine(deps.db, id)) {
      res.status(404).json({ error: 'no such machine' })
      return
    }

    const link = links().find((l) => l.machineId === id)
    if (!link) {
      res.status(409).json({ error: 'that machine has no live connection' })
      return
    }

    const dropped = deps.pushes?.dropLink?.(link.connId) ?? false
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'machine.drop',
      entityType: 'machine',
      entityId: id,
      details: { connId: link.connId, dropped }
    })
    res.json({ ok: dropped })
  })

  return router
}
