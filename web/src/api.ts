/** 'bar' is the tablet at the bar: orders and the drink list, nothing else. */
export type StaffRole = 'admin' | 'staff' | 'bar'

export interface StaffUser {
  id: string
  username: string
  role: StaffRole
}

/** What the admin user list shows. The password hash never crosses the wire. */
export interface StaffAccount {
  id: string
  username: string
  role: StaffRole
  active: number
  created_at: string
}

/** How a cabinet's TCP link reads right now. Mirrors LinkState on the server. */
export type LinkState = 'online' | 'silent' | 'offline'

/** One live socket on port 9020, registered to a machine or not yet. */
export interface TerminalLink {
  connId: string
  machineId: string | null
  host: string | null
  port: number
  /** SQLite-shaped UTC ("YYYY-MM-DD HH:MM:SS"), like every other date here. */
  connectedAt: string
  lastRxAt: string
  deviceId: string | null
  fw: string | null
  proto: number | null
  frames: number
  lastType: string | null
  state: LinkState
}

export interface MachinePlayer {
  sid: string
  playerId: string
  name: string
  openedAt: string
}

/**
 * A registered cabinet. `status` is advisory — taking a machine out of service
 * changes nothing on the wire, it only stops the machine counting as a fault.
 */
export interface Machine {
  id: string
  label: string
  device_id: string | null
  host: string | null
  location: string | null
  asset_no: string | null
  serial: string | null
  status: 'in_service' | 'out_of_service'
  notes: string | null
  fw: string | null
  proto: number | null
  first_seen: string | null
  last_seen: string | null
  connects: number
  created_at: string
  updated_at: string
  link: TerminalLink | null
  state: LinkState
  players: MachinePlayer[]
}

export interface MachineSession {
  sid: string
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
  player_id: string
  player_name: string
}

export interface MachineOrder {
  id: string
  number: number
  pay_method: 'cash' | 'points'
  total_deni: number
  total_points: number
  status: Order['status']
  created_at: string
  player_name: string
}

export interface MachineTicket {
  id: string
  amount_deni: number
  status: 'issued' | 'redeemed' | 'voided' | 'expired'
  source: string
  created_at: string
  redeemed_at: string | null
  redeemed_by: string | null
}

export interface MachineInput {
  label: string
  host?: string | null
  device_id?: string | null
  location?: string | null
  asset_no?: string | null
  serial?: string | null
  notes?: string | null
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
  /** Last status change — while an order is `accepted`, this is when it was. */
  updated_at: string
  fulfilled_by: string | null
  fulfilled_at: string | null
  /** When the guest was told it would be ready. NULL = accepted without one. */
  promised_at: string | null
  player_name: string
  card_uid: string
  items: OrderLine[]
}

export type VatType = 'A' | 'B' | 'V' | 'G'

export interface MenuItem {
  drink_id: number
  name: string
  price_deni: number
  points_price: number
  available: number
  sort_order: number
  /** null = not stock-tracked. 0 = sold out, and not orderable anywhere. */
  stock_qty: number | null
  /** Fiscal VAT band for receipt printing: A=18%, B=5%, V=exempt, G=zero-rated. */
  vat_type: VatType
  /** Whether this drink counts toward turnover from Macedonian producers on the receipt. */
  is_domestic: number
}

export interface ReceiptLine {
  name: string
  quantity: number
  /** Unit price in denars (decimal), VAT-inclusive — same figure the guest is charged. */
  price: number
  vatType: VatType
  isDomestic: boolean
}

export interface Card {
  id: string
  card_uid: string
  player_id: string
  status: 'active' | 'blocked'
  balance_deni: number
  points: number
  created_at: string
  player_name?: string
  /** A card without a PIN cannot pay at the POS. */
  has_pin?: number
}

/** A card as the guest profile sees it — adds the POS lockout state. */
export interface CustomerCard extends Card {
  card_uid_canon: string | null
  has_pin: number
  pin_failed_attempts: number
  pin_locked_until: string | null
}

export interface CustomerListRow {
  id: string
  name: string
  city: string | null
  phone: string | null
  created_at: string
  cards: number
  blocked_cards: number
  balance_deni: number
  points: number
  last_seen: string | null
  tags: string[]
}

/** dob and doc_id are absent unless the signed-in staff member is an admin. */
export interface Player {
  id: string
  name: string
  created_at: string
  updated_at: string | null
  phone: string | null
  email: string | null
  city: string | null
  dob?: string | null
  doc_id?: string | null
}

