import net from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { postEntry } from '../src/domain/ledger.js'
import { decode, encode, type OutMessage } from '../src/wire/envelope.js'
import { CH_CMS, CH_SAS, MuxParser, muxFrame } from '../src/wire/mux.js'
import { CmsTcpServer } from '../src/wire/tcpServer.js'

/** A stand-in for the slot game's cmsBridge: mux-framed JSON over TCP. */
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

  sendRaw(data: Buffer): void {
    this.socket.write(data)
  }

  next(timeoutMs = 1000): Promise<OutMessage> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a CMS frame')), timeoutMs)
      this.waiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  /** Resolves only if nothing arrives — proves the server stayed silent. */
  async expectSilence(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
    if (this.queue.length > 0) {
      throw new Error(`expected silence, got ${JSON.stringify(this.queue)}`)
    }
  }

  close(): void {
    this.socket.destroy()
  }
}

function setupDb() {
  const db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
  return { db, card }
}

let server: CmsTcpServer | undefined
let client: TestClient | undefined

afterEach(async () => {
  client?.close()
  await server?.stop()
  server = undefined
  client = undefined
})

async function startServer(db: ReturnType<typeof setupDb>['db']) {
  server = new CmsTcpServer({ db, pointsPerMkd: 0, currency: 'MKD' }, 0)
  const port = await server.start()
  client = await TestClient.connect(port)
  return client
}

describe('CmsTcpServer', () => {
  test('answers a mux-framed ping with a pong', async () => {
    const { db } = setupDb()
    const c = await startServer(db)

    c.send('ping', 42)

    expect(await c.next()).toEqual({ t: 'pong', id: 42, d: {} })
  })

  test('runs a full auth -> debit -> commit over the wire', async () => {
    const { db } = setupDb()
    const c = await startServer(db)

    c.send('auth_req', 1, { uid: 'AA BB' })
    const auth = await c.next()
    expect(auth.d.ok).toBe(true)
    const sid = auth.d.sid

    c.send('debit_req', 2, { sid, txn: 'SMIB-000001', amount: 40000 })
    const debit = await c.next()
    expect(debit.d).toMatchObject({ ok: true, txn: 'SMIB-000001', balance: 60000 })

    c.send('debit_commit', 3, { txn: 'SMIB-000001' })
    expect((await c.next()).d.ok).toBe(true)
  })

  test('ignores frames on other mux channels', async () => {
    const { db } = setupDb()
    const c = await startServer(db)

    c.sendRaw(muxFrame(CH_SAS, Buffer.from([0x81])))
    c.send('ping', 1)

    // The SAS frame must not produce a reply; the ping still works.
    expect(await c.next()).toEqual({ t: 'pong', id: 1, d: {} })
  })

  test('survives a garbage frame and keeps serving', async () => {
    const { db } = setupDb()
    const c = await startServer(db)

    c.sendRaw(muxFrame(CH_CMS, Buffer.from('not json at all')))
    c.send('ping', 5)

    expect(await c.next()).toEqual({ t: 'pong', id: 5, d: {} })
  })

  test('sends no reply to logout', async () => {
    const { db } = setupDb()
    const c = await startServer(db)
    c.send('auth_req', 1, { uid: 'AA BB' })
    const sid = (await c.next()).d.sid

    c.send('logout', 2, { sid, reason: 'cashout' })

    await c.expectSilence()
  })
})

describe('pushes', () => {
  test('balance_push reaches the terminal holding that session', async () => {
    const { db, card } = setupDb()
    const c = await startServer(db)
    c.send('auth_req', 1, { uid: 'AA BB' })
    const sid = (await c.next()).d.sid

    const delivered = server!.pushBalance(sid, 123456, 78)

    expect(delivered).toBe(true)
    const push = await c.next()
    expect(push.t).toBe('balance_push')
    expect(push.d).toMatchObject({ balance: 123456, points: 78 })
    expect(card.id).toBeTruthy()
  })

  test('logout_push reaches the terminal holding that session', async () => {
    const { db } = setupDb()
    const c = await startServer(db)
    c.send('auth_req', 1, { uid: 'AA BB' })
    const sid = (await c.next()).d.sid

    expect(server!.pushLogout(sid)).toBe(true)

    expect((await c.next()).t).toBe('logout_push')
  })

  test('pushing to an unknown session reports undelivered', async () => {
    const { db } = setupDb()
    await startServer(db)

    expect(server!.pushBalance('s-nobody', 1, 2)).toBe(false)
    expect(server!.pushLogout('s-nobody')).toBe(false)
  })

  test('a dropped connection stops being a push target', async () => {
    const { db } = setupDb()
    const c = await startServer(db)
    c.send('auth_req', 1, { uid: 'AA BB' })
    const sid = (await c.next()).d.sid

    c.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(server!.pushBalance(sid, 1, 2)).toBe(false)
  })
})
