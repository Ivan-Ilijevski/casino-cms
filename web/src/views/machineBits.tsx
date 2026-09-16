import type { LinkState } from '../api'

/** The states the server reports, in the venue's language. */
export const LINK_STATE_MK: Record<LinkState, string> = {
  online: 'онлајн',
  silent: 'без сигнал',
  offline: 'офлајн'
}

/**
 * Link state as a dot plus a word.
 *
 * "Без сигнал" is its own state on purpose: the socket is still open, the
 * terminal has simply stopped pinging. The firmware calls its own link down
 * after 6 s of silence, so showing that as "онлајн" would contradict what the
 * cabinet itself believes.
 *
 * A machine that is out of service reads as parked whatever the socket does —
 * it is not a fault, and colouring it like one is how a real fault gets missed.
 */
export function MachineDot({ state, parked }: { state: LinkState; parked?: boolean }) {
  if (parked) {
    return (
      <span className="m-state parked">
        <span className="m-dot" />
        вон употреба
      </span>
    )
  }
  return (
    <span className={`m-state ${state}`}>
      <span className="m-dot" />
      {LINK_STATE_MK[state]}
    </span>
  )
}

/** Why a card session ended, as CloseReason spells it on the server. */
export const CLOSE_REASON_MK: Record<string, string> = {
  cashout: 'исплата',
  inactivity: 'неактивност',
  logout_push: 'одјавен од персонал',
  replaced: 'нова сесија',
  blocked: 'блокирана картичка'
}
