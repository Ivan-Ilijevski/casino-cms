/**
 * Web Share API — hands a file to whatever the OS share sheet offers, which on
 * the POS tablet is a Bluetooth thermal-printer app. Chrome on Android is the
 * only environment this whole POS flow runs in (see checkNfcSupport in
 * webnfc.ts), and that is also where navigator.share with files is supported.
 *
 * navigator.share() requires a recent user gesture ("transient activation").
 * Called straight from a click it works; called after a couple of chained
 * network requests it can throw NotAllowedError even though nothing is
 * actually wrong — the caller is expected to fall back to a manual retry
 * button, whose own click is a fresh gesture.
 */

export function canShareFiles(files: File[]): boolean {
  return typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files })
}

/** Resolves false rather than throwing on refusal — the caller decides what to show. */
export async function shareFile(file: File, title?: string): Promise<boolean> {
  if (!canShareFiles([file])) return false
  try {
    await navigator.share({ files: [file], title })
    return true
  } catch {
    return false // AbortError (dismissed) or NotAllowedError (stale gesture)
  }
}
