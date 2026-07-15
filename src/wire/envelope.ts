import { MAX_ERR_CODE_LEN, MAX_ERR_MSG_BYTES, truncateUtf8 } from './limits.js'

/**
 * The CMS envelope. Fixed by the firmware (main/cms/cms.c reads these keys with
 * cJSON_GetObjectItem by exact name) — never rename a field.
 */
export interface InMessage {
  t: string
  id: number
  d: Record<string, any>
}

export interface OutMessage {
  t: string
  id: number
  d: Record<string, any>
}

export interface WireError {
  code: string
  /** Macedonian — the firmware shows this straight in a toast. */
  msg: string
}

/**
 * Error catalogue, matching tools/host_sim/cms_server.py so the terminal keeps
 * showing the wording players already see.
 */
export const ERRORS = {
  unknown_card: { code: 'unknown_card', msg: 'Непозната картичка' },
  insufficient_funds: { code: 'insufficient', msg: 'Недоволно средства' },
  insufficient_points: { code: 'insufficient', msg: 'Недоволно поени' },
  denied: { code: 'denied', msg: 'Одбиено од системот' },
  unknown_txn: { code: 'unknown_txn', msg: 'Непозната трансакција' },
  conflict: { code: 'conflict', msg: 'Трансакцијата е поништена' },
  empty: { code: 'empty', msg: 'Празна нарачка' },
  no_session: { code: 'denied', msg: 'Сесијата е истечена' }
} as const satisfies Record<string, WireError>

export function reply(t: string, id: number, fields: Record<string, any> = {}): OutMessage {
  return { t, id, d: { ok: true, ...fields } }
}

/** Clamps err to the firmware's fixed buffers so nothing is silently truncated mid-character. */
export function failure(
  t: string,
  id: number,
  error: WireError,
  fields: Record<string, any> = {}
): OutMessage {
  return {
    t,
    id,
    d: {
      ok: false,
      ...fields,
      err: {
        code: error.code.slice(0, MAX_ERR_CODE_LEN),
        msg: truncateUtf8(error.msg, MAX_ERR_MSG_BYTES)
      }
    }
  }
}

export function encode(msg: OutMessage): Buffer {
  return Buffer.from(JSON.stringify(msg), 'utf8')
}

export function decode(payload: Buffer): InMessage | null {
  try {
    const parsed = JSON.parse(payload.toString('utf8'))
    if (!parsed || typeof parsed.t !== 'string') return null
    return {
      t: parsed.t,
      id: typeof parsed.id === 'number' ? parsed.id : 0,
      d: parsed.d && typeof parsed.d === 'object' ? parsed.d : {}
    }
  } catch {
    return null
  }
}
