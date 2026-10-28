import type { Request } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { activeSessionForCard } from '../domain/sessions.js'
import { balanceOf } from '../domain/ledger.js'
import { getOrder } from '../domain/orders.js'
import { orderPushData } from '../wire/handlers.js'
import type { OsintRunner } from '../domain/osintEngines.js'
import type { CmsEvents } from '../events.js'
import type { TerminalLink } from '../wire/tcpServer.js'

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
  /**
   * Optional for the same reason listLinks is: every existing stub, and every
   * test app built with no TCP server, still satisfies this interface.
   */
  pushOrder?(sid: string, d: Record<string, unknown>): boolean
  /**
   * Live socket state for the machines view. Optional so every existing stub --
   * and every test app built with no TCP server at all -- still satisfies this
   * interface; a caller reading `deps.pushes?.listLinks?.() ?? []` degrades to
   * "registry only, nothing live" instead of throwing.
   */
  listLinks?(): TerminalLink[]
  adoptLink?(connId: string, machineId: string): boolean
  sidsForLink?(connId: string): string[]
  dropLink?(connId: string): boolean
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
  /**
   * The wall clock the fiscal day is read off. Tests pin an instant; production
   * leaves it unset and the real clock stands.
   *
   * Injected rather than taken from the request for the same reason as
   * posPinDecision: a client able to set it could choose which day its receipt
   * counted on, which is the one thing a daily sequence must not allow.
   */
  now?: () => Date
  /**
   * Runs AI screening engines (the claude/codex CLIs). Production passes
   * createCliOsintRunner; tests inject a fake. Unset means no engine is
   * available, so no test app can ever spawn a real CLI by accident.
   */
  osint?: OsintRunner
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

/**
 * Tells the terminal an order moved, so the guest's countdown ring follows
 * what the bar just did.
 *
 * Resolved through the CARD rather than orders.session_id: the order may have
 * been placed in a session that has since closed, or at the POS with no
 * session at all, and what matters is who is holding the card now. Nobody
 * holding it means nothing is sent -- the terminal repairs that by re-asking
 * on its next auth or link-up.
 */
export function pushOrderForOrder(deps: StaffDeps, orderId: string): void {
  if (!deps.pushes?.pushOrder) return
  const order = getOrder(deps.db, orderId)
  if (!order) return
  const session = activeSessionForCard(deps.db, order.card_id)
  if (!session) return
  deps.pushes.pushOrder(session.sid, orderPushData(deps.db, order))
}
