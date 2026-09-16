import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

/**
 * The slot machine registry behind the admin Machines view.
 *
 * A cabinet is identified by two things that arrive together and neither of
 * which is trustworthy alone:
 *
 *   - `hello.dev`, which the terminal volunteers on every connect. SMIB_DEVICE_ID
 *     is a compile-time constant in the firmware's board.h, so today every
 *     terminal says "smib-1" and it cannot separate two cabinets on its own.
 *   - the remote IP, which is per slot PC and so actually does separate them,
 *     but changes if the venue ever moves off static leases.
 *
 * Hence `resolveMachineByLink`: host wins, device_id is a fallback used only when
 * it is unambiguous, and anything unmatched stays an *unregistered* live link that
 * an admin adopts by hand. Nothing here ever auto-creates a machine -- a phantom
 * row per stray connection would be worse than an empty list.
 */

export type MachineStatus = 'in_service' | 'out_of_service'

/** The single list the CHECK constraint, the API validators and the UI agree on. */
export const MACHINE_STATUSES: readonly MachineStatus[] = ['in_service', 'out_of_service']

export function isMachineStatus(value: unknown): value is MachineStatus {
  return typeof value === 'string' && (MACHINE_STATUSES as readonly string[]).includes(value)
}

export interface MachineRow {
  id: string
  label: string
  device_id: string | null
  host: string | null
  location: string | null
  asset_no: string | null
  serial: string | null
  status: MachineStatus
  notes: string | null
  fw: string | null
  proto: number | null
  first_seen: string | null
  last_seen: string | null
  connects: number
  created_at: string
  updated_at: string
}

const COLUMNS = `id, label, device_id, host, location, asset_no, serial, status, notes,
                 fw, proto, first_seen, last_seen, connects, created_at, updated_at`

export const MAX_LABEL_LEN = 48
export const MAX_TEXT_LEN = 120

/**
 * Node reports an IPv4 peer on a dual-stack listener as "::ffff:192.168.1.7".
 * Everything downstream compares hosts as strings, so they are folded here, in
 * one place, or the same cabinet would match on one boot and not the next.
 */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const host = raw.trim().toLowerCase()
  if (host === '') return null
  const unmapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host
  // The two loopbacks are one host. Without this a cabinet registered as
  // 127.0.0.1 loses its tickets the moment something reaches the legacy API as
  // "localhost", which many clients resolve to ::1 first.
  return unmapped === '::1' ? '127.0.0.1' : unmapped
}

/** Out-of-service machines sort last: they are inventory, not the working floor. */
export function listMachines(db: Db): MachineRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM machines
        ORDER BY (status = 'out_of_service'), label COLLATE NOCASE`
    )
    .all() as MachineRow[]
}

export function getMachine(db: Db, id: string): MachineRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM machines WHERE id = ?`).get(id) as
    | MachineRow
    | undefined
}

export interface MachineInput {
  label: string
  device_id?: string | null
  host?: string | null
  location?: string | null
  asset_no?: string | null
  serial?: string | null
  notes?: string | null
}

/** Throws on a duplicate host; the caller turns that into a 400. */
export function createMachine(db: Db, input: MachineInput): MachineRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO machines (id, label, device_id, host, location, asset_no, serial, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.label,
    input.device_id ?? null,
    normaliseHost(input.host),
    input.location ?? null,
    input.asset_no ?? null,
    input.serial ?? null,
    input.notes ?? null
  )
  return getMachine(db, id)!
}

export const EDITABLE_FIELDS = [
  'label',
  'device_id',
  'host',
  'location',
  'asset_no',
  'serial',
  'notes',
  'status'
] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]
export type MachinePatch = Partial<Pick<MachineRow, EditableField>>

/** Applies only the fields present in `patch`; returns the ones that changed. */
export function updateMachine(db: Db, id: string, patch: MachinePatch): EditableField[] {
  const current = getMachine(db, id)
  if (!current) return []

  const changed = EDITABLE_FIELDS.filter((f) => f in patch && patch[f] !== current[f])
  if (changed.length === 0) return []

  db.prepare(
    `UPDATE machines SET ${changed.map((f) => `${f} = ?`).join(', ')},
                         updated_at = datetime('now')
      WHERE id = ?`
  ).run(...changed.map((f) => patch[f] ?? null), id)
  return changed
}

