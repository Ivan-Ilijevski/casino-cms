/**
 * Fullscreen — the in-app way to get the bars off the screen.
 *
 * The manifest already asks for `display: "fullscreen"`, but that only applies to
 * an *installed* app, and Chrome will not offer the install through the ngrok free
 * tier (its interstitial answers /manifest.webmanifest and /sw.js with HTML). This
 * is the route that works in a plain tab, on any origin, with nothing installed.
 *
 * Constraints that shape this file:
 *  - requestFullscreen() only works from a user gesture. It cannot be called on
 *    load, which is the whole reason armFullscreenRestore() exists.
 *  - Fullscreen is a property of the *document*, so it survives SPA route changes
 *    but never a reload. On a POS terminal that would otherwise mean re-enabling
 *    it by hand after every refresh.
 *  - Safari on iPad still ships only the webkit-prefixed calls.
 *  - localStorage throws outright in some privacy modes; a blocked store must
 *    degrade to "not remembered", never break the page.
 */

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

interface FullscreenRoot extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

const doc = () => document as FullscreenDocument
const root = () => document.documentElement as FullscreenRoot

const KEY = 'cms.fullscreen'

export function fullscreenSupported(): boolean {
  const el = root()
  return (
    typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
  )
}

export function isFullscreen(): boolean {
  const d = doc()
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement)
}

export async function enterFullscreen(): Promise<void> {
  const el = root()
  try {
    if (typeof el.requestFullscreen === 'function') {
      // navigationUI: 'hide' is what drops Android's nav bar as well as Chrome's.
      await el.requestFullscreen({ navigationUI: 'hide' })
    } else {
      await el.webkitRequestFullscreen?.()
    }
  } catch {
    // The browser may refuse — no gesture, a permissions policy, a user setting.
    // There is nothing to report: the button re-syncs from fullscreenchange.
  }
}

export async function exitFullscreen(): Promise<void> {
  const d = doc()
  try {
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
    else await d.webkitExitFullscreen?.()
  } catch {
    // Already out, or the document lost its fullscreen element under us.
  }
}

export function fullscreenWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function rememberFullscreen(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Site data blocked. The toggle still works, it just won't survive a reload.
  }
}

/**
 * A reload always drops fullscreen and the API cannot ask for it back on its own,
 * so the preference is redeemed on the first tap the page receives.
 *
 * Harmless if that first tap happens to be the Settings toggle: the toggle acts on
 * the user's *intention* (the label they pressed) rather than on the live document
 * state, so both paths agree on "enter" and the second call is a no-op.
 */
export function armFullscreenRestore(): void {
  if (!fullscreenSupported() || !fullscreenWanted() || isFullscreen()) return

  window.addEventListener(
    'pointerdown',
    () => {
      if (fullscreenWanted() && !isFullscreen()) void enterFullscreen()
    },
    { once: true }
  )
}

export type DisplayMode = 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser'

/**
 * How the app is running right now — installed, fullscreen, or just a tab.
 *
 * The `display-mode` media feature reports how the app was *launched*, and stays
 * `browser` for a tab that entered fullscreen through the API — so element
 * fullscreen has to be asked about separately, or the status line would tell a
 * fullscreen terminal it is running in a browser tab.
 */
export function displayMode(): DisplayMode {
  if (isFullscreen()) return 'fullscreen'
  for (const mode of ['fullscreen', 'standalone', 'minimal-ui'] as const) {
    if (window.matchMedia(`(display-mode: ${mode})`).matches) return mode
  }
  return 'browser'
}
