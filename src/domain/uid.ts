/**
 * Card UIDs arrive in two spellings from two readers:
 *
 *   RC522 terminal  "9C 76 5A F4"   uppercase, space-separated (rc522_helpers.c: "%02X ")
 *   Web NFC/Chrome  "9c:76:5a:f4"   lowercase, colon-separated (NDEFReadingEvent.serialNumber)
 *
 * Same physical card, two strings. Everything matches on the canonical form, so
 * a card registered at one reader is found by the other.
 */

/**
 * Whole hex bytes, 2..10 of them (RC522_PICC_UID_SIZE_MAX is 10).
 *
 * Real ISO14443-A uids are 4, 7 or 10 bytes, but this deliberately accepts
 * shorter: the firmware's own golden vectors use "AA BB", and length is not the
 * security boundary — matching a registered card is. Being stricter would only
 * risk rejecting a real card for no gain.
 */
const CANON = /^([0-9A-F]{2}){2,10}$/

export function canonUid(raw: string): string {
  const canon = String(raw ?? '')
    .replace(/[\s:.\-_]/g, '')
    .toUpperCase()
  if (!CANON.test(canon)) {
    throw new Error(`not a plausible card uid: ${JSON.stringify(raw)}`)
  }
  return canon
}

/** Canonicalises without throwing — for untrusted input off the wire. */
export function tryCanonUid(raw: string): string | null {
  try {
    return canonUid(raw)
  } catch {
    return null
  }
}
