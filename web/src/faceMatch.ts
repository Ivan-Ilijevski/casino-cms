import type { OsintFaceVerdict } from './api'

/**
 * 1:1 face comparison between the guest's consented reference photo and the
 * photos a profile run downloaded — nothing else.
 *
 * It runs here, in the admin's browser, on images the CMS itself serves, so no
 * face leaves the building and no third party sees one. Face descriptors live
 * only in this function's memory; what goes back to the server is the verdict
 * and the distance. The server serves only the detector, landmark and
 * recognition models, so age, gender or expression cannot be inferred even by
 * accident.
 *
 * The result is a similarity estimate from one model, not an identification.
 * Poor light, sunglasses, age gaps and group photos all move the distance.
 */

type FaceApi = typeof import('@vladmandic/face-api')

const MODEL_URI = '/api/face-models'

/**
 * Euclidean distance between 128-d descriptors. The library's own "same
 * person" cut-off is 0.6; these bands are stricter so "Исто лице" is not
 * handed out on a family resemblance.
 */
export const MATCH_BELOW = 0.45
export const POSSIBLE_BELOW = 0.55

let loading: Promise<FaceApi> | null = null

/** Lazy: the ~1.3 MB library and ~12 MB of weights load only when a comparison actually runs. */
export function loadFaceApi(): Promise<FaceApi> {
  loading ??= (async () => {
    const faceapi = await import('@vladmandic/face-api')
    // The bundled TensorFlow.js has ready(); face-api's trimmed `tf` typings just omit it.
    await (faceapi.tf as unknown as { ready: () => Promise<void> }).ready()
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URI),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URI),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URI)
    ])
    return faceapi
  })().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  await img.decode()
  return img
}

async function describe(faceapi: FaceApi, src: string) {
  const img = await loadImage(src)
  return faceapi
    .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors()
}

export interface FaceComparison {
  imageId: number
  verdict: OsintFaceVerdict
  distance: number | null
  faces: number
}

export class FaceMatchError extends Error {}

export function verdictFor(distance: number): OsintFaceVerdict {
  return distance < MATCH_BELOW ? 'match' : distance < POSSIBLE_BELOW ? 'possible' : 'different'
}

/**
 * The reference uses its largest face (the guest, not someone behind them).
 * A candidate with several faces — a team photo — is scored by its closest face.
 */
export async function compareFaces(
  referenceSrc: string,
  candidates: Array<{ imageId: number; src: string }>,
  onProgress?: (done: number, total: number) => void
): Promise<FaceComparison[]> {
  const faceapi = await loadFaceApi()

  const refFaces = await describe(faceapi, referenceSrc)
  const reference = refFaces.reduce<(typeof refFaces)[number] | null>(
    (best, f) => (!best || f.detection.box.area > best.detection.box.area ? f : best),
    null
  )
  if (!reference) throw new FaceMatchError('На фотографијата на гостинот не е пронајдено лице.')

  const results: FaceComparison[] = []
  onProgress?.(0, candidates.length)
  for (const [i, c] of candidates.entries()) {
    try {
      const faces = await describe(faceapi, c.src)
      if (faces.length === 0) {
        results.push({ imageId: c.imageId, verdict: 'no_face', distance: null, faces: 0 })
      } else {
        const distance = Math.min(...faces.map((f) => faceapi.euclideanDistance(reference.descriptor, f.descriptor)))
        const rounded = Math.round(distance * 1000) / 1000
        results.push({ imageId: c.imageId, verdict: verdictFor(rounded), distance: rounded, faces: faces.length })
      }
    } catch {
      // An image the browser cannot decode is treated as having no usable face.
      results.push({ imageId: c.imageId, verdict: 'no_face', distance: null, faces: 0 })
    }
    onProgress?.(i + 1, candidates.length)
  }
  return results
}
