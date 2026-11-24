/**
 * Gate 2 — exact decimal <-> raw-unit conversions (bigint, no float math).
 *
 * The previous SELL path computed `Math.round(tokenAmount * 10 ** decimals)`
 * BEFORE the safe-integer check: the multiplication itself could lose
 * precision for large raw amounts or fine decimals, silently sending a
 * wrong sell quantity to Jupiter. Every conversion here goes through
 * exact decimal STRINGS and bigint — never float multiplication.
 */

/** Matches a plain or exponent-notation decimal number string, e.g. 12, 12.5, 1e-7, 1.5e21. */
const DECIMAL_RE = /^\d*\.?\d+(?:[eE][+-]?\d+)?$/;

export interface DecimalParts {
  /** All significant digits, no dot, no leading zeros (except a lone "0"). */
  digits: string;
  /** Number of fractional digits in the plain-decimal representation. */
  fracLen: number;
  /** Power-of-ten exponent (from e-notation, 0 when absent). */
  exp: number;
}

/** Splits a decimal string (shortest round-trip form of a float64) into exact parts. */
export function parseDecimalString(s: string): DecimalParts | null {
  const str = s.trim();
  if (!DECIMAL_RE.test(str)) return null;
  const [mant, expRaw] = str.toLowerCase().split('e');
  const exp = expRaw ? Number(expRaw) : 0;
  if (!Number.isSafeInteger(exp)) return null;
  const dot = mant.indexOf('.');
  const fracLen = dot === -1 ? 0 : mant.length - dot - 1;
  let digits = mant.replace('.', '');
  // Trim leading zeros but keep at least one digit.
  digits = digits.replace(/^0+(?=\d)/, '');
  return { digits, fracLen, exp };
}

/**
 * Exact conversion of a positive decimal number to raw base units scaled by
 * `decimals`. Returns null when the value is finer than the base unit
 * (would require rounding — callers must FAIL, never silently round) or
 * the input is not a finite positive number.
 */
export function decimalNumberToRawUnits(n: number, decimals: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const parts = parseDecimalString(n.toString());
  if (!parts) return null;

  // Value = digits * 10^(exp - fracLen). Raw = digits * 10^(exp - fracLen + decimals).
  const shift = parts.exp - parts.fracLen + decimals;
  const digits = parts.digits;
  if (shift >= 0) {
    return digits + '0'.repeat(shift);
  }
  // shift < 0: we must divide by 10^(-shift). Exact ONLY if the dropped
  // digits are all zeros.
  const cut = -shift;
  if (cut >= digits.length) {
    // Result < 1 raw unit. Non-zero input means sub-unit dust → reject.
    return /^0*$/.test(digits) ? '0' : null;
  }
  const keep = digits.slice(0, digits.length - cut);
  const dropped = digits.slice(digits.length - cut);
  if (!/^0*$/.test(dropped)) return null; // refuse to round
  return keep.replace(/^0+(?=\d)/, '') || '0';
}

/** Exact raw units -> human decimal string (no float math). */
export function rawUnitsToDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) throw new Error('RAW_UNITS_INVALID');
  if (decimals === 0) return raw.replace(/^0+(?=\d)/, '') || '0';
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/** Exact raw units -> float64 (for interfaces that still carry `number`). Safe for sane magnitudes. */
export function rawUnitsToNumber(raw: string, decimals: number): number {
  return Number(rawUnitsToDecimalString(raw, decimals));
}

/**
 * Scales a raw token quantity by a percentage in bps using EXACT integer
 * math, rounded DOWN (never oversell: a dust remainder stays on-chain
 * instead of triggering INSUFFICIENT_QUANTITY).
 */
export function scaleRawByBps(raw: string, bps: number): string {
  if (!/^\d+$/.test(raw)) throw new Error('RAW_UNITS_INVALID');
  if (!Number.isInteger(bps) || bps <= 0 || bps > 10_000) {
    throw new Error('SELL_BPS_OUT_OF_RANGE');
  }
  const scaled = (BigInt(raw) * BigInt(bps)) / 10_000n;
  return scaled.toString();
}
