import { expect, test } from "bun:test";
import { addHistorySum, historySumValue } from "../src/server/history-sum.ts";

function sum(values: readonly number[]) {
  let state = "0";
  for (const value of values) state = addHistorySum(state, value);
  return state;
}

test("replacing a huge early receipt retains the small independent remainder", () => {
  let distance = sum([2 ** 53, 1, 1]);
  distance = addHistorySum(distance, 2 ** 53, true);
  expect(historySumValue(distance)).toBe(2);
  let spans = sum([2 ** 53, 1, 1, 1]);
  spans = addHistorySum(spans, 2 ** 53, true);
  expect(historySumValue(spans)).toBe(3);
});

test("subnormal receipt totals cross the normal boundary without losing their quantum", () => {
  const largestSubnormal = (2 ** 52 - 1) * Number.MIN_VALUE;
  let state = sum([largestSubnormal, Number.MIN_VALUE]);
  expect(historySumValue(state)).toBe(2 ** -1022);
  state = addHistorySum(state, Number.MIN_VALUE, true);
  expect(historySumValue(state)).toBe(largestSubnormal);
  state = addHistorySum(state, largestSubnormal, true);
  expect(historySumValue(state)).toBe(0);
});

test("metric output rounds exact halfway totals to the even binary64 neighbor", () => {
  expect(historySumValue(sum([1, 2 ** -53]))).toBe(1);
  expect(historySumValue(sum([1, Number.EPSILON, 2 ** -53]))).toBe(
    1 + 2 * Number.EPSILON,
  );
  expect(historySumValue(sum([-1, -(2 ** -53)]))).toBe(-1);
  expect(historySumValue(sum([-1, -Number.EPSILON, -(2 ** -53)]))).toBe(
    -(1 + 2 * Number.EPSILON),
  );
});

test("a rounded overflow does not destroy the persisted finite contribution state", () => {
  let state = sum([Number.MAX_VALUE, Number.MAX_VALUE]);
  expect(historySumValue(state)).toBe(Infinity);
  state = addHistorySum(state, Number.MAX_VALUE, true);
  expect(historySumValue(state)).toBe(Number.MAX_VALUE);
  state = addHistorySum(state, Number.MAX_VALUE, true);
  expect(historySumValue(state)).toBe(0);
});

test("tiny signed corrections survive cancellation of a much larger current total", () => {
  let state = sum([Number.MAX_VALUE, -Number.MIN_VALUE]);
  expect(historySumValue(state)).toBe(Number.MAX_VALUE);
  state = addHistorySum(state, Number.MAX_VALUE, true);
  expect(historySumValue(state)).toBe(-Number.MIN_VALUE);
  state = addHistorySum(state, Number.MIN_VALUE);
  expect(historySumValue(state)).toBe(0);
  expect(historySumValue(sum([0.1, 0.2, -0.3]))).toBe(2 ** -55);
});

test("finite binary64 boundary receipts keep their exact single-contribution value", () => {
  for (const value of [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    2 ** -1022,
    -(2 ** -1022),
    1 - Number.EPSILON / 2,
    1,
    1 + Number.EPSILON,
    2 ** 53,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]) {
    expect(historySumValue(addHistorySum("0", value))).toBe(
      value === 0 ? 0 : value,
    );
  }
});

test("nonfinite receipts and corrupted durable sum states fail instead of inventing totals", () => {
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => addHistorySum("0", value)).toThrow();
  for (const state of ["", "not-a-sum", "1.5", " 1", "+1", "01", "-0"]) {
    expect(() => addHistorySum(state, 1)).toThrow();
    expect(() => historySumValue(state)).toThrow();
  }
});
