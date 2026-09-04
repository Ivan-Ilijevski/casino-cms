/**
 * Web NFC — the only way a browser can read a card, and Chrome-on-Android only.
 *
 * Constraints that shape this file:
 *  - `NDEFReader` exists only in Chrome for Android. Everything else must be told
 *    plainly, not handed a button that does nothing.
 *  - It reads NFC Forum Type 1-5 tags. Our NTAG21x cards qualify; MIFARE Classic
 *    would never fire a reading event at all.
 *  - `scan()` needs a secure context. http://<lan-ip> is not one — see the README
 *    for the Chrome insecure-origin flag used in dev.
 *  - `scan()` must be called from a user gesture, so arming is an explicit tap.
 *
 * serialNumber comes back lowercase and colon-separated ("9c:76:5a:f4"); the
 * server canonicalises it against the RC522's "9C 76 5A F4".
 */

interface NDEFReadingEvent extends Event {
  serialNumber: string
}

interface NDEFReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>
  onreading: ((event: NDEFReadingEvent) => void) | null
  onreadingerror: ((event: Event) => void) | null
}

declare global {
  interface Window {
    NDEFReader?: new () => NDEFReaderLike
  }
}

export type NfcSupport =
  | { supported: true }
  | { supported: false; reason: 'no-api' | 'insecure-context' }

export function checkNfcSupport(): NfcSupport {
  if (!('NDEFReader' in window)) return { supported: false, reason: 'no-api' }
  // scan() rejects outside a secure context; catch it up front rather than at tap.
  if (!window.isSecureContext) return { supported: false, reason: 'insecure-context' }
  return { supported: true }
}

export class NfcScanError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'unsupported' | 'read-failed' | 'other'
  ) {
    super(message)
  }
}

/**
 * Arms the reader and resolves with the first card's serial number.
 * Call from a user gesture. Abort via the signal to stop scanning.
 */
export function readCardUid(signal: AbortSignal): Promise<string> {
  const Reader = window.NDEFReader
  if (!Reader) {
    return Promise.reject(new NfcScanError('Web NFC is not available', 'unsupported'))
  }

  const reader = new Reader()

  return new Promise<string>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new NfcScanError('cancelled', 'other')), {
      once: true
    })

    reader.onreading = (event) => resolve(event.serialNumber)
    reader.onreadingerror = () =>
      reject(new NfcScanError('Картичката не се прочита', 'read-failed'))

    reader.scan({ signal }).catch((err: unknown) => {
      const name = (err as { name?: string })?.name
      if (name === 'NotAllowedError') {
        reject(new NfcScanError('Дозволата за NFC е одбиена', 'denied'))
      } else if (name === 'NotSupportedError') {
        reject(new NfcScanError('NFC не е достапен на овој уред', 'unsupported'))
      } else if (name !== 'AbortError') {
        reject(new NfcScanError(String((err as Error)?.message ?? err), 'other'))
      }
    })
  })
}
