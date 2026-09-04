import type { Player } from './api'

/**
 * The OSINT source registry.
 *
 * This is a LINK LAUNCHER and nothing more. Every source here is a public
 * website; the staff member's browser opens it directly and the CMS never
 * fetches, scrapes, stores or enriches anything. What the CMS does store is
 * that the lookup happened — who ran it, on whom, where and why — which is the
 * condition on which the panel exists at all (see routes/customers.ts).
 *
 * Two kinds of source:
 *   query  — the site takes the term in its URL, so the tab lands on results.
 *   manual — the site has no query parameter (a POST form, or a JS portal), so
 *            we open the search page and put the term on the clipboard instead.
 *            Saying which is which is the honest thing to do.
 */

export type SourceMode = 'query' | 'manual'
export type Field = 'name' | 'phone' | 'email' | 'city' | 'doc_id' | 'dob'

export interface OsintSource {
  id: string
  label: string
  hint: string
  group: string
  mode: SourceMode
  /** Fields that must be present on the guest for the tile to be offered. */
  needs: Field[]
  /** The identifier copied to the clipboard for a manual source. */
  term: (p: Player) => string
  url: (p: Player) => string
}

const q = (s: string) => encodeURIComponent(s)

/** Quoted full name plus city, which is what cuts a common name down. */
function nameTerm(p: Player): string {
  return p.city ? `"${p.name}" ${p.city}` : `"${p.name}"`
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
    hint: 'Име во наводници, стеснето со град',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (p) => `https://www.google.com/search?q=${q(nameTerm(p))}`
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    hint: 'Без персонализација на резултатите',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (p) => `https://duckduckgo.com/?q=${q(nameTerm(p))}`
  },
  {
    id: 'google_news',
    label: 'Google Вести',
    hint: 'Само објави во медиуми',
    group: 'Пребарување',
    mode: 'query',
    needs: ['name'],
    term: nameTerm,
    url: (p) => `https://www.google.com/search?tbm=nws&q=${q(`"${p.name}"`)}`
  },
  {
    id: 'social_dork',
    label: 'Профили (site:)',
    hint: 'Facebook, Instagram и LinkedIn одеднаш',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: (p) => p.name,
    url: (p) =>
      `https://www.google.com/search?q=${q(
        `"${p.name}" (site:facebook.com OR site:instagram.com OR site:linkedin.com)`
      )}`
  },
  {
    id: 'facebook',
    label: 'Facebook',
    hint: 'Пребарување на луѓе — бара најава',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: (p) => p.name,
    url: (p) => `https://www.facebook.com/search/people/?q=${q(p.name)}`
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    hint: 'Работно место и историја',
    group: 'Социјални мрежи',
    mode: 'query',
    needs: ['name'],
    term: (p) => p.name,
    url: (p) => `https://www.linkedin.com/search/results/people/?keywords=${q(p.name)}`
  },
  {
    id: 'opensanctions',
    label: 'OpenSanctions',
    hint: 'Обединува OFAC, ЕУ, ОН и ПЕП листи',
    group: 'Санкции и ПЕП',
    mode: 'query',
    needs: ['name'],
    term: (p) => p.name,
    url: (p) => `https://www.opensanctions.org/search/?q=${q(p.name)}`
  },
  {
    id: 'eu_sanctions',
    label: 'ЕУ санкции',
    hint: 'Консолидирана листа на ЕУ',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: (p) => p.name,
    url: () => 'https://www.sanctionsmap.eu/#/main'
  },
  {
    id: 'un_sanctions',
    label: 'ОН консолидирана листа',
    hint: 'Совет за безбедност на ОН',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: (p) => p.name,
    url: () => 'https://scsanctions.un.org/consolidated/'
  },
  {
    id: 'interpol',
    label: 'Интерпол потерници',
    hint: 'Црвени и жолти известувања',
    group: 'Санкции и ПЕП',
    mode: 'manual',
    needs: ['name'],
    term: (p) => p.name,
    url: () => 'https://www.interpol.int/How-we-work/Notices/Red-Notices/View-Red-Notices'
  },
  {
    id: 'crm_mk',
    label: 'Централен регистар',
    hint: 'Фирми и управители во РСМ',
    group: 'Регистри',
    mode: 'manual',
    needs: ['name'],
    term: (p) => p.name,
    url: () => 'https://www.crm.com.mk/mk/pocetna'
  },
  {
    id: 'court_mk',
    label: 'Судски предмети',
    hint: 'Портал на судовите на РСМ',
    group: 'Регистри',
    mode: 'manual',
    needs: ['name'],
    term: (p) => p.name,
    url: () => 'https://www.sud.mk/'
  },
  {
    id: 'phone_search',
    label: 'Број во пребарувач',
    hint: 'Огласи, фирми, објави со истиот број',
    group: 'Телефон и е-пошта',
    mode: 'query',
    needs: ['phone'],
    term: (p) => p.phone ?? '',
    url: (p) => `https://www.google.com/search?q=${q(`"${p.phone}"`)}`
  },
  {
    id: 'truecaller',
    label: 'Truecaller',
    hint: 'Пријавено име зад бројот',
    group: 'Телефон и е-пошта',
    mode: 'manual',
    needs: ['phone'],
    term: (p) => p.phone ?? '',
    url: () => 'https://www.truecaller.com/'
  },
  {
    id: 'email_search',
    label: 'Е-пошта во пребарувач',
    hint: 'Каде се појавува адресата',
    group: 'Телефон и е-пошта',
    mode: 'query',
    needs: ['email'],
    term: (p) => p.email ?? '',
    url: (p) => `https://www.google.com/search?q=${q(`"${p.email}"`)}`
  },
  {
    id: 'hibp',
    label: 'Have I Been Pwned',
    hint: 'Дали адресата е во протек на податоци',
    group: 'Телефон и е-пошта',
    mode: 'manual',
    needs: ['email'],
    term: (p) => p.email ?? '',
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

export const REASONS: Array<{ value: string; label: string }> = [
  { value: 'kyc', label: 'KYC — потврда на идентитет' },
  { value: 'aml', label: 'AML — проверка на потекло на средства' },
  { value: 'self_exclusion', label: 'Барање за самоисклучување' },
  { value: 'dispute', label: 'Спор или инцидент со гостин' },
  { value: 'other', label: 'Друго' }
]
