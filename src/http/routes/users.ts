import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import {
  countActiveAdmins,
  createStaffUser,
  getStaffUser,
  listStaffUsers,
  MIN_PASSWORD_LEN,
  setStaffPassword,
  updateStaffUser,
  USERNAME_RE,
  verifyStaffPassword,
  type StaffUserPatch
} from '../../domain/staffUsers.js'
import { param, type StaffDeps } from '../deps.js'
import { isStaffRole, requireRole, STAFF_ROLES } from '../staffAuth.js'

const BAD_USERNAME = 'username must be 3-32 characters of a-z, 0-9, dot, underscore or hyphen'
const BAD_PASSWORD = `password must be at least ${MIN_PASSWORD_LEN} characters`
const BAD_ROLE = `role must be one of ${STAFF_ROLES.join(', ')}`

/**
 * Staff accounts. Everything here is admin-only except changing your own
 * password, which every role needs — including the bar tablet.
 *
 * There is no delete: audit_log.actor is the username, so removing a row would
 * orphan that person's history. `active = 0` is the off switch, and it bites on
 * the very next request because currentUser() re-reads active = 1 every time.
 */
export function usersRouter(deps: StaffDeps): Router {
  const router = Router()

  router.get('/users', requireRole('admin'), (_req, res) => {
    res.json({ users: listStaffUsers(deps.db) })
  })

  router.post('/users', requireRole('admin'), (req, res) => {
    const { username, password, role } = req.body ?? {}

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      res.status(400).json({ error: BAD_USERNAME })
      return
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: BAD_PASSWORD })
      return
    }
    if (!isStaffRole(role)) {
      res.status(400).json({ error: BAD_ROLE })
      return
    }

    let created
    try {
      created = createStaffUser(deps.db, { username, password, role })
    } catch {
      res.status(400).json({ error: 'username already taken' })
      return
    }

    // Field names only — details is handed back verbatim by GET /reports/audit.
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'user.create',
      entityType: 'staff_user',
      entityId: created.id,
      details: { username: created.username, role: created.role }
    })
    res.json(created)
  })

  router.patch('/users/:id', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    const existing = getStaffUser(deps.db, id)
    if (!existing) {
      res.status(404).json({ error: 'no such user' })
      return
    }

    const body = req.body ?? {}
    const patch: StaffUserPatch = {}

    if (body.username !== undefined) {
      if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
        res.status(400).json({ error: BAD_USERNAME })
        return
      }
      patch.username = body.username
    }
    if (body.role !== undefined) {
      if (!isStaffRole(body.role)) {
        res.status(400).json({ error: BAD_ROLE })
        return
      }
      patch.role = body.role
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean' && body.active !== 0 && body.active !== 1) {
        res.status(400).json({ error: 'active must be true or false' })
        return
      }
      patch.active = body.active === true || body.active === 1 ? 1 : 0
    }

    const isSelf = id === req.staff!.id
    if (isSelf && patch.role !== undefined && patch.role !== existing.role) {
      res.status(409).json({ error: 'you cannot change your own role' })
      return
    }
    if (isSelf && patch.active === 0) {
      res.status(409).json({ error: 'you cannot deactivate your own account' })
      return
    }

    // Demoting or switching off the last admin locks everyone out of this screen.
    const losesAdmin =
      existing.role === 'admin' &&
      existing.active === 1 &&
      ((patch.role !== undefined && patch.role !== 'admin') || patch.active === 0)
    if (losesAdmin && countActiveAdmins(deps.db, id) === 0) {
      res.status(409).json({ error: 'the last active admin cannot be demoted or deactivated' })
      return
    }

    let changed
    try {
      changed = updateStaffUser(deps.db, id, patch)
    } catch {
      res.status(400).json({ error: 'username already taken' })
      return
    }

    if (changed.length > 0) {
      audit(deps.db, {
        actor: req.staff!.username,
        action: 'user.update',
        entityType: 'staff_user',
        entityId: id,
        details: { changed, username: patch.username ?? existing.username }
      })
    }
    res.json(getStaffUser(deps.db, id))
  })

  router.post('/users/:id/password', requireRole('admin'), (req, res) => {
    const id = param(req, 'id')
    const existing = getStaffUser(deps.db, id)
    if (!existing) {
      res.status(404).json({ error: 'no such user' })
      return
    }

    const { password } = req.body ?? {}
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: BAD_PASSWORD })
      return
    }

    setStaffPassword(deps.db, id, password)

    // Never the password, and never the hash.
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'user.password',
      entityType: 'staff_user',
      entityId: id,
      details: { username: existing.username }
    })
    res.json({ ok: true })
  })

  /** Any signed-in user, any role. Knowing the current password is the check. */
  router.post('/me/password', (req, res) => {
    const { current_password, new_password } = req.body ?? {}

    if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: BAD_PASSWORD })
      return
    }
    if (
      typeof current_password !== 'string' ||
      !verifyStaffPassword(deps.db, req.staff!.id, current_password)
    ) {
      res.status(400).json({ error: 'current password is incorrect' })
      return
    }

    setStaffPassword(deps.db, req.staff!.id, new_password)

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'user.password_self',
      entityType: 'staff_user',
      entityId: req.staff!.id
    })
    res.json({ ok: true })
  })

  return router
}
