import request from 'supertest'
import { beforeEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { getTicket, issueTicketWithId } from '../src/domain/tickets.js'
import { createVoucherApp } from '../src/http/voucherLegacy.js'

const API_KEY = 'ivan1507'

let db: Db
let app: ReturnType<typeof createVoucherApp>

beforeEach(() => {
  db = openTestDb()
  app = createVoucherApp({ db, apiKey: API_KEY, ticketExpiryDays: null })
})

// Every expectation here is pinned against /Users/ivanilijevski/voucher-server/voucher-server.js.
// The slot game calls this API with zero changes, so the shapes must not drift.

describe('POST /validate — the atomic redeem', () => {
  test('returns the credit in whole denars and marks the ticket used', async () => {
    issueTicketWithId(db, { id: '123456789012345678', amountDeni: 40000 })

    const res = await request(app).post('/validate').send({ id: '123456789012345678' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ valid: true, credit: 400 })
    expect(getTicket(db, '123456789012345678')?.status).toBe('redeemed')
  })

  test('rejects a missing id with 400 and the original wording', async () => {
    const res = await request(app).post('/validate').send({})

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ valid: false, reason: 'Missing voucher ID' })
  })

  test('rejects a second redeem with 409', async () => {
    issueTicketWithId(db, { id: '111111111111111111', amountDeni: 100 })
    await request(app).post('/validate').send({ id: '111111111111111111' })

    const res = await request(app).post('/validate').send({ id: '111111111111111111' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ valid: false, credit: 0, reason: 'Already used or invalid' })
  })

  test('reports an unknown id identically to an used one', async () => {
    const res = await request(app).post('/validate').send({ id: '999999999999999999' })

    // The original deliberately cannot tell these apart; keep that.
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ valid: false, credit: 0, reason: 'Already used or invalid' })
  })

  test('needs no api key', async () => {
    issueTicketWithId(db, { id: '222222222222222222', amountDeni: 100 })

    const res = await request(app).post('/validate').send({ id: '222222222222222222' })

    expect(res.status).toBe(200)
  })
})

describe('POST /generate', () => {
  test('mints an 18-digit id for a valid api key', async () => {
    const res = await request(app).post('/generate').set('x-api-key', API_KEY).send({ credit: 400 })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.id).toMatch(/^[0-9]{18}$/)
  })

  test('stores whole denars as deni', async () => {
    const res = await request(app).post('/generate').set('x-api-key', API_KEY).send({ credit: 400 })

    // The API speaks denars; the database is deni like everything else.
    expect(getTicket(db, res.body.id)?.amount_deni).toBe(40000)
  })

  test('rejects a wrong api key with 403', async () => {
    const res = await request(app).post('/generate').set('x-api-key', 'nope').send({ credit: 400 })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ success: false, message: 'Unauthorized' })
  })

  test('rejects a missing api key with 403', async () => {
    const res = await request(app).post('/generate').send({ credit: 400 })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ success: false, message: 'Unauthorized' })
  })

  test('rejects a non-positive or non-numeric credit with 400', async () => {
    for (const credit of [0, -5, 'abc', null]) {
      const res = await request(app).post('/generate').set('x-api-key', API_KEY).send({ credit })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ success: false, message: 'Invalid credit amount' })
    }
  })
})

describe('POST /create', () => {
  test('accepts a caller-supplied code, with no api key', async () => {
    const res = await request(app).post('/create').send({ code: 'ABC123', credit: 250 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(getTicket(db, 'ABC123')?.amount_deni).toBe(25000)
  })

  test('rejects missing or invalid input with 400', async () => {
    const res = await request(app).post('/create').send({ code: 'X' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, message: 'Missing or invalid input' })
  })

  test('rejects a duplicate code with 400', async () => {
    await request(app).post('/create').send({ code: 'DUP', credit: 100 })

    const res = await request(app).post('/create').send({ code: 'DUP', credit: 100 })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, message: 'Duplicate code or database error' })
  })
})

describe('GET /vouchers', () => {
  test('projects the new schema back to the legacy four-field shape', async () => {
    issueTicketWithId(db, { id: 'A1', amountDeni: 40000 })
    issueTicketWithId(db, { id: 'A2', amountDeni: 100 })
    await request(app).post('/validate').send({ id: 'A2' })

    const res = await request(app).get('/vouchers')

    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body as any[]).map((v) => [v.id, v]))
    expect(Object.keys(byId['A1'])).toEqual(['id', 'credit', 'used', 'created_at'])
    expect(byId['A1']).toMatchObject({ id: 'A1', credit: 400, used: 0 })
    expect(byId['A2']).toMatchObject({ id: 'A2', credit: 1, used: 1 })
  })
})

describe('the slot game round-trip', () => {
  test('generate then validate returns the same credit', async () => {
    // Mirrors voucherGenerator.ts -> /generate, then VoucherInput -> /validate.
    const generated = await request(app)
      .post('/generate')
      .set('x-api-key', API_KEY)
      .send({ credit: 660.11 })

    const validated = await request(app).post('/validate').send({ id: generated.body.id })

    expect(validated.body).toEqual({ valid: true, credit: 660.11 })
    // The game does Math.round(credit * 100) to get deni back.
    expect(Math.round(validated.body.credit * 100)).toBe(66011)
  })
})
