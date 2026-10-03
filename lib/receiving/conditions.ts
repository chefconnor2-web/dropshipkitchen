export const CONDITIONS = {
  OK: "OK",
  SPOILED: "Spoiled / moldy",
  DAMAGED: "Damaged / crushed",
  TEMPERATURE: "Wrong temperature",
  SHORT: "Short / missing",
  WRONG_ITEM: "Wrong item",
} as const;

export type Condition = keyof typeof CONDITIONS;

export function isCondition(v: string): v is Condition {
  return Object.hasOwn(CONDITIONS, v);
}
