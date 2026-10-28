/**
 * Macedonian Cyrillic <-> Latin, for search and nothing else.
 *
 * Guest names are typed however the staff member at the desk typed them —
 * `Иван Илијевски` next to `Valentino Petkovski` next to `ПЕТАР Зулумовски` —
 * while the web writes the same person both ways: a court notice in Cyrillic,
 * a LinkedIn profile or an OFAC entry in Latin. Searching the one spelling the
 * CMS happens to hold misses every hit in the other script.
 *
 * There is no single correct romanisation, so this produces the few spellings
 * that actually occur rather than one "right" one:
 *   ascii     — the passport/ICAO digraphs (Gjorgjievski, Kjoseski, Zhivkov)
 *   diacritic — the regional-media form (Đorđievski, Ćoseski, Živkov)
 *   plain     — digraphs flattened the way people type without them (Gorgievski)
 *
 * Nothing here is stored or used to match identity; it only widens a search.
 */

const CYR_ASCII: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'zh', з: 'z', ѕ: 'dz',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', џ: 'dzh',
  ш: 'sh',
  // Serbian letters turn up in names from across the region.
  ђ: 'dj', ћ: 'c'
}

const CYR_DIACRITIC: Record<string, string> = {
  ...CYR_ASCII,
  ѓ: 'đ', ж: 'ž', ќ: 'ć', ч: 'č', џ: 'dž', ш: 'š', ђ: 'đ', ћ: 'ć'
}

const CYR_PLAIN: Record<string, string> = {
  ...CYR_ASCII,
  ѓ: 'g', ж: 'z', ќ: 'k', ч: 'c', џ: 'dz', ш: 's', љ: 'l', њ: 'n', ђ: 'd', ћ: 'c'
}

/** Longest first: `dzh` must win over `dz`, and `dz` over `d`. */
const LAT_CYR: Array<[string, string]> = [
  ['dzh', 'џ'], ['dž', 'џ'],
  ['gj', 'ѓ'], ['kj', 'ќ'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'], ['lj', 'љ'], ['nj', 'њ'],
  ['dz', 'ѕ'], ['dj', 'ѓ'],
  ['đ', 'ѓ'], ['ǵ', 'ѓ'], ['ć', 'ќ'], ['ḱ', 'ќ'], ['č', 'ч'], ['š', 'ш'], ['ž', 'ж'],
  ['a', 'а'], ['b', 'б'], ['c', 'ц'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'],
  ['h', 'х'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'],
  ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'ј'], ['z', 'з']
]

const CYRILLIC = /\p{Script=Cyrillic}/u
const LATIN = /\p{Script=Latin}/u

function mapChars(word: string, table: Record<string, string>): string {
  let out = ''
  for (const ch of word.toLowerCase()) out += table[ch] ?? ch
  return out
}

function latinToCyrillic(word: string): string {
  const lower = word.toLowerCase()
  let out = ''
  let i = 0
  outer: while (i < lower.length) {
    for (const [lat, cyr] of LAT_CYR) {
      if (lower.startsWith(lat, i)) {
        out += cyr
        i += lat.length
        continue outer
      }
    }
    out += lower[i]
    i += 1
  }
  return out
}

/** `ПЕТАР зулумовски-ИВАНОВ` -> `Петар Зулумовски-Иванов`. Searches ignore case; people reading don't. */
export function titleCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split('-')
        .map((part) => {
          const lower = part.toLocaleLowerCase()
          const first = lower.charAt(0)
          return first ? first.toLocaleUpperCase() + lower.slice(1) : lower
        })
        .join('-')
    )
    .join(' ')
}

/** Word by word, so a half-Cyrillic, half-Latin name converts both halves. */
function eachWord(name: string, fn: (word: string) => string): string {
  return titleCase(
    name
      .trim()
      .split(/\s+/)
      .map((word) => fn(word))
      .join(' ')
  )
}

export function toLatin(name: string, style: 'ascii' | 'diacritic' | 'plain' = 'ascii'): string {
  const table = style === 'ascii' ? CYR_ASCII : style === 'diacritic' ? CYR_DIACRITIC : CYR_PLAIN
  return eachWord(name, (w) => (CYRILLIC.test(w) ? mapChars(w, table) : w))
}

export function toCyrillic(name: string): string {
  return eachWord(name, (w) => (LATIN.test(w) ? latinToCyrillic(w) : w))
}

/**
 * The spellings worth searching, original first, at most four, no duplicates.
 *
 * A Latin name is sent through Cyrillic and back so `Đorđievski` also yields
 * `Gjorgjievski` — the round trip is what normalises between the romanisations.
 */
export function nameVariants(name: string): string[] {
  const original = titleCase(name)
  if (!original) return []

  const candidates = CYRILLIC.test(original)
    ? [original, toLatin(original, 'ascii'), toLatin(original, 'diacritic'), toLatin(original, 'plain')]
    : [original, toCyrillic(original), toLatin(toCyrillic(original), 'ascii'), toLatin(toCyrillic(original), 'diacritic')]

  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const key = c.toLocaleLowerCase()
    if (!c || seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out.slice(0, 4)
}
