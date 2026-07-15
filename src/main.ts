import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { sweepIdleSessions } from './domain/sessions.js'
import { CmsEvents } from './events.js'
import { createStaffApp } from './http/server.js'
import { createVoucherApp } from './http/voucherLegacy.js'
import { CmsTcpServer } from './wire/tcpServer.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDb(config.dbPath)
  const events = new CmsEvents()

  // 1) The SMIB terminal link — drop-in for tools/host_sim/cms_server.py.
  const tcp = new CmsTcpServer(
    {
      db,
      pointsPerMkd: config.pointsPerMkd,
      currency: config.currency,
      onOrderCreated: (orderId) => events.emit('order.created', { orderId })
    },
    config.tcpPort
  )
  const tcpPort = await tcp.start()

  // 2) The legacy voucher API — drop-in for voucher-server.js. The slot game
  //    talks to this with no changes, so it must own port 8080.
  const voucherApp = createVoucherApp({
    db,
    apiKey: config.voucherApiKey,
    ticketExpiryDays: config.ticketExpiryDays
  })
  const voucherServer = voucherApp.listen(config.voucherPort)

  // 3) The staff dashboard.
  const staffApp = createStaffApp({ db, config, events, pushes: tcp })
  const staffServer = staffApp.listen(config.httpPort)

  // Server-side idle logout, in case a terminal dies holding a session open.
  const sweep = setInterval(() => {
    try {
      for (const session of sweepIdleSessions(db, config.sessionIdleMs)) {
        tcp.pushLogout(session.sid)
      }
    } catch (err) {
      console.error('[cms] idle sweep failed:', err)
    }
  }, 30_000)
  sweep.unref()

  console.log('casino-cms up')
  console.log(`  terminal (SMIB) TCP : ${tcpPort}`)
  console.log(`  legacy voucher API  : http://localhost:${config.voucherPort}`)
  console.log(`  staff app           : http://localhost:${config.httpPort}`)
  console.log(`  database            : ${config.dbPath}`)
  if (config.sessionSecret === 'change-me-in-production') {
    console.warn('  WARNING: CMS_SESSION_SECRET is still the default — set it before production.')
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down`)
    clearInterval(sweep)
    await tcp.stop()
    voucherServer.close()
    staffServer.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
