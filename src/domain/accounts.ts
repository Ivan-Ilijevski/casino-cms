import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { canonUid, tryCanonUid } from './uid.js'

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

/**
 * Auth lookup: the physical NFC UID is the credential. Matched on the canonical
 * form so the RC522 terminal and a Web NFC tap resolve the same card.
 *
 * Never throws — auth_req can carry junk off the wire, and that must not take
 * the money link down. An unparseable uid simply matches nothing.
 */
export function findCardByUid(db: Db, cardUid: string): Card | undefined {
  const canon = tryCanonUid(cardUid)
  if (!canon) return undefined
  return db.prepare('SELECT * FROM cards WHERE card_uid_canon = ?').get(canon) as Card | undefined
}

export function createPlayerWithCard(
  db: Db,
  opts: { name: string; cardUid: string; notes?: string }
): { player: Player; card: Card } {
  const playerId = randomUUID()
  const cardId = randomUUID()
  // Registration is trusted input: a malformed uid is a mistake worth surfacing,
  // and a duplicate canon trips the unique index (same card, other spelling).
  const canon = canonUid(opts.cardUid)

  db.transaction(() => {
    db.prepare('INSERT INTO players (id, name, notes) VALUES (?, ?, ?)').run(
      playerId,
      opts.name,
      opts.notes ?? null
    )
    db.prepare('INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES (?, ?, ?, ?)').run(
      cardId,
      opts.cardUid,
      playerId,
      canon
    )
  })()

  return { player: { id: playerId, name: opts.name }, card: getCard(db, cardId)! }
}
