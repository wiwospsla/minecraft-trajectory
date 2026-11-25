import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, ucb, clampFinite } from './formulas.mjs';

test('mean: n=0 returns 0, not NaN', () => {
  assert.equal(mean(0, 0), 0);
  assert.equal(mean(0, 100), 0);
});

test('mean: normal case', () => {
  assert.equal(mean(4, 2), 0.5);
});

test('mean: NaN inputs fall back to 0', () => {
  assert.equal(mean(NaN, 5), 0);
  assert.equal(mean(5, NaN), 0);
});

test('ucb: n=0 returns the prior, not NaN/Infinity', () => {
  assert.equal(ucb(0, 0, 10), 10);
  assert.equal(ucb(0, 0, 10, 42), 42);
});

test('ucb: t=0 is treated as t=1 (no crash, no NaN)', () => {
  const score = ucb(3, 1, 0);
  assert.equal(Number.isFinite(score), true);
});

test('ucb: more visits with same mean shrinks the exploration bonus', () => {
  const few = ucb(1, 1, 100);
  const many = ucb(50, 50, 100);
  assert.ok(few > many, `expected few-visits score (${few}) > many-visits score (${many})`);
});

test('ucb: all-zero rewards still returns a finite number', () => {
  const score = ucb(10, 0, 10);
  assert.equal(Number.isFinite(score), true);
  assert.equal(score >= 0, true);
});

test('clampFinite: clamps into range', () => {
  assert.equal(clampFinite(5, 0, 10), 5);
  assert.equal(clampFinite(-5, 0, 10), 0);
  assert.equal(clampFinite(50, 0, 10), 10);
});

test('clampFinite: non-finite falls back', () => {
  assert.equal(clampFinite(NaN, 0, 10, 3), 3);
  assert.equal(clampFinite(Infinity, 0, 10, 7), 7);
});
