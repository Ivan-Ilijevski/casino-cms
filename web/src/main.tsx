import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { armFullscreenRestore } from './fullscreen'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// A reload always drops fullscreen, and the API refuses to re-enter without a
// gesture — so the stored preference is redeemed on the page's first tap.
armFullscreenRestore()

// The PWA is disabled for now — see the comment in index.html for why. Unlinking
// the manifest there is what withdraws the install prompt; this is the other half.
//
// It is a teardown rather than a deleted registration on purpose: a worker outlives
// the code that registered it, so every browser that already visited would go on
// running the old sw.js indefinitely. Devices are swept on their next load instead.
// Only caches this app created are removed, so nothing else on the origin is touched.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {})
}

if ('caches' in window) {
  void caches
    .keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cms-')).map((k) => caches.delete(k))))
    .catch(() => {})
}
