import type { OsintReason, Player } from './api'

/**
 * The OSINT source registry — the link-launcher half of the Истражување tab.
 *
 * Every source here is a public website; the staff member's browser opens it
 * directly and the CMS never fetches, scrapes or stores anything from it. What
 * the CMS does store is that the lookup happened — who ran it, on whom, where
 * and why — which is the condition on which the panel exists at all (see
 * routes/osint.ts). The AI screening half of the tab is a different thing with
 * different rules; it lives in views/guest/OsintAi.tsx.
 *
 * Two kinds of source:
 *   query  — the site takes the term in its URL, so the tab lands on results.
 *   manual — the site has no query parameter (a POST form, a JS portal, a
 *            captcha), so we open the search page and put the term on the
 *            clipboard instead. Saying which is which is the honest thing to do.
 *
 * Source ids are stored in the audit log and key the per-tile history, so an
 * existing id must never be renamed.
 */

export type SourceMode = 'query' | 'manual'
export type Field = 'name' | 'phone' | 'email' | 'city' | 'doc_id' | 'dob'

/** A guest plus the server's spellings of their name (Cyrillic ↔ Latin, original first). */
export interface OsintContext {
  player: Player
  variants: string[]
}

export interface OsintSource {
  id: string
  label: string
  hint: string
  group: string
  mode: SourceMode
  /** Fields that must be present on the guest for the tile to be offered. */
  needs: Field[]
  /** The identifier shown on the tile and copied to the clipboard for a manual source. */
  term: (c: OsintContext) => string
  url: (c: OsintContext) => string
}

const q = (s: string) => encodeURIComponent(s)
const CYRILLIC = /\p{Script=Cyrillic}/u

function spellings(c: OsintContext): string[] {
  return c.variants.length > 0 ? c.variants : [c.player.name]
}

/** The first Latin spelling — what LinkedIn, sanctions lists and foreign sites index. */
function latin(c: OsintContext): string {
  return spellings(c).find((v) => !CYRILLIC.test(v)) ?? c.player.name
}

/** The first Cyrillic spelling — what Macedonian registries and courts index. */
function cyrillic(c: OsintContext): string {
  return spellings(c).find((v) => CYRILLIC.test(v)) ?? c.player.name
}

/** Every spelling as one OR query: ("Иван Илијевски" OR "Ivan Ilijevski"). */
function anyName(c: OsintContext): string {
  const all = spellings(c).map((v) => `"${v}"`)
  return all.length > 1 ? `(${all.join(' OR ')})` : (all[0] ?? '')
}

/** Every spelling plus city, which is what cuts a common name down. */
function nameTerm(c: OsintContext): string {
  return c.player.city ? `${anyName(c)} ${c.player.city}` : anyName(c)
}

export const GROUPS = [
  'Пребарување',
  'Социјални мрежи',
  'Санкции и ПЕП',
  'Регистри',
  'Телефон и е-пошта'
] as const

