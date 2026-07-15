import type net from 'node:net'
import { encode, type OutMessage } from './envelope.js'
import { CH_CMS, muxFrame } from './mux.js'

/**
 * Tracks which terminal connection is holding which session, so the CMS can
 * push balance_push / logout_push down it.
 *
 * The firmware has always handled both (cms.c k_msg_map marks them is_push),
 * but the Python prototype never emitted either — staff changes simply never
 * reached the terminal.
 */
export class PushRegistry {
  private bySid = new Map<string, net.Socket>()

  bind(sid: string, socket: net.Socket): void {
    this.bySid.set(sid, socket)
  }

  unbind(sid: string): void {
    this.bySid.delete(sid)
  }

  /** Drops every session bound to a connection that has gone away. */
  unbindSocket(socket: net.Socket): void {
    for (const [sid, bound] of this.bySid) {
      if (bound === socket) this.bySid.delete(sid)
    }
  }

  /** Returns false when nobody is holding that session right now. */
  send(sid: string, msg: OutMessage): boolean {
    const socket = this.bySid.get(sid)
    if (!socket || socket.destroyed) {
      this.bySid.delete(sid)
      return false
    }
    socket.write(muxFrame(CH_CMS, encode(msg)))
    return true
  }

  /** Pushes are unsolicited: the firmware ignores `id` for them. */
  pushBalance(sid: string, balanceDeni: number, points: number): boolean {
    return this.send(sid, { t: 'balance_push', id: 0, d: { balance: balanceDeni, points } })
  }

  pushLogout(sid: string): boolean {
    return this.send(sid, { t: 'logout_push', id: 0, d: {} })
  }
}
