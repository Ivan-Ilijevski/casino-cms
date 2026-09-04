import { useEffect, useRef } from 'react'

/**
 * The staff app's first real modal.
 *
 * Everything money-touching used to run through native prompt() — two
 * sequential prompts for an adjustment, no validation, no way to show the
 * resulting balance before committing, and no cancel that means anything.
 *
 * Built on <dialog> so focus trapping, the top layer and Esc come from the
 * platform rather than from a scroll-lock hack.
 */
export function Dialog({
  title,
  sub,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  sub?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      // Esc fires `cancel`, and the backdrop click lands on the dialog itself.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        {/*
          Implicit submission (Enter in a text field) activates the FIRST submit
          button in tree order, and a <button> with no `type` inside a form IS
          one. Without this, Enter in the correction dialog's amount field hit
          the unit toggle and silently switched денари→поени on a typed number.
          This absorbs the keypress into a handler that does nothing; the buttons
          below still carry explicit types so the intent is readable.
        */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <div className="dialog-head">
          <div>
            <h3>{title}</h3>
            {sub && <p className="muted">{sub}</p>}
          </div>
          <button type="button" className="ghost dialog-x" aria-label="Затвори" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </form>
    </dialog>
  )
}

/** Destructive confirm. Block/unblock used to run with no confirmation at all. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            type="button"
            className={danger ? 'danger solid' : 'gold'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Се извршува…' : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}
