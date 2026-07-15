import net from 'node:net'
import { decode, encode } from './envelope.js'
import { handleCmsMessage, type CmsContext } from './handlers.js'
import { CH_CMS, MuxParser, muxFrame } from './mux.js'
import { PushRegistry } from './push.js'

/**
 * The SMIB-facing listener. Drop-in for tools/host_sim/cms_tcp_server.py:
 * mux-framed JSON on channel 0x02 over TCP, which is exactly what the slot
 * game's cmsBridge.ts relays from the terminal's serial link.
 */
export class CmsTcpServer {
  private server: net.Server | undefined
  private sockets = new Set<net.Socket>()
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
    this.sockets.add(socket)
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

        for (const out of replies) {
          if (out.t === 'auth_res' && out.d.ok && typeof out.d.sid === 'string') {
            this.pushes.bind(out.d.sid, socket)
          }
          socket.write(muxFrame(CH_CMS, encode(out)))
        }
      }
    })

    const drop = () => {
      this.pushes.unbindSocket(socket)
      this.sockets.delete(socket)
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  pushBalance(sid: string, balanceDeni: number, points: number): boolean {
    return this.pushes.pushBalance(sid, balanceDeni, points)
  }

  pushLogout(sid: string): boolean {
    return this.pushes.pushLogout(sid)
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.server = undefined
  }
}