export const SOURCES: OsintSource[] = [
  {
    id: 'google',
    label: 'Google',
    hint: 'Сите варијанти на името, стеснето со град',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (c) => `https://www.google.com/search?q=${q(nameTerm(c))}`
  },
  {
    id: 'bing',
    label: 'Bing',
    hint: 'Друг индекс — наоѓа што Google испушта',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (c) => `https://www.bing.com/search?q=${q(nameTerm(c))}`
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    hint: 'Без персонализација на резултатите',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (c) => `https://duckduckgo.com/?q=${q(nameTerm(c))}`
  },
  {
    id: 'google_news',
    label: 'Google Вести',
    hint: 'Само објави во медиуми, на кирилица и латиница',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: anyName,
    url: (c) => `https://www.google.com/search?tbm=nws&q=${q(anyName(c))}`
  },
  {
    id: 'time_mk',
    label: 'TIME.mk',
    hint: 'Агрегатор на македонски вести',
    group: 'Пребарување',
    mode: 'manual',
    needs: ['name'],
    term: cyrillic,
    url: () => 'https://time.mk/'
  },
  {
    id: 'social_dork',
    label: 'Профили (site:)',
    hint: 'Facebook, Instagram, LinkedIn, TikTok и X одеднаш',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: anyName,
    url: (c) =>
      `https://www.google.com/search?q=${q(
        `${anyName(c)} (site:facebook.com OR site:instagram.com OR site:linkedin.com OR site:tiktok.com OR site:x.com)`
      )}`
  },
  {
    id: 'facebook',
    label: 'Facebook',
    hint: 'Пребарување на луѓе — бара најава',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: (c) => c.player.name,
    url: (c) => `https://www.facebook.com/search/people/?q=${q(c.player.name)}`
  },
  {
    id: 'instagram',
    label: 'Instagram',
    hint: 'Профили и објави — бара најава',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: latin,
    url: (c) => `https://www.instagram.com/explore/search/keyword/?q=${q(latin(c))}`
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    hint: 'Работно место и историја',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: latin,
    url: (c) => `https://www.linkedin.com/search/results/people/?keywords=${q(latin(c))}`
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    hint: 'Кориснички профили',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: latin,
    url: (c) => `https://www.tiktok.com/search/user?q=${q(latin(c))}`
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    hint: 'Кориснички профили — бара најава',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: latin,
    url: (c) => `https://x.com/search?q=${q(latin(c))}&f=user`
  },
  {
    id: 'opensanctions',
    label: 'OpenSanctions',
    hint: 'Обединува OFAC, ЕУ, ОН и ПЕП листи',
    group: 'Санкции и ПЕП',
    mode: 'query',
    needs: ['name'],
    term: latin,
    url: (c) => `https://www.opensanctions.org/search/?q=${q(latin(c))}`
  },
  {
    id: 'ofac',
    label: 'OFAC SDN',
    hint: 'Санкциска листа на САД',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: latin,
    url: () => 'https://sanctionssearch.ofac.treas.gov/'
  },
  {
    id: 'eu_sanctions',
    label: 'ЕУ санкции',
    hint: 'Консолидирана листа на ЕУ',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: latin,
    url: () => 'https://www.sanctionsmap.eu/#/main'
  },
  {
    id: 'un_sanctions',
    label: 'ОН консолидирана листа',
    hint: 'Совет за безбедност на ОН',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: latin,
    url: () => 'https://scsanctions.un.org/consolidated/'
  },
  {
    id: 'interpol',
    label: 'Интерпол потерници',
    hint: 'Црвени и жолти известувања',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: latin,
    url: () => 'https://www.interpol.int/How-we-work/Notices/Red-Notices/View-Red-Notices'
  },
  {
    id: 'dksk',
    label: 'ДКСК — избрани и именувани',
    hint: 'Изјави за имотна состојба на функционери (ПЕП)',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: cyrillic,
    url: () => 'https://imotnasostojba.dksk.mk/'
  },
  {
    id: 'crm_mk',
    label: 'Централен регистар',
    hint: 'Фирми и управители во РСМ',
    group: 'Регистри',
    mode: 'manual',
    needs: ['name'],
    term: cyrillic,
    url: () => 'https://www.crm.com.mk/mk/pocetna'
  },
  {
    id: 'court_mk',
    label: 'Судски предмети',
    hint: 'Портал на судовите на РСМ',
    group: 'Регистри',
    mode: 'manual',
    needs: ['name'],
    term: cyrillic,
    url: () => 'https://www.sud.mk/'
  },
  {
    id: 'phone_search',
    label: 'Број во пребарувач',
    hint: 'Огласи, фирми, објави со истиот број',
    group: 'Телефон и е-пошта',
    mode: 'query',
    needs: ['phone'],
    term: (c) => c.player.phone ?? '',
    url: (c) => `https://www.google.com/search?q=${q(`"${c.player.phone}"`)}`
  },
  {
    id: 'truecaller',
    label: 'Truecaller',
    hint: 'Пријавено име зад бројот',
    group: 'Телефон и е-пошта',
    mode: 'manual',
    needs: ['phone'],
    term: (c) => c.player.phone ?? '',
    url: () => 'https://www.truecaller.com/'
  },
  {
    id: 'email_search',
    label: 'Е-пошта во пребарувач',
    hint: 'Каде се појавува адресата',
    group: 'Телефон и е-пошта',
    mode: 'query',
    needs: ['email'],
    term: (c) => c.player.email ?? '',
    url: (c) => `https://www.google.com/search?q=${q(`"${c.player.email}"`)}`
  },
  {
    id: 'hibp',
    label: 'Have I Been Pwned',
    hint: 'Дали адресата е во протек на податоци',
    group: 'Телефон и е-пошта',
    mode: 'manual',
    needs: ['email'],
    term: (c) => c.player.email ?? '',
    url: () => 'https://haveibeenpwned.com/'
  }
]

/** Only the sources this guest actually has the fields for. */
export function availableSources(player: Player): OsintSource[] {
  return SOURCES.filter((s) =>
    s.needs.every((f) => {
      const v = player[f as keyof Player]
      return typeof v === 'string' && v.trim() !== ''
    })
  )
}

export const REASONS: Array<{ value: OsintReason; label: string; short: string }> = [
  { value: 'kyc', label: 'KYC — потврда на идентитет', short: 'KYC' },
  { value: 'aml', label: 'AML — проверка на потекло на средства', short: 'AML' },
  { value: 'self_exclusion', label: 'Барање за самоисклучување', short: 'Самоисклучување' },
  { value: 'dispute', label: 'Спор или инцидент со гостин', short: 'Спор' },
  { value: 'profile', label: 'Општ профил — сè јавно достапно (со фотографии)', short: 'Профил' },
  { value: 'other', label: 'Друго', short: 'Друго' }
]

export function reasonShort(reason: string | null | undefined): string {
  return REASONS.find((r) => r.value === reason)?.short ?? reason ?? '—'
}
