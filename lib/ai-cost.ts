// What an AI message costs us, from the token counts the API returns. Prices are Anthropic's first-party
// rates in US dollars per million tokens (cache writes at the 5-minute rate: 1.25× input).
// 1 cent = 10,000 micros.

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Array<[RegExp, Price]> = [
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/^claude-sonnet-5(-5)?\b/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/^claude-sonnet-4-6/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/^claude-opus-(5|4-[678])\b/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
];
/** An unknown model is priced like the most expensive one we use, so margins are never overstated. */
const FALLBACK: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Cost of one API response in micro-dollars ($1 = 1,000,000), rounded up. */
export function costMicros(model: string, u: TokenUsage): number {
  const p = PRICES.find(([re]) => re.test(model))?.[1] ?? FALLBACK;
  // $/MTok equals micros per token.
  const micros = u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite;
  return Math.ceil(micros);
}

export const MICROS_PER_CENT = 10_000;
