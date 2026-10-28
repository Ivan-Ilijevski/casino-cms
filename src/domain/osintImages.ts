import { createHash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { Db } from '../db/index.js'
import type { Engine } from './osintEngines.js'
import type { MergedReport } from './osintMerge.js'
import { normalizeUrl, type Confidence } from './osintPrompt.js'
import { insertImage } from './osintRuns.js'

/**
 * Downloads the photos a profile run found — the one place the CMS server
 * fetches a URL it did not choose.
 *
 * Those URLs come from AI engines that read arbitrary web pages, so they are
 * attacker-influenced input, and the CMS shares a LAN with the slot machines.
 * The fence:
 *   - Connect only to PUBLIC addresses. The check runs inside the socket's own
 *     DNS lookup, so a hostname that resolves public for a check and private
 *     for the connection (DNS rebinding) still cannot reach the LAN. IP-literal
 *     hosts skip DNS entirely, so they are checked separately.
 *   - http/https on the default ports only; at most 3 redirects, each hop
 *     re-checked; a per-request timeout; a hard byte cap while streaming.
 *   - Stored only if the bytes ARE a JPEG, PNG, GIF or WebP by magic number,
 *     whatever the server claimed. SVG is refused: it is a script container.
 */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const HTML_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const MAX_DOWNLOADS = 12
const CONCURRENCY = 3
const PHASE_BUDGET_MS = 2 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (compatible; casino-cms-osint/1.0)'

// ---------------------------------------------------------------------------
// Address policy

function publicV4(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null
}

/** Eight hextets, with a trailing dotted IPv4 folded into the last two. */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0] ?? ''
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4?.[1]) {
    const p = parseV4(v4[1])
    if (!p) return null
    text = text.slice(0, -v4[1].length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const nums = groups.map((g) => parseInt(g, 16))
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.split('%')[0] ?? '')
  if (family === 4) {
    const p = parseV4(ip)
    return p !== null && publicV4(p)
  }
  if (family !== 6) return false

  const h = expandV6(ip)
  if (!h) return false
  const embeddedV4 = () => [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0)

  if (zeros(0, 8)) return false // ::
  if (zeros(0, 7) && h[7] === 1) return false // ::1
  if (zeros(0, 5) && h[5] === 0xffff) return publicV4(embeddedV4()) // ::ffff:a.b.c.d
  if (zeros(0, 6)) return publicV4(embeddedV4()) // ::a.b.c.d (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return publicV4(embeddedV4()) // NAT64
  if ((h[0]! & 0xfe00) === 0xfc00) return false // unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return false // link-local
  if ((h[0]! & 0xff00) === 0xff00) return false // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false // documentation
  return true
}

/**
 * The socket's DNS lookup. Every resolved address must be public — a hostname
 * with one public and one private record is refused outright rather than
 * connected to whichever the OS happens to pick.
 */
function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '')
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      const blocked = Object.assign(new Error(`blocked non-public address for ${hostname}`), { code: 'EBLOCKED' })
      return callback(blocked, '')
    }
    if (options.all) return callback(null, addresses)
    const first = addresses[0]!
    callback(null, first.address, first.family)
  })
}

// ---------------------------------------------------------------------------
// Fetch

interface Fetched {
  body: Buffer
  contentType: string
  finalUrl: string
  truncated: boolean
}

function checkUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) is fetched')
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('only default ports are fetched')
  if (url.username || url.password) throw new Error('credentials in URL refused')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw new Error('blocked non-public address')
  return url
}

function requestOnce(url: URL, opts: { signal: AbortSignal; maxBytes: number; truncate: boolean; accept: string }) {
  return new Promise<{ status: number; location: string | null; fetched: Fetched }>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup as unknown as typeof dnsLookup,
        signal: opts.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept, 'Accept-Encoding': 'identity' }
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = typeof res.headers.location === 'string' ? res.headers.location : null
        if (status >= 300 && status < 400) {
          res.resume()
          resolve({ status, location, fetched: { body: Buffer.alloc(0), contentType: '', finalUrl: url.toString(), truncated: false } })
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let done = false
        const finish = (truncated: boolean) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({
            status,
            location,
            fetched: {
              body: Buffer.concat(chunks),
              contentType: String(res.headers['content-type'] ?? ''),
              finalUrl: url.toString(),
              truncated
            }
          })
        }
        res.on('data', (chunk: Buffer) => {
          if (done) return
          size += chunk.length
          if (size > opts.maxBytes) {
            if (opts.truncate) {
              chunks.push(chunk.subarray(0, chunk.length - (size - opts.maxBytes)))
              finish(true)
              req.destroy()
            } else {
              done = true
              clearTimeout(timer)
              req.destroy()
              reject(new Error(`larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`))
            }
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish(false))
        res.on('error', (err) => {
          if (!done) {
            done = true
            clearTimeout(timer)
            reject(err)
          }
        })
      }
    )
    const timer = setTimeout(() => req.destroy(new Error('timeout')), REQUEST_TIMEOUT_MS)
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

export async function fetchLimited(
  raw: string,
  opts: { signal: AbortSignal; maxBytes: number; truncate?: boolean; accept: string }
): Promise<Fetched> {
  let url = checkUrl(raw)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { status, location, fetched } = await requestOnce(url, { ...opts, truncate: opts.truncate ?? false })
    if (status >= 300 && status < 400) {
      if (!location) throw new Error(`HTTP ${status} without a location`)
      url = checkUrl(new URL(location, url).toString())
      continue
    }
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return fetched
  }
  throw new Error('too many redirects')
}

