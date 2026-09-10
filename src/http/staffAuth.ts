import type { NextFunction, Request, Response } from 'express'
import type { Db } from '../db/index.js'
import { verifyPassword } from '../domain/password.js'

export type StaffRole = 'admin' | 'staff' | 'bar'

/** The single list the CHECK constraint, the API validators and the UI agree on. */
export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'staff', 'bar']

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value)
}

export interface StaffUser {
  id: string
  username: string
  role: StaffRole
}

interface StaffUserRow extends StaffUser {
  password_hash: string
  active: number
}

export const SESSION_COOKIE = 'cms_staff'

declare module 'express-serve-static-core' {
  interface Request {
    staff?: StaffUser
    db?: Db
  }
}

/** Returns the user only on an exact password match against an active account. */
export function authenticate(db: Db, username: string, password: string): StaffUser | null {
  const row = db
    .prepare('SELECT * FROM staff_users WHERE username = ? AND active = 1')
    .get(username) as StaffUserRow | undefined
  if (!row) return null
  if (!verifyPassword(password, row.password_hash)) return null
  return { id: row.id, username: row.username, role: row.role }
}

export function currentUser(db: Db, req: Request): StaffUser | null {
  const id = req.signedCookies?.[SESSION_COOKIE]
  if (typeof id !== 'string' || !id) return null
  const row = db.prepare('SELECT id, username, role FROM staff_users WHERE id = ? AND active = 1').get(id) as
    | StaffUser
    | undefined
  return row ?? null
}

export function requireAuth(db: Db) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = currentUser(db, req)
    if (!user) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    req.staff = user
    next()
  }
}

/**
 * Passes only the listed roles. This used to read `role === 'admin' && ...`,
 * which enforced nothing at all for any other argument — harmless while 'staff'
 * was the only alternative, a hole the moment a third role exists.
 */
export function requireRole(...roles: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.staff || !roles.includes(req.staff.role)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
}

/**
 * Everything under /api that carries no requireRole is open to any signed-in
 * user, so a restricted role cannot be expressed by adding guards — the next
 * route someone writes would be open to it by omission.
 *
 * The bar tablet is therefore default-DENY: it may call what is listed here and
 * nothing else. Paths are relative to the /api mount, which is what req.path
 * holds inside this router (Express strips req.baseUrl).
 */
const BAR_ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/orders$/ },
  { method: 'GET', path: /^\/orders\/events$/ },
  { method: 'POST', path: /^\/orders\/[^/]+\/status$/ },
  { method: 'GET', path: /^\/menu$/ },
  { method: 'POST', path: /^\/menu\/[^/]+\/stock$/ },
  { method: 'POST', path: /^\/me\/password$/ }
]

export function restrictBarRole() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.staff?.role !== 'bar') {
      next()
      return
    }
    if (BAR_ALLOWED.some((r) => r.method === req.method && r.path.test(req.path))) {
      next()
      return
    }
    res.status(403).json({ error: 'forbidden' })
  }
}
