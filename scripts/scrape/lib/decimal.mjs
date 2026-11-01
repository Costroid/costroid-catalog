const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function parts(text) {
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`not a decimal string: ${JSON.stringify(text)}`);
  const fraction = match[2] ?? '';
  return { digits: BigInt(match[1] + fraction), scale: fraction.length };
}

export function compareDecimals(left, right) {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.digits * 10n ** BigInt(scale - a.scale);
  const scaledB = b.digits * 10n ** BigInt(scale - b.scale);
  if (scaledA < scaledB) return -1;
  return scaledA > scaledB ? 1 : 0;
}

export function maxDecimal(values) {
  return values.reduce((best, value) => (compareDecimals(value, best) > 0 ? value : best));
}

export function isPositive(text) {
  return parts(text).digits > 0n;
}

// Per-token prices from LiteLLM (JSON numbers) and OpenRouter (strings) become per-million decimal strings.
export function perTokenToPerMillion(value) {
  const text = typeof value === 'number' ? value.toString() : value;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) throw new Error(`not a per-token price: ${JSON.stringify(value)}`);
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0) + 6 - fraction.length;
  const digits = BigInt(match[1] + fraction);
  if (exponent >= 0) return (digits * 10n ** BigInt(exponent)).toString();
  const padded = digits.toString().padStart(1 - exponent, '0');
  const point = padded.length + exponent;
  const decimal = `${padded.slice(0, point)}.${padded.slice(point)}`;
  return decimal.replace(/\.?0+$/, '');
}