// ---------------------------------------------------------------------------
// Content

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/** By magic number only. The Content-Type header is the sender's claim, not a fact. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif'
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' }

/** The page's own preview image — what a link unfurl would show. */
export function extractPreviewImage(html: string, baseUrl: string): string | null {
  const wanted = ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']
  const found = new Map<string, string>()
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {}
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
    }
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase()
    if (wanted.includes(key) && attrs.content && !found.has(key)) found.set(key, attrs.content)
  }
  for (const key of wanted) {
    const value = found.get(key)
    if (!value) continue
    try {
      const url = new URL(value.replace(/&amp;|&quot;|&#39;|&#x27;|&lt;|&gt;/g, (e) => ENTITIES[e] ?? e), baseUrl)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    } catch {
      // try the next one
    }
  }
  return null
}

export type ResolvedImage = { ok: true; bytes: Buffer; contentType: ImageType; sha256: string } | { ok: false; error: string }

async function fetchImage(url: string, signal: AbortSignal): Promise<ResolvedImage | { ok: false; error: string; html: Fetched }> {
  const res = await fetchLimited(url, { signal, maxBytes: IMAGE_MAX_BYTES, accept: 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5' })
  const type = sniffImage(res.body)
  if (type) return { ok: true, bytes: res.body, contentType: type, sha256: createHash('sha256').update(res.body).digest('hex') }
  if (/text\/html|application\/xhtml/i.test(res.contentType)) return { ok: false, error: 'page, not an image', html: res }
  return { ok: false, error: `not a JPEG/PNG/GIF/WebP (${res.contentType || 'unknown type'})` }
}

/** The image URL if it is one; otherwise the preview image of whichever page we can read. */
export async function resolveImage(
  candidate: { image_url: string | null; page_url: string },
  signal: AbortSignal
): Promise<ResolvedImage> {
  let lastError = 'no image found'

  if (candidate.image_url) {
    try {
      const got = await fetchImage(candidate.image_url, signal)
      if (got.ok) return got
      lastError = got.error
      if ('html' in got) {
        const preview = extractPreviewImage(got.html.body.toString('utf8'), got.html.finalUrl)
        if (preview) {
          const second = await fetchImage(preview, signal)
          if (second.ok) return second
          lastError = second.error
        }
      }
    } catch (err) {
      lastError = (err as Error).message
    }
  }

  try {
    const page = await fetchLimited(candidate.page_url, {
      signal,
      maxBytes: HTML_MAX_BYTES,
      truncate: true,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
    })
    const direct = sniffImage(page.body)
    if (direct && !page.truncated) {
      return { ok: true, bytes: page.body, contentType: direct, sha256: createHash('sha256').update(page.body).digest('hex') }
    }
    const preview = extractPreviewImage(page.body.toString('utf8'), page.finalUrl)
    if (!preview) return { ok: false, error: candidate.image_url ? lastError : 'page has no preview image' }
    const got = await fetchImage(preview, signal)
    return got.ok ? got : { ok: false, error: got.error }
  } catch (err) {
    return { ok: false, error: candidate.image_url ? `${lastError}; page: ${(err as Error).message}` : (err as Error).message }
  }
}

// ---------------------------------------------------------------------------

interface Candidate {
  origin: 'report' | 'account'
  image_url: string | null
  page_url: string
  description: string
  match_confidence: Confidence
  engines: Engine[]
}

/**
 * Downloads the confident candidates of a finished merge and stores each as a
 * row: the bytes when it worked, the reason when it did not. Low-confidence
 * photos are never downloaded — a stranger's face does not get filed on a
 * guest's record on a guess.
 */
export async function collectImages(
  db: Db,
  runId: string,
  merged: MergedReport,
  signal: AbortSignal,
  resolve: typeof resolveImage = resolveImage
): Promise<number> {
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  const push = (c: Candidate) => {
    const key = normalizeUrl(c.image_url ?? c.page_url)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }
  for (const img of merged.images ?? []) {
    if (img.match_confidence === 'low') continue
    push({ origin: 'report', ...img })
  }
  for (const acc of merged.accounts ?? []) {
    if (acc.match_confidence === 'low') continue
    push({
      origin: 'account',
      image_url: null,
      page_url: acc.url,
      description: `Профилна слика — ${acc.platform}${acc.handle ? ` (${acc.handle})` : ''}`,
      match_confidence: acc.match_confidence,
      engines: acc.engines
    })
  }

  const queue = candidates.slice(0, MAX_DOWNLOADS)
  const phase = AbortSignal.any([signal, AbortSignal.timeout(PHASE_BUDGET_MS)])
  const hashes = new Set<string>()
  let stored = 0

  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      if (signal.aborted) return
      const result = phase.aborted ? ({ ok: false, error: 'image phase time budget exhausted' } as const) : await resolve(c, phase)
      // The same photo reached through two URLs is one photo.
      if (result.ok && hashes.has(result.sha256)) continue
      if (result.ok) hashes.add(result.sha256)
      try {
        insertImage(db, runId, {
          origin: c.origin,
          image_url: c.image_url,
          page_url: c.page_url,
          description: c.description,
          match_confidence: c.match_confidence,
          engines: c.engines,
          ...(result.ok
            ? { status: 'stored' as const, content_type: result.contentType, bytes: result.bytes, sha256: result.sha256 }
            : { status: 'failed' as const, error: result.error.slice(0, 300) })
        })
        if (result.ok) stored++
      } catch (err) {
        // A run deleted mid-download: its row is gone and the FK refuses the insert.
        if (!signal.aborted) console.error('[osint] failed to store image:', err)
        return
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return stored
}
