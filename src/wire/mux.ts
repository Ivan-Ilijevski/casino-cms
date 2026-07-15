// Mux framing shared with the SMIB firmware (main/mux/mux.c), the host
// simulator (tools/host_sim/mux.py) and the slot game's bridge
// (shining-crown/src/lib/sas/muxCodec.ts). Ported from those — the wire format
// is fixed, do not "improve" it:
//
//   [0x7E][chan][len_lo][len_hi][payload...][crc_lo][crc_hi]
//
// CRC-16/KERMIT over chan+len+payload, appended LSB first. No byte stuffing:
// parsers resync by scanning for 0x7E and validating chan/len sanity + CRC.

export const CH_SAS = 0x01
export const CH_CMS = 0x02
export const CH_LOG = 0x7f
export const VALID_CHANNELS = new Set([CH_SAS, CH_CMS, CH_LOG])
export const MAX_PAYLOAD = 2048
export const SYNC = 0x7e

export interface MuxFrame {
  chan: number
  payload: Buffer
}

/** CRC-16/KERMIT, appended LSB-first. */
export function crc16Kermit(data: Buffer | Uint8Array, initial = 0x0000): number {
  let crc = initial
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1
    }
  }
  return crc
}

export function muxFrame(chan: number, payload: Buffer | Uint8Array): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error('payload too large')
  }
  const body = Buffer.concat([
    Buffer.from([chan, payload.length & 0xff, payload.length >> 8]),
    Buffer.from(payload)
  ])
  const crc = crc16Kermit(body)
  return Buffer.concat([Buffer.from([SYNC]), body, Buffer.from([crc & 0xff, crc >> 8])])
}

/**
 * Incremental parser with the same resync semantics as the firmware: on any
 * rejected candidate frame, rescan from the byte after its 0x7E.
 */
export class MuxParser {
  private buf = Buffer.alloc(0)

  feed(data: Buffer | Uint8Array): MuxFrame[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(data)])
    const frames: MuxFrame[] = []

    for (;;) {
      const idx = this.buf.indexOf(SYNC)
      if (idx < 0) {
        this.buf = Buffer.alloc(0)
        break
      }
      if (idx > 0) {
        this.buf = this.buf.subarray(idx)
      }
      if (this.buf.length < 4) {
        break
      }
      const chan = this.buf[1]!
      const length = this.buf[2]! | (this.buf[3]! << 8)
      if (!VALID_CHANNELS.has(chan) || length > MAX_PAYLOAD) {
        this.buf = this.buf.subarray(1)
        continue
      }
      const total = 4 + length + 2
      if (this.buf.length < total) {
        break
      }
      const crc = crc16Kermit(this.buf.subarray(1, 4 + length))
      const rxCrc = this.buf[4 + length]! | (this.buf[5 + length]! << 8)
      if (crc !== rxCrc) {
        this.buf = this.buf.subarray(1)
        continue
      }
      frames.push({ chan, payload: Buffer.from(this.buf.subarray(4, 4 + length)) })
      this.buf = this.buf.subarray(total)
    }

    return frames
  }
}
