import { EventEmitter } from 'node:events'

export interface CmsEventMap {
  'order.created': { orderId: string }
  'order.updated': { orderId: string }
  /**
   * A terminal connection came or went. machineId is null while the cabinet is
   * unregistered, which is exactly when the admin most wants to be told: that is
   * a machine waiting to be adopted.
   */
  'machine.connected': { connId: string; machineId: string | null }
  'machine.disconnected': { connId: string; machineId: string | null }
  /** The registry row changed (renamed, adopted, taken out of service). */
  'machine.updated': { machineId: string }
}

/**
 * In-process bus between the terminal-facing TCP server and the staff app's SSE
 * feed: an order placed at the card terminal appears on the bar screen at once.
 */
export class CmsEvents {
  private emitter = new EventEmitter()

  constructor() {
    // The staff SSE feed attaches one listener per open dashboard.
    this.emitter.setMaxListeners(100)
  }

  emit<K extends keyof CmsEventMap>(event: K, payload: CmsEventMap[K]): void {
    this.emitter.emit(event, payload)
  }

  on<K extends keyof CmsEventMap>(event: K, listener: (payload: CmsEventMap[K]) => void): () => void {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }
}
