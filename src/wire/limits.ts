/**
 * Hard limits imposed by the SMIB firmware. These are not style choices — the
 * firmware copies our JSON into fixed C buffers with snprintf, so anything
 * longer is silently TRUNCATED (a truncated sid makes every later debit fail).
 *
 * Source of truth: main/cms/cms_types.h and main/cms/cms.c.
 */

/** char sid[24] in player_info_t → 23 usable chars + NUL. */
export const MAX_SID_LEN = 23

/** char txn[24] in cms.c → 23 usable chars + NUL. Firmware sends "SMIB-%06u". */
export const MAX_TXN_LEN = 23

/** char name[64] in player_info_t. Bytes, not chars — Cyrillic is 2 bytes/char in UTF-8. */
export const MAX_PLAYER_NAME_BYTES = 63

/** char cur[8] in player_info_t. */
export const MAX_CURRENCY_BYTES = 7

/** char err_code[24] in cms_event_t. */
export const MAX_ERR_CODE_LEN = 23

/** char err_msg[96] in cms_event_t — Macedonian text shown straight in a toast. */
export const MAX_ERR_MSG_BYTES = 95

/** char name[48] in cms_menu_item_t. Bytes, not chars. */
export const MAX_MENU_NAME_BYTES = 47

/**
 * CMS_MENU_MAX_ITEMS in cms_types.h. The firmware's parse_menu() stops reading
 * at 16 items, so anything beyond that is invisible at the terminal. We cap
 * menu_res ourselves rather than let items vanish silently.
 */
export const MAX_MENU_ITEMS = 16

/** CMS_REQUEST_TIMEOUT_US in cms.c. Replies later than this surface as err "timeout". */
export const REQUEST_TIMEOUT_MS = 3000

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Truncates on a UTF-8 character boundary so we never emit a broken code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const size = utf8Bytes(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}
