/**
 * Relative weight of a response, in API-price dollars. Subscription limits are not published per
 * model, but they track how expensive the work is, so this is used only to split usage between
 * models, efforts and projects ("Opus spent 3x what Sonnet did"), never as a bill.
 */
interface Price {
  input: number;
  output: number;
}

const PER_MTOK: Record<'opus' | 'opusLegacy' | 'sonnet' | 'haiku', Price> = {
  opus: { input: 5, output: 25 },
  opusLegacy: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.includes('haiku')) {
    return PER_MTOK.haiku;
  }
  if (m.includes('opus')) {
    // Opus 3, 4 and 4.1 were priced higher than later Opus models.
    return /claude-3-opus|opus-4-(0|1)\b|opus-4-\d{8}|opus-4$/.test(m) ? PER_MTOK.opusLegacy : PER_MTOK.opus;
  }
  return PER_MTOK.sonnet;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function costOf(model: string, usage: any): number {
  const p = priceFor(model);
  const write1h = n(usage?.cache_creation?.ephemeral_1h_input_tokens);
  const writeTotal = n(usage?.cache_creation_input_tokens);
  const write5m = Math.max(0, writeTotal - write1h);
  const inputUnits = n(usage?.input_tokens) + write5m * 1.25 + write1h * 2 + n(usage?.cache_read_input_tokens) * 0.1;
  return (inputUnits * p.input + n(usage?.output_tokens) * p.output) / 1_000_000;
}
