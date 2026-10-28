import { useState } from 'react'
import { api, type OsintPhotoMeta } from '../../api'
import { fmtDateTime } from '../../format'

interface Props {
  playerId: string
  photo: OsintPhotoMeta | null
  onChanged: () => Promise<void>
}

/**
 * Re-encodes the photo at most 1280 px on the long side before it leaves the
 * browser. A phone's camera file is often over the server's 5 MB cap, and it
 * carries EXIF — GPS coordinates included — which a canvas re-encode drops.
 * Face comparison needs nothing like the full resolution.
 */
async function prepare(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('фотографијата не може да се обработи'))), 'image/jpeg', 0.9)
  )
}

/**
 * The guest's reference photo, used for one thing: comparing faces against the
 * photos a profile run found. Face comparison is biometric processing, so the
 * photo cannot be saved without the admin confirming the guest agreed — and
 * the server refuses it too, and records who confirmed.
 *
 * The file input with `capture` opens the camera on a tablet or phone, and
 * unlike getUserMedia it needs no secure context, so it works over plain LAN http.
 */
export function GuestPhoto({ playerId, photo, onChanged }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [consent, setConsent] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function upload() {
    if (!file || !consent) return
    setBusy(true)
    setErr('')
    try {
      await api.uploadGuestPhoto(playerId, await prepare(file), true)
      setFile(null)
      setConsent(false)
      setReplacing(false)
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Да се избрише фотографијата на гостинот? Споредбата на лица нема да биде можна.')) return
    setBusy(true)
    setErr('')
    try {
      await api.deleteGuestPhoto(playerId)
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const showForm = !photo || replacing

  return (
    <div className="card osint-guest-photo">
      <div className="osint-guest-photo-body">
        {photo && !replacing && (
          <img className="osint-guest-photo-img" src={api.guestPhotoSrc(playerId, photo.sha256)} alt="Фотографија на гостинот" />
        )}
        <div className="osint-guest-photo-text">
          <h4>Фотографија на гостинот</h4>
          {photo && !replacing ? (
            <>
              <p className="muted">
                Се користи само за споредба на лица со фотографиите пронајдени во „Општ профил“. Споредбата се прави
                локално во прелистувачот.
              </p>
              <p className="muted">
                Согласност потврдил <strong>{photo.consent_by}</strong> · {fmtDateTime(photo.consent_at)}
              </p>
              <div className="osint-actions">
                <button type="button" disabled={busy} onClick={() => setReplacing(true)}>
                  Замени
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                  Избриши
                </button>
              </div>
            </>
          ) : (
            <p className="muted">
              Потребна за автоматска споредба на лица. Без неа, фотографиите од профилот се прикажуваат без споредба.
            </p>
          )}
        </div>
      </div>

      {showForm && (
        <div className="osint-guest-photo-form">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <label className="osint-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              Гостинот се согласи неговата фотографија да се чува и да се користи за споредба со јавно пронајдени
              фотографии.
            </span>
          </label>
          <div className="osint-actions">
            <button type="button" className="gold" disabled={!file || !consent || busy} onClick={() => void upload()}>
              {busy ? 'Се зачувува…' : 'Зачувај фотографија'}
            </button>
            {replacing && (
              <button type="button" className="ghost" disabled={busy} onClick={() => setReplacing(false)}>
                Откажи
              </button>
            )}
          </div>
        </div>
      )}

      {err && <div className="err">{err}</div>}
    </div>
  )
}
