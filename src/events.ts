import { EventEmitter } from 'node:events'

export interface CmsEventMap {
  'order.created': { orderId: string }
  'order.updated': { orderId: string }
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
