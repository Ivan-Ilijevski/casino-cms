import cookieParser from 'cookie-parser'
import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit } from '../domain/audit.js'
import type { StaffDeps } from './deps.js'
import { menuRouter } from './routes/menu.js'
import { ordersRouter } from './routes/orders.js'
import { customersRouter } from './routes/customers.js'
import { playersRouter } from './routes/players.js'
import { posRouter } from './routes/pos.js'
import { reportsRouter } from './routes/reports.js'
import { ticketsRouter } from './routes/tickets.js'
import { authenticate, currentUser, requireAuth, SESSION_COOKIE } from './staffAuth.js'

/** The staff dashboard: static SPA + JSON API + the live order feed. */
export function createStaffApp(deps: StaffDeps): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser(deps.config.sessionSecret))

  app.get('/api/health', (_req, res) => res.json({ ok: true }))

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'username and password are required' })
      return
    }

    const user = authenticate(deps.db, username, password)
    if (!user) {
      // Deliberately identical for a bad username and a bad password.
      res.status(401).json({ error: 'invalid credentials' })
      return
    }

    res.cookie(SESSION_COOKIE, user.id, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000
    })
    audit(deps.db, { actor: user.username, action: 'staff.login' })
    res.json({ id: user.id, username: user.username, role: user.role })
  })

  app.post('/api/logout', (req, res) => {
    const user = currentUser(deps.db, req)
    if (user) audit(deps.db, { actor: user.username, action: 'staff.logout' })
    res.clearCookie(SESSION_COOKIE)
    res.json({ ok: true })
  })

  app.get('/api/me', requireAuth(deps.db), (req, res) => {
    res.json(req.staff)
  })

  // Everything below needs a signed-in staff member.
  const api = express.Router()
  api.use(requireAuth(deps.db))
  api.use(ordersRouter(deps))
  api.use(menuRouter(deps))
  api.use(playersRouter(deps))
  api.use(customersRouter(deps))
  api.use(posRouter(deps))
  api.use(ticketsRouter(deps))
  api.use(reportsRouter(deps))
  app.use('/api', api)

  // The built SPA, when present.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
  if (existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')))
  }

  return app
}
