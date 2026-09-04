import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/*
  The PWA install is currently DISABLED — index.html no longer links the manifest,
  because Chrome's minted WebAPK cannot load on the Android 8.0 kiosk. These files
  are still built and served, and still worth guarding: the replacement (a Trusted
  Web Activity we build ourselves) is seeded from this manifest over HTTPS, so a
  typo'd icon path or a dropped `display` would break that too — silently, as ever.

  See .claude/plans/android-8-twa-apk.md.
*/

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public')

interface Icon {
  src: string
  sizes: string
  type?: string
  purpose?: string
}

const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
  name?: string
  short_name?: string
  start_url?: string
  scope?: string
  display?: string
  icons?: Icon[]
}

const icons = manifest.icons ?? []
const widthOf = (i: Icon) => Number(i.sizes.split('x')[0])

describe('web app manifest', () => {
  test('launches fullscreen — the whole reason it is installed', () => {
    expect(manifest.display).toBe('fullscreen')
  })

  test('has the fields Chrome requires before it offers an install', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })

  test('ships a 192px and a 512px icon', () => {
    expect(icons.some((i) => widthOf(i) >= 192)).toBe(true)
    expect(icons.some((i) => widthOf(i) >= 512)).toBe(true)
  })

  test('ships a maskable icon, so Android does not letterbox it in a white blob', () => {
    expect(icons.some((i) => i.purpose?.split(/\s+/).includes('maskable'))).toBe(true)
  })

  test('every icon it points at actually exists', () => {
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon.src.startsWith('/')).toBe(true)
      expect(existsSync(join(PUBLIC, icon.src))).toBe(true)
    }
  })
})

describe('service worker', () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8')

  test('exists — without one Chrome will not offer the install at all', () => {
    expect(sw).toMatch(/addEventListener\(\s*'fetch'/)
  })

  test('never caches the API', () => {
    // Cache-first on /api/ would serve a stale balance to a paying customer.
    expect(sw).not.toMatch(/'\/api\//)
    expect(sw).toMatch(/startsWith\('\/assets\/'\)/)
  })
})
