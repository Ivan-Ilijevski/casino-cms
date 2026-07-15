/**
 * Loyalty points earned for a committed spend.
 *
 * Deliberately an integer ratio (points per whole MKD) rather than a
 * points-per-deni float: `amountDeni * pointsPerMkd` stays an exact integer, so
 * flooring can't drift the way `40000 * 0.01` would.
 */
export function pointsFor(amountDeni: number, pointsPerMkd: number): number {
  if (pointsPerMkd <= 0 || amountDeni <= 0) return 0
  return Math.floor((amountDeni * pointsPerMkd) / 100)
}
