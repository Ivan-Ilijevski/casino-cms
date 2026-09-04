import { useEffect, useState } from 'react'

/**
 * The one breakpoint the layout has, mirrored from styles.css where `.split`
 * collapses to a single column. Kept in a constant so the CSS and the JS that
 * has to agree with it are one grep apart.
 */
export const MOBILE_QUERY = '(max-width: 900px)'

/**
 * True while the viewport is phone-width.
 *
 * Only for layouts CSS alone cannot express — the menu form has to be a side
 * panel on desktop and a modal on mobile, and those are different trees, not
 * one tree with different styling. Anything CSS can do belongs in styles.css.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    // The viewport can have crossed the breakpoint between the initial state
    // and this effect (a rotation during hydration), so resync once.
    setIsMobile(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
