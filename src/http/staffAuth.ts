import type { NextFunction, Request, Response } from 'express'
import type { Db } from '../db/index.js'
import { verifyPassword } from '../domain/password.js'

export type StaffRole = 'admin' | 'staff'

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

export function requireRole(role: StaffRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.staff || (role === 'admin' && req.staff.role !== 'admin')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
}
