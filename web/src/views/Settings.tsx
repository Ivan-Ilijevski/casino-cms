import { useEffect, useState } from 'react'
import {
  displayMode,
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  rememberFullscreen,
  type DisplayMode
} from '../fullscreen'

const MODE_MK: Record<DisplayMode, string> = {
  fullscreen: 'на цел екран',
  standalone: 'како инсталирана апликација',
  'minimal-ui': 'како инсталирана апликација',
  browser: 'во картичка на прелистувачот'
}

export function Settings() {
  const supported = fullscreenSupported()
  const [on, setOn] = useState(isFullscreen)
  const [mode, setMode] = useState<DisplayMode>(displayMode)

  // Esc and the Android back gesture leave fullscreen without touching the button,
  // so the label is driven by the document rather than by what was last pressed.
  useEffect(() => {
    const sync = () => {
      setOn(isFullscreen())
      setMode(displayMode())
    }
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // Acts on the label the user pressed, not on the live document state — see the
  // note on armFullscreenRestore() about the first tap after a reload.
  async function toggle() {
    const next = !on
    rememberFullscreen(next)
    await (next ? enterFullscreen() : exitFullscreen())
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Поставки</h2>
          <p>Поставки за овој уред. Не влијаат на другите уреди.</p>
        </div>
      </div>

      <div className="card settings-card">
        <div className="settings-row">
          <div>
            <h3>Цел екран</h3>
            <p className="muted">
              Ги крие лентите на прелистувачот и на уредот. Изборот се памети — по
              освежување на страницата се враќа на првиот допир.
            </p>
          </div>
          {supported ? (
            <button className={on ? 'ghost' : 'gold'} onClick={toggle}>
              {on ? 'Излези од цел екран' : 'Влези во цел екран'}
            </button>
          ) : (
            <div className="muted">Овој прелистувач не поддржува цел екран.</div>
          )}
        </div>

        <div className="settings-status muted">
          Апликацијата работи <strong>{MODE_MK[mode]}</strong>.
        </div>
      </div>
    </>
  )
}
