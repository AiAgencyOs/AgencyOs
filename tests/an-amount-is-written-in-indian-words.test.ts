import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amountInWords, rupeesInWords } from '@/lib/money/amount-in-words';

test('the reference quotation total reads as the reference words', () => {
  assert.equal(amountInWords(11_210_000), 'One Lakh Twelve Thousand One Hundred Indian Rupees Only');
});

test('Indian grouping: thousand, lakh, crore', () => {
  assert.equal(rupeesInWords(1000), 'One Thousand');
  assert.equal(rupeesInWords(250_000), 'Two Lakh Fifty Thousand');
  assert.equal(rupeesInWords(12_345_678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
  assert.equal(rupeesInWords(100_000_000), 'Ten Crore');
});

test('teens, round tens and zero', () => {
  assert.equal(rupeesInWords(0), 'Zero');
  assert.equal(rupeesInWords(19), 'Nineteen');
  assert.equal(rupeesInWords(40), 'Forty');
  assert.equal(rupeesInWords(101), 'One Hundred One');
});

test('one rupee is singular and paise follow "and"', () => {
  assert.equal(amountInWords(100), 'One Indian Rupee Only');
  assert.equal(amountInWords(12_550), 'One Hundred Twenty Five Indian Rupees and Fifty Paise Only');
  assert.equal(amountInWords(5), 'Zero Indian Rupees and Five Paise Only');
});

test('another currency, a negative or a fractional amount is not worded', () => {
  assert.equal(amountInWords(10_000, 'USD'), null);
  assert.equal(amountInWords(-1), null);
  assert.equal(amountInWords(1.5), null);
});
