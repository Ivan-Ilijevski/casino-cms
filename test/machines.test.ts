import { beforeEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import {
  createMachine,
  listMachines,
  markMachineSeen,
  normaliseHost,
  resolveMachineByLink,
  updateMachine
} from '../src/domain/machines.js'

let db: Db

beforeEach(() => {
  db = openTestDb()
})

describe('normaliseHost', () => {
  test('folds the IPv4-mapped IPv6 form Node reports on a dual-stack listener', () => {
    expect(normaliseHost('::ffff:192.168.1.7')).toBe('192.168.1.7')
  })

  test('treats the two loopbacks as one host', () => {
    // "localhost" resolves to ::1 first on many clients, so a machine
    // registered as 127.0.0.1 would otherwise lose its cashouts.
    expect(normaliseHost('::1')).toBe('127.0.0.1')
    expect(normaliseHost('::ffff:127.0.0.1')).toBe('127.0.0.1')
  })

  test('lowercases, trims, and treats empty as absent', () => {
    expect(normaliseHost('  10.0.0.5 ')).toBe('10.0.0.5')
    expect(normaliseHost('FE80::1')).toBe('fe80::1')
    expect(normaliseHost('')).toBeNull()
    expect(normaliseHost(undefined)).toBeNull()
  })
})

describe('resolveMachineByLink', () => {
  test('an exact host match wins', () => {
    const m = createMachine(db, { label: 'Shining Crown 01', host: '192.168.1.7' })

    expect(resolveMachineByLink(db, { host: '192.168.1.7' })).toBe(m.id)
  })

  test('matches through the IPv4-mapped form the socket actually reports', () => {
    const m = createMachine(db, { label: 'Shining Crown 01', host: '192.168.1.7' })

    expect(resolveMachineByLink(db, { host: '::ffff:192.168.1.7' })).toBe(m.id)
  })

  test('two cabinets sharing the firmware device id are told apart by host', () => {
    // Every terminal flashed from one image reports SMIB_DEVICE_ID "smib-1",
    // so this is the normal case on a real floor, not an edge case.
    const one = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1', device_id: 'smib-1' })
    const two = createMachine(db, { label: 'Кабина 2', host: '10.0.0.2', device_id: 'smib-1' })

    expect(resolveMachineByLink(db, { host: '10.0.0.1', deviceId: 'smib-1' })).toBe(one.id)
    expect(resolveMachineByLink(db, { host: '10.0.0.2', deviceId: 'smib-1' })).toBe(two.id)
  })

  test('falls back to device_id when it is unambiguous', () => {
    const m = createMachine(db, { label: 'Кабина 1', device_id: 'smib-7' })

    expect(resolveMachineByLink(db, { host: '10.0.0.9', deviceId: 'smib-7' })).toBe(m.id)
  })

  test('refuses to guess when a device_id is shared and no host matches', () => {
    createMachine(db, { label: 'Кабина 1', host: '10.0.0.1', device_id: 'smib-1' })
    createMachine(db, { label: 'Кабина 2', host: '10.0.0.2', device_id: 'smib-1' })

    // An unknown address plus an ambiguous id must read as "unregistered", not
    // as whichever row happened to sort first — attributing a session to the
    // wrong cabinet is worse than attributing it to none.
    expect(resolveMachineByLink(db, { host: '10.0.0.3', deviceId: 'smib-1' })).toBeNull()
  })

  test('an unknown connection is unregistered, never auto-created', () => {
    expect(resolveMachineByLink(db, { host: '10.0.0.4', deviceId: 'smib-1' })).toBeNull()
    expect(listMachines(db)).toHaveLength(0)
  })
})

describe('the registry', () => {
  test('rejects a second machine on one host', () => {
    createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })

    expect(() => createMachine(db, { label: 'Кабина 2', host: '10.0.0.1' })).toThrow()
  })

  test('lets many machines wait with no host at all', () => {
    createMachine(db, { label: 'Кабина 1' })
    createMachine(db, { label: 'Кабина 2' })

    expect(listMachines(db)).toHaveLength(2)
  })

  test('out-of-service machines sort last', () => {
    createMachine(db, { label: 'Аа прва' })
    const b = createMachine(db, { label: 'Бб втора' })
    updateMachine(db, b.id, { status: 'out_of_service' })
    createMachine(db, { label: 'Вв трета' })

    expect(listMachines(db).map((m) => m.label)).toEqual(['Аа прва', 'Вв трета', 'Бб втора'])
  })

  test('markMachineSeen fills first_seen once and counts only real connects', () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })

    markMachineSeen(db, m.id, { deviceId: 'smib-1', fw: '0.1.0', proto: 1, connected: true })
    const first = listMachines(db)[0]!
    markMachineSeen(db, m.id, { connected: false })
    const second = listMachines(db)[0]!

    expect(second.first_seen).toBe(first.first_seen)
    expect(second.device_id).toBe('smib-1')
    expect(second.fw).toBe('0.1.0')
    expect(second.connects).toBe(1)
  })
})
