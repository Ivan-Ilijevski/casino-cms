import net from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  markMachineSeen,
  normaliseHost,
  resolveMachineByLink,
  stampSessionMachine
} from '../domain/machines.js'
import { decode, encode, type InMessage } from './envelope.js'
import { handleCmsMessage, type CmsContext } from './handlers.js'
import { CH_CMS, MuxParser, muxFrame } from './mux.js'
import { PushRegistry } from './push.js'

/**
 * A live terminal connection, as the staff app sees it.
 *
 * Everything here is in memory and dies with the process, which is correct: it
 * describes a socket, and a socket does not survive a restart. What must outlive
 * a restart -- the cabinet's identity and when it was last heard from -- lives on
 * the `machines` row instead.
 */
export interface TerminalLink {
  connId: string
  host: string | null
  port: number
  connectedAt: number
  lastRxAt: number
  deviceId?: string
  fw?: string
  proto?: number
  frames: number
  lastType?: string
  /** The registered machine this resolved to, or null while unregistered. */
  machineId: string | null
  sids: string[]
}

/**
 * How long a connection may stay silent before the staff app calls it "без
 * сигнал". Taken from the firmware's own CMS_LINK_TIMEOUT_US (6 s) rather than
 * picked here, so the two ends agree about what "down" means. The terminal pings
 * every 2 s (CMS_PING_PERIOD_US), giving three chances inside the window.
 */
export const LINK_SILENT_MS = 6_000

/**
 * A connected terminal pings every 2 s. Writing last_seen on each of those would
 * be a row update per machine per 2 s for a column nobody reads at that
 * resolution -- the live view reads lastRxAt from memory. Persisting is therefore
 * throttled, and `last_seen` means "known to be alive within the last minute",
 * which is what it is actually used for after a restart.
 */
const SEEN_PERSIST_MS = 60_000

/**
 * The SMIB-facing listener. Drop-in for tools/host_sim/cms_tcp_server.py:
 * mux-framed JSON on channel 0x02 over TCP, which is exactly what the slot
 * game's cmsBridge.ts relays from the terminal's serial link.
 */
export class CmsTcpServer {
  private server: net.Server | undefined
  private links = new Map<net.Socket, TerminalLink>()
  private persistedAt = new WeakMap<net.Socket, number>()
  readonly pushes = new PushRegistry()

  constructor(
    private ctx: CmsContext,
    private port: number,
    private host = '0.0.0.0'
  ) {}

