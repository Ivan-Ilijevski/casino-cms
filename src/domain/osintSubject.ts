import type { PlayerRow } from './customers.js'
import { nameVariants } from './translit.js'

/**
 * Exactly what an AI screening run is allowed to tell Anthropic or OpenAI
 * about a guest — and, snapshotted onto the run, the record of what it did.
 *
 * The document number is deliberately absent, and absent from the input type
 * too: a passport or ID number is useless to a web search and is the one field
 * that would turn a leaked prompt into an identity-theft kit. It is not read,
 * not even to be dropped.
 */
export interface OsintSubject {
  name: string
  variants: string[]
  city: string | null
  dob: string | null
  phone: string | null
  email: string | null
}

export type SubjectSource = Pick<PlayerRow, 'name' | 'city' | 'dob' | 'phone' | 'email'>

const clean = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

export function buildSubject(player: SubjectSource): OsintSubject {
  return {
    name: player.name.trim(),
    variants: nameVariants(player.name),
    city: clean(player.city),
    dob: clean(player.dob),
    phone: clean(player.phone),
    email: clean(player.email)
  }
}

/** Field names actually disclosed, for the audit entry. `variants` are derived from name. */
export function disclosedFields(subject: OsintSubject): string[] {
  return (['name', 'city', 'dob', 'phone', 'email'] as const).filter((f) => subject[f] !== null)
}
