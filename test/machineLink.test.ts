import net from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { createMachine } from '../src/domain/machines.js'
import { decode, encode, type OutMessage } from '../src/wire/envelope.js'
import { CH_CMS, MuxParser, muxFrame } from '../src/wire/mux.js'
import { CmsTcpServer } from '../src/wire/tcpServer.js'

/** A stand-in for the slot game's cmsBridge, as in tcpServer.test.ts. */
class TestClient {
  private parser = new MuxParser()
  private queue: OutMessage[] = []
  private waiters: Array<(msg: OutMessage) => void> = []

  private constructor(private socket: net.Socket) {
    socket.on('data', (chunk) => {
      for (const frame of this.parser.feed(chunk)) {
        if (frame.chan !== CH_CMS) continue
        const msg = decode(frame.payload)
        if (!msg) continue
        const waiter = this.waiters.shift()
        if (waiter) waiter(msg as OutMessage)
        else this.queue.push(msg as OutMessage)
      }
    })
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () =>
        resolve(new TestClient(socket))
      )
      socket.once('error', reject)
    })
  }

  send(t: string, id: number, d: Record<string, unknown> = {}): void {
    this.socket.write(muxFrame(CH_CMS, encode({ t, id, d })))
  }

  next(timeoutMs = 1000): Promise<OutMessage> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      this.waiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

let server: CmsTcpServer | undefined
let client: TestClient | undefined

afterEach(async () => {
  client?.close()
  await server?.stop()
  server = undefined
  client = undefined
})

async function start(db: Db) {
  server = new CmsTcpServer({ db, pointsPerMkd: 0, currency: 'MKD' }, 0)
  const port = await server.start()
  client = await TestClient.connect(port)
  return { server, client }
}

/** The TestClient always dials from 127.0.0.1, so that is the cabinet's host. */
function registerLocalMachine(db: Db) {
  return createMachine(db, { label: 'Кабина 1', host: '127.0.0.1' })
}

describe('terminal links', () => {
  test('hello records the identity the firmware already volunteers', async () => {
    const db = openTestDb()
    const machine = registerLocalMachine(db)
    const { client: c, server: s } = await start(db)

    c.send('hello', 1, { dev: 'smib-1', fw: '0.1.0', proto: 1 })
    await c.next()

    const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(machine.id) as any
    expect(row.device_id).toBe('smib-1')
    expect(row.fw).toBe('0.1.0')
    expect(row.proto).toBe(1)
    expect(row.last_seen).not.toBeNull()

    const [link] = s.listLinks()
    expect(link!.deviceId).toBe('smib-1')
    expect(link!.machineId).toBe(machine.id)
  })

  test('an unregistered cabinet is listed live but creates no row', async () => {
    const db = openTestDb()
    const { client: c, server: s } = await start(db)

    c.send('hello', 1, { dev: 'smib-1', fw: '0.1.0', proto: 1 })
    await c.next()

    const [link] = s.listLinks()
    expect(link!.machineId).toBeNull()
    expect(link!.deviceId).toBe('smib-1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM machines').get()).toEqual({ n: 0 })
  })

  test('a card session records the cabinet it was opened at', async () => {
    const db = openTestDb()
    const machine = registerLocalMachine(db)
    createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
    const { client: c } = await start(db)

    c.send('auth_req', 1, { uid: 'AA BB' })
    const res = await c.next()

    const sid = (res.d as { sid: string }).sid
    const row = db.prepare('SELECT machine_id FROM sessions WHERE sid = ?').get(sid)
    expect(row).toEqual({ machine_id: machine.id })
  })

  test('the link drops out of the list when the socket closes', async () => {
    const db = openTestDb()
    registerLocalMachine(db)
    const { client: c, server: s } = await start(db)

    c.send('ping', 1)
    await c.next()
    expect(s.listLinks()).toHaveLength(1)

    c.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(s.listLinks()).toHaveLength(0)
  })

  test('dropLink cuts the connection', async () => {
    const db = openTestDb()
    registerLocalMachine(db)
    const { client: c, server: s } = await start(db)

    c.send('ping', 1)
    await c.next()

    expect(s.dropLink(s.listLinks()[0]!.connId)).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(s.listLinks()).toHaveLength(0)
  })

  /**
   * The invariant that matters most: a wire handler that throws sends no reply,
   * and the firmware then retries forever. Oversight bookkeeping is not allowed
   * to cause that, so every machine write is caught. Dropping the table makes
   * every one of them throw.
   */
  test('a broken machines table cannot stop the money path replying', async () => {
    const db = openTestDb()
    createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
    db.exec('DROP TABLE machines')
    const { client: c } = await start(db)

    c.send('hello', 1, { dev: 'smib-1', fw: '0.1.0', proto: 1 })
    expect(await c.next()).toMatchObject({ t: 'hello_res', id: 1 })

    c.send('auth_req', 2, { uid: 'AA BB' })
    const auth = await c.next()
    expect(auth.t).toBe('auth_res')
    expect((auth.d as { ok: boolean }).ok).toBe(true)

    c.send('ping', 3)
    expect(await c.next()).toEqual({ t: 'pong', id: 3, d: {} })
  })
})