  /** Resolves with the bound port (useful when constructed with port 0). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket))
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        this.server = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : this.port)
      })
    })
  }

  private onConnection(socket: net.Socket): void {
    const now = Date.now()
    const link: TerminalLink = {
      connId: randomUUID(),
      host: normaliseHost(socket.remoteAddress),
      port: socket.remotePort ?? 0,
      connectedAt: now,
      lastRxAt: now,
      frames: 0,
      machineId: null,
      sids: []
    }
    this.links.set(socket, link)

    // A cabinet with a registered IP is known before it says a word; one that
    // has to be told apart by device_id stays null until its hello arrives.
    this.safely('resolve on connect', () => {
      link.machineId = resolveMachineByLink(this.ctx.db, { host: link.host })
      if (link.machineId) this.persistSeen(socket, link, true)
    })
    this.ctx.onMachineLink?.({ connId: link.connId, machineId: link.machineId, state: 'connected' })

    const parser = new MuxParser()

    socket.on('data', (chunk) => {
      for (const frame of parser.feed(chunk)) {
        // The bridge may relay other channels; only CMS traffic is ours.
        if (frame.chan !== CH_CMS) continue

        const msg = decode(frame.payload)
        if (!msg) continue

        let replies
        try {
          replies = handleCmsMessage(this.ctx, msg)
        } catch (err) {
          // A handler fault must never take the money link down.
          console.error(`[cms] handler error for "${msg.t}":`, err)
          continue
        }

        const opened: string[] = []
        for (const out of replies) {
          if (out.t === 'auth_res' && out.d.ok && typeof out.d.sid === 'string') {
            this.pushes.bind(out.d.sid, socket)
            opened.push(out.d.sid)
          }
          socket.write(muxFrame(CH_CMS, encode(out)))
        }

        // Oversight bookkeeping runs only once the replies are on the wire. The
        // firmware allows 3 s (CMS_REQUEST_TIMEOUT_US) and retries a silent
        // request forever, so a stalled write here must not be able to eat into
        // that deadline -- nor to throw into the money path, hence safely().
        this.record(socket, link, msg)
        for (const sid of opened) {
          this.safely('stamp session machine', () => {
            if (link.machineId) stampSessionMachine(this.ctx.db, sid, link.machineId)
          })
        }
        link.sids = this.pushes.sidsFor(socket)
      }
    })

    const drop = () => {
      if (!this.links.has(socket)) return
      this.pushes.unbindSocket(socket)
      this.links.delete(socket)
      this.ctx.onMachineLink?.({
        connId: link.connId,
        machineId: link.machineId,
        state: 'disconnected'
      })
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  /** Never lets an oversight write reach the caller. */
  private safely(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.error(`[cms] machine bookkeeping (${what}) failed:`, err)
    }
  }

  private record(socket: net.Socket, link: TerminalLink, msg: InMessage): void {
    link.lastRxAt = Date.now()
    link.frames++
    link.lastType = msg.t

    if (msg.t === 'hello') {
      // cms.c re-sends hello on every link down->up edge, so this is both the
      // introduction and the reconnect signal.
      const d = msg.d as Record<string, unknown>
      if (typeof d.dev === 'string') link.deviceId = d.dev.slice(0, 64)
      if (typeof d.fw === 'string') link.fw = d.fw.slice(0, 32)
      if (typeof d.proto === 'number') link.proto = d.proto

      this.safely('resolve on hello', () => {
        const before = link.machineId
        link.machineId = resolveMachineByLink(this.ctx.db, {
          deviceId: link.deviceId,
          host: link.host
        })
        if (link.machineId) this.persistSeen(socket, link, true)
        if (link.machineId !== before) {
          this.ctx.onMachineLink?.({
            connId: link.connId,
            machineId: link.machineId,
            state: 'connected'
          })
        }
      })
      return
    }

    if (!link.machineId) return
    const last = this.persistedAt.get(socket) ?? 0
    if (Date.now() - last < SEEN_PERSIST_MS) return
    this.safely('persist last_seen', () => this.persistSeen(socket, link, false))
  }

  private persistSeen(socket: net.Socket, link: TerminalLink, connected: boolean): void {
    if (!link.machineId) return
    markMachineSeen(this.ctx.db, link.machineId, {
      deviceId: link.deviceId ?? null,
      fw: link.fw ?? null,
      proto: link.proto ?? null,
      connected
    })
    this.persistedAt.set(socket, Date.now())
  }

  /** Snapshot of every live connection, registered or not. */
  listLinks(): TerminalLink[] {
    return [...this.links.values()].map((link) => ({ ...link, sids: [...link.sids] }))
  }

  /**
   * Binds a live connection to a machine that has just been registered from it.
   *
   * listLinks() hands out copies, so the adopting route cannot simply assign to
   * the record it was given. Without this the cabinet would keep reading as
   * unregistered until its next hello -- and cms.c only re-sends hello on a
   * reconnect, which may be hours away.
   */
  adoptLink(connId: string, machineId: string): boolean {
    for (const [socket, link] of this.links) {
      if (link.connId !== connId) continue
      link.machineId = machineId
      this.safely('persist on adopt', () => this.persistSeen(socket, link, true))
      return true
    }
    return false
  }

  /** The card sessions currently held at one connection. */
  sidsForLink(connId: string): string[] {
    for (const [socket, link] of this.links) {
      if (link.connId === connId) return this.pushes.sidsFor(socket)
    }
    return []
  }

  /** Cuts a terminal loose. cmsBridge reconnects on its own 2 s backoff. */
  dropLink(connId: string): boolean {
    for (const [socket, link] of this.links) {
      if (link.connId !== connId) continue
      socket.destroy()
      return true
    }
    return false
  }

  pushBalance(sid: string, balanceDeni: number, points: number): boolean {
    return this.pushes.pushBalance(sid, balanceDeni, points)
  }

  pushLogout(sid: string): boolean {
    return this.pushes.pushLogout(sid)
  }

  async stop(): Promise<void> {
    for (const socket of this.links.keys()) socket.destroy()
    this.links.clear()
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.server = undefined
  }
}
