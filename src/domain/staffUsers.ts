import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import type { StaffRole } from '../http/staffAuth.js'
import { hashPassword, verifyPassword } from './password.js'

export interface StaffUserRow {
  id: string
  username: string
  role: StaffRole
  active: number
  created_at: string
}

/**
 * Spelled out rather than `SELECT *` so password_hash cannot ride along into a
 * response. This module is the only place that column is read at all.
 */
const COLUMNS = 'id, username, role, active, created_at'

/** Typed at a terminal keyboard behind a bar, so: lowercase, no spaces. */
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/
export const MIN_PASSWORD_LEN = 8

/** Inactive accounts sort last; they are history, not the working list. */
export function listStaffUsers(db: Db): StaffUserRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM staff_users ORDER BY active DESC, username`)
    .all() as StaffUserRow[]
}

export function getStaffUser(db: Db, id: string): StaffUserRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM staff_users WHERE id = ?`).get(id) as
    | StaffUserRow
    | undefined
}

/** Throws on a duplicate username; the caller turns that into a 400. */
export function createStaffUser(
  db: Db,
  input: { username: string; password: string; role: StaffRole }
): StaffUserRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(id, input.username, hashPassword(input.password), input.role)
  return getStaffUser(db, id)!
}

export const EDITABLE_FIELDS = ['username', 'role', 'active'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]
export type StaffUserPatch = Partial<Pick<StaffUserRow, EditableField>>

/** Applies only the fields present in `patch`; returns the ones that changed. */
export function updateStaffUser(db: Db, id: string, patch: StaffUserPatch): EditableField[] {
  const current = getStaffUser(db, id)
  if (!current) return []

  const changed = EDITABLE_FIELDS.filter((f) => f in patch && patch[f] !== current[f])
  if (changed.length === 0) return []

  db.prepare(
    `UPDATE staff_users SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
  ).run(...changed.map((f) => patch[f]!), id)
  return changed
}

export function setStaffPassword(db: Db, id: string, password: string): void {
  db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id)
}

export function verifyStaffPassword(db: Db, id: string, password: string): boolean {
  const row = db.prepare('SELECT password_hash FROM staff_users WHERE id = ?').get(id) as
    | { password_hash: string }
    | undefined
  if (!row) return false
  return verifyPassword(password, row.password_hash)
}

/**
 * Guards the last way in. Pass `exceptId` to ask "would any admin be left if
 * this one were demoted or switched off?".
 */
export function countActiveAdmins(db: Db, exceptId?: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM staff_users
        WHERE role = 'admin' AND active = 1 AND id IS NOT ?`
    )
    .get(exceptId ?? null) as { n: number }
  return row.n
}
