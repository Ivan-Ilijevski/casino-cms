import { describe, expect, test } from 'vitest'
import { nameVariants, titleCase, toCyrillic, toLatin } from '../src/domain/translit.js'

describe('toLatin', () => {
  test('uses passport digraphs by default', () => {
    expect(toLatin('Иван Илијевски')).toBe('Ivan Ilijevski')
    expect(toLatin('Ѓорѓи Кожувчанов')).toBe('Gjorgji Kozhuvchanov')
    expect(toLatin('Џемаил Ќосески')).toBe('Dzhemail Kjoseski')
    expect(toLatin('Љубиша Њаголов Ѕвездов')).toBe('Ljubisha Njagolov Dzvezdov')
  })

  test('diacritic and plain styles are the other spellings in real use', () => {
    expect(toLatin('Ѓорѓиевски Жарко', 'diacritic')).toBe('Đorđievski Žarko')
    expect(toLatin('Ѓорѓиевски Жарко', 'plain')).toBe('Gorgievski Zarko')
  })
})

describe('toCyrillic', () => {
  test('matches the longest digraph first', () => {
    expect(toCyrillic('Nemanja Paunovski')).toBe('Немања Пауновски')
    expect(toCyrillic('Dzhemail Kjoseski')).toBe('Џемаил Ќосески')
    expect(toCyrillic('Gjorgji Zhivkov')).toBe('Ѓорѓи Живков')
  })

  test('reads the diacritic romanisation too', () => {
    expect(toCyrillic('Đorđievski Žarko')).toBe('Ѓорѓиевски Жарко')
  })

  test('converts only the Latin words of a mixed name', () => {
    expect(toCyrillic('Иван Ilijevski')).toBe('Иван Илијевски')
  })
})

test('titleCase normalises shouting and hyphenated surnames', () => {
  expect(titleCase('  ПЕТАР   зулумовски-ИВАНОВ ')).toBe('Петар Зулумовски-Иванов')
})

describe('nameVariants', () => {
  test('a Cyrillic name yields its Latin spellings, original first', () => {
    expect(nameVariants('ПЕТАР Зулумовски')).toEqual(['Петар Зулумовски', 'Petar Zulumovski'])
    expect(nameVariants('Ѓорѓи Ќосески')).toEqual([
      'Ѓорѓи Ќосески',
      'Gjorgji Kjoseski',
      'Đorđi Ćoseski',
      'Gorgi Koseski'
    ])
  })

  test('a Latin name yields its Cyrillic spelling', () => {
    expect(nameVariants('Valentino Petkovski')).toEqual(['Valentino Petkovski', 'Валентино Петковски'])
  })

  test('never more than four, never a duplicate, nothing for a blank name', () => {
    const v = nameVariants('Đorđe Živković')
    expect(v.length).toBeLessThanOrEqual(4)
    expect(new Set(v.map((x) => x.toLowerCase())).size).toBe(v.length)
    expect(nameVariants('   ')).toEqual([])
  })
})
