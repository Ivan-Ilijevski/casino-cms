import type { StaffRole } from './api'

/**
 * What each role means, in one place. The server is the authority on what a
 * role may actually do — this is only how it reads on screen.
 */
export const ROLE_MK: Record<StaffRole, string> = {
  admin: 'администратор',
  staff: 'персонал',
  bar: 'шанк'
}

export const ROLE_HINT_MK: Record<StaffRole, string> = {
  admin: 'Целосен пристап, вклучително корисници и извештаи.',
  staff: 'Шалтерска работа: каса, гости, тикети и нарачки.',
  bar: 'Само нарачки и мени — за таблетот на шанкот.'
}

export const ROLE_OPTIONS: StaffRole[] = ['admin', 'staff', 'bar']
