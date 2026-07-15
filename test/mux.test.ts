import { describe, expect, test } from 'vitest'
import { CH_CMS, CH_LOG, CH_SAS, MuxParser, crc16Kermit, muxFrame } from '../src/wire/mux.js'

describe('crc16Kermit', () => {
  test('matches the standard KERMIT check value for "123456789"', () => {
    expect(crc16Kermit(Buffer.from('123456789'))).toBe(0x2189)
  })
})

describe('mux framing', () => {
  test('frames a payload with sync, channel, little-endian length and CRC', () => {
    const frame = muxFrame(CH_CMS, Buffer.from('hi'))

    expect(frame[0]).toBe(0x7e)
    expect(frame[1]).toBe(CH_CMS)
    expect(frame[2]).toBe(2) // len lo
    expect(frame[3]).toBe(0) // len hi
    expect(frame.subarray(4, 6).toString()).toBe('hi')
    expect(frame).toHaveLength(4 + 2 + 2)
  })

  test('round-trips a framed payload', () => {
    const parser = new MuxParser()

    const frames = parser.feed(muxFrame(CH_CMS, Buffer.from('{"t":"ping"}')))

    expect(frames).toHaveLength(1)
    expect(frames[0]!.chan).toBe(CH_CMS)
    expect(frames[0]!.payload.toString()).toBe('{"t":"ping"}')
  })

  test('reassembles a frame split across feeds', () => {
    const parser = new MuxParser()
    const frame = muxFrame(CH_CMS, Buffer.from('{"t":"ping"}'))

    expect(parser.feed(frame.subarray(0, 5))).toHaveLength(0)
    const frames = parser.feed(frame.subarray(5))

    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload.toString()).toBe('{"t":"ping"}')
  })

  // Ported verbatim from tools/host_sim/selftest.py :: test_mux
  test('resyncs past boot garbage and a corrupted frame', () => {
    const parser = new MuxParser()
    const f1 = muxFrame(CH_SAS, Buffer.from([0x81]))
    const f2 = muxFrame(CH_CMS, Buffer.from('{"t":"ping","id":1,"d":{}}'))

    const corrupted = Buffer.from(f1)
    corrupted[corrupted.length - 1]! ^= 0xff

    const stream = Buffer.concat([
      Buffer.from('ets Jun  8 2016 00:22:57\x7e\x01\xff', 'binary'),
      corrupted,
      f1,
      f2
    ])

    const out: Array<[number, string]> = []
    for (let i = 0; i < stream.length; i += 3) {
      for (const f of parser.feed(stream.subarray(i, i + 3))) {
        out.push([f.chan, f.payload.toString('binary')])
      }
    }

    expect(out).toEqual([
      [CH_SAS, '\x81'],
      [CH_CMS, '{"t":"ping","id":1,"d":{}}']
    ])
  })

  test('rejects an unknown channel by resyncing', () => {
    const parser = new MuxParser()
    const bogus = Buffer.from([0x7e, 0x55, 0x01, 0x00, 0x41, 0x00, 0x00])
    const good = muxFrame(CH_LOG, Buffer.from('log'))

    const frames = parser.feed(Buffer.concat([bogus, good]))

    expect(frames).toHaveLength(1)
    expect(frames[0]!.chan).toBe(CH_LOG)
  })
})
