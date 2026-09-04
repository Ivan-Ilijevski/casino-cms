import type { Request } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { activeSessionForCard } from '../domain/sessions.js'
import { balanceOf } from '../domain/ledger.js'
import type { CmsEvents } from '../events.js'

/**
 * Express only infers route-param types for the two-argument overload, so any
 * handler sitting behind a middleware (requireRole) sees string | string[] |
 * undefined. This narrows it in one place instead of casting at every call.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : ''
}

/** What the staff app needs from the terminal link, narrowed so tests can stub it. */
export interface Pusher {
  pushBalance(sid: string, balanceDeni: number, points: number): boolean
  pushLogout(sid: string): boolean
}

export interface StaffDeps {
  db: Db
  config: Config
  events: CmsEvents
  pushes?: Pusher
  /**
   * Overrides the 1-in-8 POS PIN spot-check roll. Tests inject a deterministic
   * one; production leaves it unset and the roll stands.
   *
   * Deliberately an injected dependency rather than a request field: the
   * spot-check is what stops a staff member charging a card they are holding,
   * so a client able to set it would simply set it off on every sale.
   */
  posPinDecision?: () => boolean
}

/**
 * Tells the terminal a card's balance moved, if that card is currently in a
 * session. Without this the player would keep seeing a stale balance after a
 * staff adjustment or refund.
 */
export function pushBalanceForCard(deps: StaffDeps, cardId: string): void {
  if (!deps.pushes) return
  const session = activeSessionForCard(deps.db, cardId)
  if (!session) return
  deps.pushes.pushBalance(
    session.sid,
    balanceOf(deps.db, cardId, 'deni'),
    balanceOf(deps.db, cardId, 'points')
  )
}