export interface CustomerStats {
  lifetime_in_deni: number
  lifetime_out_deni: number
  bar_spend_deni: number
  points_earned: number
  adjustments_deni: number
  visits: number
  first_seen: string | null
  last_seen: string | null
  avg_visit_seconds: number | null
}

export interface Hold {
  id: number
  card_id: string
  card_uid: string
  txn: string
  amount_deni: number
  state: 'held' | 'committed' | 'rolledback'
  created_at: string
}

export interface Customer {
  player: Player
  cards: CustomerCard[]
  tags: string[]
  stats: CustomerStats
  holds: Hold[]
  session: { sid: string; opened_at: string; last_activity_at: string } | null
}

export interface TimelineRow extends LedgerEntry {
  card_id: string
  card_uid: string
  session_id: string | null
  order_number: number | null
  order_status: string | null
  order_items: string | null
}

export interface Visit {
  sid: string
  card_id: string
  card_uid: string
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
  duration_seconds: number
  spend_deni: number
  orders: number
}

export interface Note {
  id: number
  player_id: string
  body: string
  author: string
  pinned: number
  created_at: string
}

export interface AuditRow {
  id: number
  actor: string
  action: string
  entity_type: string | null
  entity_id: string | null
  details: string | null
  created_at: string
}

/** A ticket that MIGHT be this guest's — see the confidence field. */
export interface LinkedTicket extends Ticket {
  confidence: 'confirmed' | 'session-window'
}

export interface CustomerPage {
  rows: CustomerListRow[]
  /** Matches for the current filters, before limit/offset. */
  total: number
  limit: number
  offset: number
}

export type OsintReason = 'kyc' | 'aml' | 'self_exclusion' | 'dispute' | 'other'

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

export type PosDirection = 'debit' | 'credit'

export type PosIntentResponse =
  | {
      ok: true
      intentId: string
      player: { name: string; balance: number; points: number }
      totalDeni: number
      totalPoints: number
      pinRequired: boolean
      expiresAt: string
      direction: PosDirection
      chargeType: 'order' | 'custom'
      label: string | null
    }
  | { ok: false; code: string }

