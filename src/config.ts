export interface Config {
  dbPath: string
  /** SMIB firmware mux/JSON protocol. Replaces tools/host_sim/cms_server.py. */
  tcpPort: number
  /** Legacy voucher API. Replaces voucher-server.js; the slot game hardcodes 8080. */
  voucherPort: number
  /** Staff web app + its API/SSE. */
  httpPort: number
  /** x-api-key value the legacy /generate endpoint requires. */
  voucherApiKey: string
  sessionSecret: string
  /**
   * Loyalty points per whole MKD awarded on debit_commit.
   * points = floor(amount_deni * pointsPerMkd / 100) — integer maths, no float drift.
   * 0 disables earning (and is what the golden protocol vectors run with, since the
   * Python prototype never awarded points on commit).
   */
  pointsPerMkd: number
  /** Server-side idle logout for terminal sessions. */
  sessionIdleMs: number
  /** null = tickets never expire, matching the legacy voucher server. */
  ticketExpiryDays: number | null
  currency: string
  /** Origin of the external fiscal receipt-render service, e.g. https://your-app.vercel.app. */
  receiptApiUrl: string
  /** x-api-key it expects. Empty = receipt printing fails closed (503). */
  receiptApiKey: string
}

export const DEFAULT_CONFIG: Config = {
  dbPath: './data/cms.sqlite',
  tcpPort: 9020,
  voucherPort: 8080,
  httpPort: 8090,
  voucherApiKey: 'ivan1507',
  sessionSecret: 'change-me-in-production',
  pointsPerMkd: 1,
  sessionIdleMs: 5 * 60 * 1000,
  ticketExpiryDays: null,
  currency: 'MKD',
  receiptApiUrl: '',
  receiptApiKey: ''
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(raw)}`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const expiry = env.CMS_TICKET_EXPIRY_DAYS
  return {
    dbPath: env.CMS_DB_PATH ?? DEFAULT_CONFIG.dbPath,
    tcpPort: num(env.CMS_TCP_PORT, DEFAULT_CONFIG.tcpPort),
    voucherPort: num(env.CMS_VOUCHER_PORT, DEFAULT_CONFIG.voucherPort),
    httpPort: num(env.CMS_HTTP_PORT, DEFAULT_CONFIG.httpPort),
    voucherApiKey: env.CMS_VOUCHER_API_KEY ?? DEFAULT_CONFIG.voucherApiKey,
    sessionSecret: env.CMS_SESSION_SECRET ?? DEFAULT_CONFIG.sessionSecret,
    pointsPerMkd: num(env.CMS_POINTS_PER_MKD, DEFAULT_CONFIG.pointsPerMkd),
    sessionIdleMs: num(env.CMS_SESSION_IDLE_MS, DEFAULT_CONFIG.sessionIdleMs),
    ticketExpiryDays: expiry === undefined || expiry.trim() === '' ? null : num(expiry, 0),
    currency: env.CMS_CURRENCY ?? DEFAULT_CONFIG.currency,
    receiptApiUrl: env.CMS_RECEIPT_API_URL ?? DEFAULT_CONFIG.receiptApiUrl,
    receiptApiKey: env.CMS_RECEIPT_API_KEY ?? DEFAULT_CONFIG.receiptApiKey
  }
}
