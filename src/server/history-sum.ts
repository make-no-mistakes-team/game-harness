const binary64 = new DataView(new ArrayBuffer(8));
const fractionMask = (1n << 52n) - 1n;
const implicitBit = 1n << 52n;
const overflowCoefficient = 1n << 2098n;
// Unlike $, this end assertion does not accept a final line terminator.
const canonicalCoefficient = /^(?:0|-?[1-9][0-9]*)(?![\s\S])/;

function readCoefficient(state: string): bigint {
  if (typeof state !== "string" || !canonicalCoefficient.test(state)) {
    throw new TypeError(
      "History sum state must be a canonical decimal integer",
    );
  }
  return BigInt(state);
}

/**
 * Add or remove a finite binary64 contribution without rounding the total.
 * State is a canonical signed decimal coefficient in Number.MIN_VALUE units;
 * exact cancellation is '0', including contributions of either signed zero.
 * This descriptive-metric helper does not change authoritative native timing.
 */
export function addHistorySum(
  state: string,
  value: number,
  subtract = false,
): string {
  const coefficient = readCoefficient(state);
  if (!Number.isFinite(value)) {
    throw new RangeError("History sum value must be finite");
  }
  if (value === 0) return state;

  binary64.setFloat64(0, value, false);
  const bits = binary64.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & fractionMask;
  // Normal exponent E contributes (2^52 + fraction) * 2^(E - 1)
  // minimum-subnormal units; subnormals already store that coefficient.
  const magnitude =
    exponent === 0
      ? fraction
      : (implicitBit | fraction) << BigInt(exponent - 1);
  const negative = value < 0 !== subtract;
  return (coefficient + (negative ? -magnitude : magnitude)).toString();
}

/** Round the exact total once to binary64, nearest with ties to even. */
export function historySumValue(state: string): number {
  const coefficient = readCoefficient(state);
  if (coefficient === 0n) return 0;

  const negative = coefficient < 0n;
  const magnitude = negative ? -coefficient : coefficient;
  // Values at or above 2^1024 overflow regardless of the discarded bits.
  if (magnitude >= overflowCoefficient) {
    return negative ? -Infinity : Infinity;
  }

  const shift = Math.max(0, magnitude.toString(2).length - 53);
  const discardedBits = BigInt(shift);
  let significand = magnitude >> discardedBits;
  if (shift > 0) {
    const remainder = magnitude - (significand << discardedBits);
    const halfway = 1n << BigInt(shift - 1);
    if (
      remainder > halfway ||
      (remainder === halfway && (significand & 1n) !== 0n)
    ) {
      significand += 1n;
    }
  }

  // The integer significand (including a carry to 2^53) and scale are exact.
  // Multiplication handles normal/subnormal transitions and rounded overflow.
  const rounded = Number(significand) * 2 ** (shift - 1074);
  return negative ? -rounded : rounded;
}