/**
 * Which registered machine is on the other end of this connection, or null.
 *
 * Host first, because it is the only part that differs between two cabinets
 * today. device_id is consulted only when exactly one machine carries it: with
 * the firmware's shared "smib-1" a second registered cabinet makes the id
 * ambiguous, and guessing would attribute a session to the wrong machine --
 * worse than reporting the link as unregistered.
 */
export function resolveMachineByLink(
  db: Db,
  link: { deviceId?: string | null; host?: string | null }
): string | null {
  const host = normaliseHost(link.host)
  if (host) {
    const byHost = db.prepare('SELECT id FROM machines WHERE host = ?').get(host) as
      | { id: string }
      | undefined
    if (byHost) return byHost.id
  }

  const deviceId = typeof link.deviceId === 'string' ? link.deviceId.trim() : ''
  if (deviceId === '') return null

  const byDevice = db
    .prepare('SELECT id FROM machines WHERE device_id = ? LIMIT 2')
    .all(deviceId) as Array<{ id: string }>
  return byDevice.length === 1 ? byDevice[0]!.id : null
}

/**
 * Records that a machine just spoke to us. Called from the TCP layer, where it
 * is wrapped in its own try/catch: losing a last_seen is an oversight gap, never
 * a reason to disturb the money path.
 */
export function markMachineSeen(
  db: Db,
  machineId: string,
  info: { deviceId?: string | null; fw?: string | null; proto?: number | null; connected?: boolean }
): void {
  db.prepare(
    `UPDATE machines
        SET last_seen  = datetime('now'),
            first_seen = COALESCE(first_seen, datetime('now')),
            device_id  = COALESCE(?, device_id),
            fw         = COALESCE(?, fw),
            proto      = COALESCE(?, proto),
            connects   = connects + ?
      WHERE id = ?`
  ).run(
    info.deviceId ?? null,
    info.fw ?? null,
    info.proto ?? null,
    info.connected ? 1 : 0,
    machineId
  )
}

/** Stamps the cabinet a card session was opened at. Best-effort, like the above. */
export function stampSessionMachine(db: Db, sid: string, machineId: string): void {
  db.prepare('UPDATE sessions SET machine_id = ? WHERE sid = ?').run(machineId, sid)
}

export interface MachineSessionRow {
  sid: string
  machine_id: string | null
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
  player_id: string
  player_name: string
}

/** Open sessions first, then most recent. Drives both history and "who is playing". */
export function machineSessions(db: Db, machineId: string, limit = 100): MachineSessionRow[] {
  return db
    .prepare(
      `SELECT s.sid, s.machine_id, s.opened_at, s.last_activity_at, s.closed_at,
              s.close_reason, p.id AS player_id, p.name AS player_name
         FROM sessions s
         JOIN cards c   ON c.id = s.card_id
         JOIN players p ON p.id = c.player_id
        WHERE s.machine_id = ?
        ORDER BY (s.closed_at IS NOT NULL), s.opened_at DESC
        LIMIT ?`
    )
    .all(machineId, limit) as MachineSessionRow[]
}

export function activeSessionsForMachine(db: Db, machineId: string): MachineSessionRow[] {
  return machineSessions(db, machineId).filter((s) => s.closed_at === null)
}

export interface MachineOrderRow {
  id: string
  number: number
  pay_method: string
  total_deni: number
  total_points: number
  status: string
  created_at: string
  player_name: string
}

/** Orders carry the sid they were placed in, so the machine comes via sessions. */
export function machineOrders(db: Db, machineId: string, limit = 100): MachineOrderRow[] {
  return db
    .prepare(
      `SELECT o.id, o.number, o.pay_method, o.total_deni, o.total_points, o.status,
              o.created_at, p.name AS player_name
         FROM orders o
         JOIN sessions s ON s.sid = o.session_id
         JOIN cards c    ON c.id = o.card_id
         JOIN players p  ON p.id = c.player_id
        WHERE s.machine_id = ?
        ORDER BY o.created_at DESC
        LIMIT ?`
    )
    .all(machineId, limit) as MachineOrderRow[]
}

export interface MachineTicketRow {
  id: string
  amount_deni: number
  status: string
  source: string
  created_at: string
  redeemed_at: string | null
  redeemed_by: string | null
}

export function machineTickets(db: Db, machineId: string, limit = 100): MachineTicketRow[] {
  return db
    .prepare(
      `SELECT id, amount_deni, status, source, created_at, redeemed_at, redeemed_by
         FROM tickets
        WHERE machine_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(machineId, limit) as MachineTicketRow[]
}
