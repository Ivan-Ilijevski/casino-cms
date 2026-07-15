export interface StaffUser {
  id: string
  username: string
  role: 'admin' | 'staff'
}

export interface OrderLine {
  drink_id: number
  name: string
  qty: number
  unit_price_deni: number
  unit_points: number
  line_total_deni: number
  line_total_points: number
}

export interface Order {
  id: string
  number: number
  card_id: string
  pay_method: 'cash' | 'points'
  total_deni: number
  total_points: number
  status: 'received' | 'accepted' | 'fulfilled' | 'cancelled'
  created_at: string
  fulfilled_by: string | null
  player_name: string
  card_uid: string
  items: OrderLine[]
}

export interface MenuItem {
  drink_id: number
  name: string
  price_deni: number
  points_price: number
  available: number
  sort_order: number
}

export interface Card {
  id: string
  card_uid: string
  player_id: string
  status: 'active' | 'blocked'
  balance_deni: number
  points: number
  player_name?: string
  /** A card without a PIN cannot pay at the POS. */
  has_pin?: number
}

export interface Ticket {
  id: string
  amount_deni: number
  status: 'issued' | 'redeemed' | 'voided' | 'expired'
  source: string
  created_at: string
  redeemed_at: string | null
}

export interface UnknownTap {
  card_uid: string
  first_seen: string
  last_seen: string
  count: number
}

export interface LedgerEntry {
  id: number
  unit: 'deni' | 'points'
  amount: number
  kind: string
  txn: string | null
  ref: string | null
  actor: string
  created_at: string
}

export interface Summary {
  orders: { total: number; received: number; fulfilled: number; cancelled: number }
  revenue: { cashDeni: number; pointsSpent: number }
  tickets: { outstandingDeni: number; outstanding: number; redeemedDeni: number }
  topDrinks: Array<{ name: string; qty: number; deni: number }>
  ordersPerDay: Array<{ day: string; orders: number; deni: number }>
  activeSessions: number
  cards: { n: number; balanceDeni: number }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export type PosIntentResponse =
  | {
      ok: true
      intentId: string
      player: { name: string; balance: number; points: number }
      totalDeni: number
      totalPoints: number
      pinRequired: boolean
      expiresAt: string
    }
  | { ok: false; code: string }

export type PosConfirmResponse =
  | { ok: true; orderId: string; number: number; balanceDeni: number; points: number }
  | { ok: false; code: string; attemptsLeft?: number }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body.error ?? `request failed (${res.status})`, res.status)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

/**
 * POS endpoints answer 400 with a machine-readable `code` for ordinary
 * outcomes (wrong PIN, unknown card), so the caller wants the body, not a throw.
 */
async function raw<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status === 401) throw new ApiError('not authenticated', 401)
  return (await res.json()) as T
}

export const api = {
  me: () => req<StaffUser>('/me'),
  login: (username: string, password: string) => post<StaffUser>('/login', { username, password }),
  logout: () => post<{ ok: true }>('/logout'),

  orders: (status?: string) => req<Order[]>(`/orders${status ? `?status=${status}` : ''}`),
  setOrderStatus: (id: string, status: string) =>
    post<{ order: Order; refunded: boolean }>(`/orders/${id}/status`, { status }),

  menu: () => req<{ items: MenuItem[]; warning: string | null }>('/menu'),
  createDrink: (item: Partial<MenuItem>) => post<MenuItem>('/menu', item),
  updateDrink: (drinkId: number, patch: Partial<MenuItem>) =>
    req<MenuItem>(`/menu/${drinkId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDrink: (drinkId: number) => req<{ ok: true }>(`/menu/${drinkId}`, { method: 'DELETE' }),

  cards: () => req<Card[]>('/cards'),
  card: (id: string) =>
    req<{ card: Card; player: { name: string }; session: unknown; history: LedgerEntry[] }>(
      `/cards/${id}`
    ),
  registerCard: (cardUid: string, playerName: string, pin?: string) =>
    post<{ card: Card }>('/cards', { cardUid, playerName, ...(pin ? { pin } : {}) }),
  adjust: (id: string, unit: 'deni' | 'points', amount: number, reason: string) =>
    post<{ card: Card; balanceDeni: number; points: number }>(`/cards/${id}/adjust`, {
      unit,
      amount,
      reason
    }),
  block: (id: string) => post<{ card: Card }>(`/cards/${id}/block`),
  unblock: (id: string) => post<{ card: Card }>(`/cards/${id}/unblock`),
  unknownTaps: () => req<UnknownTap[]>('/unknown-taps'),

  setPin: (cardId: string, pin: string) => post<{ ok: true }>(`/cards/${cardId}/pin`, { pin }),

  // POS is two-step on purpose: the server prices the cart AND decides whether
  // this payment is PIN-checked, so the client cannot opt out of the check.
  posIntent: (cardUid: string, items: Array<{ drink: number; qty: number }>, pay: 'cash' | 'points') =>
    raw<PosIntentResponse>('/pos/intent', { cardUid, items, pay }),
  posConfirm: (intentId: string, pin?: string) =>
    raw<PosConfirmResponse>('/pos/confirm', { intentId, ...(pin ? { pin } : {}) }),

  tickets: (status?: string) => req<Ticket[]>(`/tickets${status ? `?status=${status}` : ''}`),
  issueTicket: (amountDeni: number) => post<Ticket>('/tickets', { amountDeni }),
  voidTicket: (id: string) => post<{ ticket: Ticket }>(`/tickets/${id}/void`),

  summary: () => req<Summary>('/reports/summary')
}

/** Money is integer deni everywhere; only the UI ever sees decimals. */
export function mkd(deni: number): string {
  return (deni / 100).toLocaleString('mk-MK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function timeAgo(iso: string): string {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC.
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime()
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `пред ${secs}с`
  if (secs < 3600) return `пред ${Math.floor(secs / 60)}м`
  if (secs < 86400) return `пред ${Math.floor(secs / 3600)}ч`
  return `пред ${Math.floor(secs / 86400)}д`
}
