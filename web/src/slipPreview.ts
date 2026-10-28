/**
 * Sample slips for web/slip-preview.html — dev only, never bundled.
 *
 * The cases cover what changes the layout: the optional lines (address, order number,
 * description), both directions, points instead of denars, and values long enough to
 * shorten the labels and then be cut with an ellipsis.
 */

import type { PaymentSlip } from './api'
import { paymentSlipPng } from './paymentSlip'

const base: PaymentSlip = {
  address: 'ул. Македонија бр. 1, Скопје',
  at: new Date().toISOString(),
  card: '**** 5AF4',
  playerName: 'Марко Петровски',
  direction: 'debit',
  pay: 'cash',
  amountDeni: 45000,
  amountPoints: 0,
  label: null,
  orderNumber: 128,
  reference: '3F9A0C1B',
  pinVerified: true,
  staff: 'barman',
  balanceBeforeDeni: 1300000,
  pointsBefore: 340,
  balanceDeni: 1255000,
  points: 340
}

const samples: { title: string; note: string; slip: PaymentSlip }[] = [
  { title: 'Bar sale', note: 'order number, PIN checked', slip: base },
  {
    title: 'Наплата',
    note: 'custom charge: an order and a description, no PIN',
    slip: {
      ...base,
      orderNumber: 129,
      label: 'Чипови',
      amountDeni: 500000,
      pinVerified: false,
      balanceBeforeDeni: 1755000
    }
  },
  {
    title: 'Исплата',
    note: 'credit: no order, amount prints with +',
    slip: {
      ...base,
      direction: 'credit',
      orderNumber: null,
      label: 'Чипови',
      amountDeni: 1200000,
      balanceBeforeDeni: 55000
    }
  },
  {
    title: 'Paid in points',
    note: 'no address configured',
    slip: { ...base, address: null, pay: 'points', amountDeni: 0, amountPoints: 250, points: 90 }
  },
  {
    title: 'Overflow',
    note: 'long values: labels shorten, then values cut',
    slip: {
      ...base,
      address: 'Бул. Партизански одреди бр. 123, влез 4, кат 2, Скопје 1000, Северна Македонија',
      playerName: 'Александра Христовска-Стојановска Димитриевска',
      staff: 'aleksandar.petrovski',
      orderNumber: 130,
      label: 'Друго — долг опис на наплатата што не собира',
      amountDeni: 999999999,
      balanceBeforeDeni: 13345678899,
      pointsBefore: 1234567,
      balanceDeni: 12345678900,
      points: 1234567
    }
  }
]

const slips = document.getElementById('slips')!
const zoom = document.getElementById('zoom') as HTMLInputElement

zoom.addEventListener('change', () => document.body.classList.toggle('zoom', zoom.checked))

for (const { title, note, slip } of samples) {
  const figure = document.createElement('figure')
  const caption = document.createElement('figcaption')
  caption.textContent = title
  figure.append(caption)
  slips.append(figure)

  paymentSlipPng(slip).then(
    async (png) => {
      const img = new Image()
      img.src = URL.createObjectURL(png)
      await img.decode()
      const size = document.createElement('small')
      // 8 dots per mm on the X5.
      size.textContent = `${note} · ${img.naturalWidth}×${img.naturalHeight} dots, ${Math.round(img.naturalHeight / 8)}mm of paper`
      caption.append(size)
      const paper = document.createElement('div')
      paper.className = 'paper'
      paper.append(img)
      figure.append(paper)
    },
    (err: unknown) => {
      const error = document.createElement('pre')
      error.className = 'error'
      error.textContent = String(err instanceof Error ? (err.stack ?? err.message) : err)
      figure.append(error)
    }
  )
}
