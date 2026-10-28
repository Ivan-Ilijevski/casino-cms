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
  /**
   * IANA zone the venue sits in. The fiscal day ends at midnight *here*: receipt
   * numbers restart at 0001 on each local day, while the database itself stays UTC.
   * Deployment-wide rather than receipt-specific, because where the day ends is a
   * property of the venue — /reports will want the same value.
   */
  timeZone: string
  /** Origin of the external fiscal receipt-render service, e.g. https://your-app.vercel.app. */
  receiptApiUrl: string
  /** x-api-key it expects. Empty = receipt printing fails closed (503). */
  receiptApiKey: string
  /**
   * The legal entity and address printed in the fiscal receipt's header. The render
   * API fills anything it isn't sent from its own demo preset, so leaving these unset
   * prints someone else's company on our receipts — set them for any real deployment.
   */
  receiptStoreName: string
  receiptAddress: string
  /**
   * AI screening on the guest Истражување tab runs the locally installed CLIs
   * headless, on this host's own `claude login` / `codex login`. Empty disables
   * that engine; a binary that is not on PATH shows as unavailable in the UI.
   */
  osintClaudeBin: string
  osintCodexBin: string
  /** Passed as --model. Empty lets the CLI pick its own default. */
  osintClaudeModel: string
  osintCodexModel: string
  /** A run that has not answered by then is killed and recorded as failed. */
  osintTimeoutMs: number
  /** Claude's --max-budget-usd per engine run. Codex has no equivalent flag. */
  osintClaudeMaxUsd: number
  /** The same two limits for a general profile, which searches far wider than a screening. */
  osintProfileTimeoutMs: number
  osintProfileClaudeMaxUsd: number
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
  timeZone: 'Europe/Skopje',
  receiptApiUrl: '',
  receiptApiKey: '',
  receiptStoreName: 'РОЈАЛ КЛУБ ЗЕЛЕНЕЗБУРГ Д.О.О.',
  receiptAddress: 'УЛ. 2 ББ ЗЕЛЕНИКОВО',
  osintClaudeBin: 'claude',
  osintCodexBin: 'codex',
  osintClaudeModel: 'haiku',
  osintCodexModel: '',
  osintTimeoutMs: 8 * 60 * 1000,
  osintClaudeMaxUsd: 2,
  osintProfileTimeoutMs: 15 * 60 * 1000,
  osintProfileClaudeMaxUsd: 5
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(raw)}`)
  return n
}

/**
 * Fails at boot rather than at the first sale of the night. ICU throws RangeError for a
 * zone it cannot resolve, which also catches a Node built without the tzdata this needs —
 * either way a typo must not quietly become receipts numbered on the wrong day.
 */
function zone(raw: string | undefined, fallback: string): string {
  const tz = raw === undefined || raw.trim() === '' ? fallback : raw.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`expected an IANA time zone, got ${JSON.stringify(tz)}`)
  }
  return tz
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
    timeZone: zone(env.CMS_TIME_ZONE, DEFAULT_CONFIG.timeZone),
    receiptApiUrl: env.CMS_RECEIPT_API_URL ?? DEFAULT_CONFIG.receiptApiUrl,
    receiptApiKey: env.CMS_RECEIPT_API_KEY ?? DEFAULT_CONFIG.receiptApiKey,
    receiptStoreName: env.CMS_RECEIPT_STORE_NAME ?? DEFAULT_CONFIG.receiptStoreName,
    receiptAddress: env.CMS_RECEIPT_ADDRESS ?? DEFAULT_CONFIG.receiptAddress,
    osintClaudeBin: (env.CMS_OSINT_CLAUDE_BIN ?? DEFAULT_CONFIG.osintClaudeBin).trim(),
    osintCodexBin: (env.CMS_OSINT_CODEX_BIN ?? DEFAULT_CONFIG.osintCodexBin).trim(),
    osintClaudeModel: (env.CMS_OSINT_CLAUDE_MODEL ?? DEFAULT_CONFIG.osintClaudeModel).trim(),
    osintCodexModel: (env.CMS_OSINT_CODEX_MODEL ?? DEFAULT_CONFIG.osintCodexModel).trim(),
    osintTimeoutMs: num(env.CMS_OSINT_TIMEOUT_MS, DEFAULT_CONFIG.osintTimeoutMs),
    osintClaudeMaxUsd: num(env.CMS_OSINT_CLAUDE_MAX_USD, DEFAULT_CONFIG.osintClaudeMaxUsd),
    osintProfileTimeoutMs: num(env.CMS_OSINT_PROFILE_TIMEOUT_MS, DEFAULT_CONFIG.osintProfileTimeoutMs),
    osintProfileClaudeMaxUsd: num(env.CMS_OSINT_PROFILE_CLAUDE_MAX_USD, DEFAULT_CONFIG.osintProfileClaudeMaxUsd)
  }
}