export type PosConfirmResponse =
  | { ok: true; orderId: string | null; number: number | null; balanceDeni: number; points: number; direction: PosDirection }
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
  /** `etaMinutes` only bites when accepting; the server fixes the clock. */
  setOrderStatus: (id: string, status: string, etaMinutes?: number) =>
    post<{ order: Order; refunded: boolean }>(`/orders/${id}/status`, {
      status,
      ...(etaMinutes === undefined ? {} : { eta_minutes: etaMinutes })
    }),

  menu: () => req<{ items: MenuItem[]; warning: string | null }>('/menu'),
  createDrink: (item: Partial<MenuItem>) => post<MenuItem>('/menu', item),
  updateDrink: (drinkId: number, patch: Partial<MenuItem>) =>
    req<MenuItem>(`/menu/${drinkId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDrink: (drinkId: number) => req<{ ok: true }>(`/menu/${drinkId}`, { method: 'DELETE' }),
  /** Relative on purpose: the server does the arithmetic, so −/+ cannot race. */
  adjustStock: (drinkId: number, delta: number) => post<MenuItem>(`/menu/${drinkId}/stock`, { delta }),

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
  posCustomIntent: (cardUid: string, amountDeni: number, direction: PosDirection, label?: string) =>
    raw<PosIntentResponse>('/pos/intent', { cardUid, customAmountDeni: amountDeni, direction, label }),
  posConfirm: (intentId: string, pin?: string) =>
    raw<PosConfirmResponse>('/pos/confirm', { intentId, ...(pin ? { pin } : {}) }),
  /**
   * Renders a fiscal receipt as a PNG. Returns the image itself rather than
   * JSON, so this bypasses req/post and reads the response as a Blob.
   */
  receiptImage: async (
    items: ReceiptLine[],
    payMethod: 'cash' | 'points',
    orderId: string
  ): Promise<{ blob: Blob; number: string | null }> => {
    const res = await fetch('/api/pos/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, payMethod, orderId })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(body.error ?? `receipt failed (${res.status})`, res.status)
    }
    // The server allocates the daily number; it comes back in a header so the done
    // screen can name the receipt without asking for it separately.
    return { blob: await res.blob(), number: res.headers.get('X-Receipt-Number') }
  },

  tickets: (status?: string) => req<Ticket[]>(`/tickets${status ? `?status=${status}` : ''}`),
  issueTicket: (amountDeni: number) => post<Ticket>('/tickets', { amountDeni }),
  voidTicket: (id: string) => post<{ ticket: Ticket }>(`/tickets/${id}/void`),

  summary: () => req<Summary>('/reports/summary'),

  // The guest profile fetches per tab rather than in one blob, so opening a
  // dossier costs one request and each tab pays only for itself.
  customers: (q: {
    q?: string
    tag?: string
    sort?: string
    limit?: number
    offset?: number
  } = {}) => req<CustomerPage>(`/customers${qs(q)}`),
  customer: (id: string) => req<Customer>(`/customers/${id}`),
  updateCustomer: (id: string, patch: Partial<Player>) =>
    req<{ player: Player; changed: string[] }>(`/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }),
  timeline: (id: string, q: { type?: string; from?: string; to?: string; limit?: number; before?: number } = {}) =>
    req<TimelineRow[]>(`/customers/${id}/timeline${qs(q)}`),
  customerOrders: (id: string) => req<Order[]>(`/customers/${id}/orders`),
  visits: (id: string, q: { limit?: number; offset?: number } = {}) =>
    req<Visit[]>(`/customers/${id}/sessions${qs(q)}`),
  customerTickets: (id: string) => req<LinkedTicket[]>(`/customers/${id}/tickets`),
  customerAudit: (id: string) => req<AuditRow[]>(`/customers/${id}/audit`),

  notes: (id: string) => req<Note[]>(`/customers/${id}/notes`),
  addNote: (id: string, body: string) => post<{ note: Note }>(`/customers/${id}/notes`, { body }),
  pinNote: (id: string, noteId: number, pinned: boolean) =>
    post<{ ok: true }>(`/customers/${id}/notes/${noteId}/pin`, { pinned }),
  deleteNote: (id: string, noteId: number) =>
    req<{ ok: true }>(`/customers/${id}/notes/${noteId}`, { method: 'DELETE' }),

  addTag: (id: string, tag: string) => post<{ tags: string[] }>(`/customers/${id}/tags`, { tag }),
  removeTag: (id: string, tag: string) =>
    req<{ tags: string[] }>(`/customers/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  /**
   * Logs that a public source was opened about this guest. The server fetches
   * nothing — this exists purely so the lookup is accountable.
   */
  osintLookup: (id: string, source: string, reason: OsintReason) =>
    post<{ ok: true }>(`/customers/${id}/osint-lookup`, { source, reason }),

  registerCardFor: (cardUid: string, playerId: string, pin?: string) =>
    post<{ card: Card }>('/cards', { cardUid, playerId, ...(pin ? { pin } : {}) }),
  dismissTap: (cardUid: string) =>
    req<{ ok: true }>(`/unknown-taps/${encodeURIComponent(cardUid)}`, { method: 'DELETE' }),

  machines: () => req<{ machines: Machine[] }>('/machines'),
  machineLinks: () => req<{ links: TerminalLink[] }>('/machines/links'),
  machine: (id: string) => req<Machine>(`/machines/${id}`),
  machineSessions: (id: string) => req<{ sessions: MachineSession[] }>(`/machines/${id}/sessions`),
  machineOrders: (id: string) => req<{ orders: MachineOrder[] }>(`/machines/${id}/orders`),
  machineTickets: (id: string) => req<{ tickets: MachineTicket[] }>(`/machines/${id}/tickets`),
  createMachine: (body: MachineInput) => post<Machine>('/machines', body),
  /** Host and device id come from the socket, so they cannot be mistyped. */
  adoptMachine: (connId: string, body: Omit<MachineInput, 'host' | 'device_id'>) =>
    post<Machine>('/machines/adopt', { connId, ...body }),
  updateMachine: (id: string, patch: Partial<MachineInput>) =>
    req<Machine>(`/machines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setMachineStatus: (id: string, status: Machine['status']) =>
    post<Machine>(`/machines/${id}/status`, { status }),
  logoutMachine: (id: string) => post<{ ok: true; sessions: number }>(`/machines/${id}/logout`),
  dropMachineLink: (id: string) => post<{ ok: boolean }>(`/machines/${id}/drop`),

  users: () => req<{ users: StaffAccount[] }>('/users'),
  createUser: (body: { username: string; password: string; role: StaffRole }) =>
    post<StaffAccount>('/users', body),
  updateUser: (id: string, patch: { username?: string; role?: StaffRole; active?: boolean }) =>
    req<StaffAccount>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setUserPassword: (id: string, password: string) =>
    post<{ ok: true }>(`/users/${id}/password`, { password }),
  /** The one user route open to every role — the bar tablet included. */
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/me/password', {
      current_password: currentPassword,
      new_password: newPassword
    })
}

/** Drops empty values so a blank search box doesn't become `?q=`. */
function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== '' && v !== null
  )
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : ''
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
