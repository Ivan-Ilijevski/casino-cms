import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// scrypt from node:crypto — no native dependency to build, and memory-hard.
// Stored format: scrypt$N$r$p$<salt b64>$<key b64>
const N = 16384 // 128 * N * r = 16 MB, comfortably under node's 32 MB scrypt maxmem
const R = 8
const P = 1
const KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  let actual: Buffer
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
