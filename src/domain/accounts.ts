import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

export type CardStatus = 'active' | 'blocked'

export interface Player {
  id: string
  name: string
}

export interface Card {
  id: string
  card_uid: string
  player_id: string
  status: CardStatus
  balance_deni: number
  points: number
}

export function getCard(db: Db, cardId: string): Card | undefined {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Card | undefined
}

/** Auth lookup: the physical NFC UID is the credential. */
export function findCardByUid(db: Db, cardUid: string): Card | undefined {
  return db.prepare('SELECT * FROM cards WHERE card_uid = ?').get(cardUid) as Card | undefined
}

export function createPlayerWithCard(
  db: Db,
  opts: { name: string; cardUid: string; notes?: string }
): { player: Player; card: Card } {
  const playerId = randomUUID()
  const cardId = randomUUID()

  db.transaction(() => {
    db.prepare('INSERT INTO players (id, name, notes) VALUES (?, ?, ?)').run(
      playerId,
      opts.name,
      opts.notes ?? null
    )
    db.prepare('INSERT INTO cards (id, card_uid, player_id) VALUES (?, ?, ?)').run(
      cardId,
      opts.cardUid,
      playerId
    )
  })()

  return { player: { id: playerId, name: opts.name }, card: getCard(db, cardId)! }
}
