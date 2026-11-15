import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReport, loadInput, parseMoney, renderReport, type Input, type Work } from './report.ts';

const contract = { contractId: 'D-1', contractor: 'Подрядчик', amount: 10000n, signedAt: '2026-01-01' };
const work: Work = { workId: 'W-1', contractId: 'D-1', title: 'Работа', price: 10000n, status: 'done', completedAt: '2026-01-02', cancelledAt: null };
function payment(overrides: Partial<Input['payments'][number]> = {}): Input['payments'][number] {
  return { paymentId: 'P-1', contractId: 'D-1', workId: null, purpose: 'Оплата', amount: 2000n, status: 'paid', createdAt: '2026-01-03', paidAt: '2026-01-04', refundedAt: null, ...overrides };
}
function report(works: Work[], payments: Input['payments'], amount = contract.amount) {
  return buildReport({ contracts: [{ ...contract, amount }], works, payments }, '2026-01-10')[0]!;
}

test('uses valid integer cents and rejects invalid money', () => {
  assert.equal(parseMoney('12.3', 'amount'), 1230n);
  assert.throws(() => parseMoney('-1', 'amount'), /Некорректная сумма/);
});
test('rejects impossible calendar dates', () => {
  assert.throws(() => loadInput('contract_id,contractor,amount,signed_at\nD,Имя,1,2026-02-30', 'work_id,contract_id,title,price,status,completed_at,cancelled_at', 'payment_id,contract_id,work_id,purpose,amount,status,created_at,paid_at,refunded_at'), /Некорректная дата/);
});
test('rejects duplicate payment IDs', () => {
  assert.throws(() => report([work], [payment(), payment({ paymentId: 'P-1' })]), /Дублируется платёж/);
});
test('requires paid_at for paid and refunded_at for refunded payments', () => {
  assert.throws(() => report([work], [payment({ paidAt: null })]), /paid_at/);
  assert.throws(() => report([work], [payment({ status: 'refunded', refundedAt: null })]), /refunded_at/);
});
test('requires cancelled_at for cancelled work', () => {
  assert.throws(() => report([{ ...work, status: 'cancelled', cancelledAt: null }], []), /cancelled_at/);
});
test('caps direct work payment at price and labels surplus as overpayment', () => {
  const row = report([work], [payment({ workId: 'W-1', amount: 12000n })]);
  assert.equal(row.works[0]!.paid, 10000n);
  assert.equal(row.works[0]!.remaining, 0n);
  assert.equal(row.overpayment, 2000n);
  assert.equal(row.paid, 12000n);
});
test('allocates general payments over several works in numeric ID order', () => {
  const works = [9, 10].map((n) => ({ ...work, workId: `W-${n}`, price: 5000n }));
  const row = report(works, [payment({ amount: 7000n })]);
  assert.deepEqual(row.works.map((w) => [w.workId, w.paid]), [['W-9', 5000n], ['W-10', 2000n]]);
});
test('reallocates contract payments after cancellation and lowers contract obligation', () => {
  const works = [work, { ...work, workId: 'W-2' }, { ...work, workId: 'W-3' }];
  const payments = [payment({ amount: 12000n })];
  const before = buildReport({ contracts: [contract], works, payments }, '2026-01-04')[0]!;
  const after = buildReport({ contracts: [contract], works: [{ ...works[0]!, status: 'cancelled', cancelledAt: '2026-01-05' }, works[1]!, works[2]!], payments }, '2026-01-10')[0]!;
  assert.equal(before.works[0]!.paid, 10000n);
  assert.equal(after.works[0]!.paid, 0n);
  assert.equal(after.works[1]!.paid, 10000n);
  assert.equal(after.remaining, 0n);
});
test('shows payments above contract obligation explicitly as overpayment', () => {
  const row = report([work], [payment({ amount: 10000n })], 8000n);
  assert.equal(row.remaining, 0n);
  assert.equal(row.overpayment, 2000n);
});
test('contract balance does not exceed the sum of remaining work balances', () => {
  const row = report([{ ...work, price: 10000n }], [], 8000n);
  assert.equal(row.remaining, 8000n);
  assert.equal(row.works.reduce((sum, item) => sum + item.remaining, 0n), 10000n);
});
test('reports real sample arithmetic and leaves materials unassigned for review', () => {
  const dir = resolve('data');
  const input = loadInput(...(['contracts.csv', 'works.csv', 'payments.csv'].map((name) => readFileSync(resolve(dir, name), 'utf8')) as [string, string, string]));
  const rows = buildReport(input, '2026-11-10');
  assert.equal(rows[0]!.amount - rows[0]!.cancelledAmount, 50000000n);
  assert.equal(rows[0]!.remaining, 18500000n);
  assert.equal(rows[0]!.works.find((w) => w.workId === 'W-14')!.paid, 10000000n);
  assert.equal(rows[0]!.unallocatedPaid, 1500000n);
  assert.equal(rows[1]!.overpayment, 0n);
  assert.equal(rows[1]!.remaining, 1500000n);
  const output = renderReport(rows, '2026-11-10');
  assert.match(output, /уменьшение по отменам: 100000,00 ₽/);
  assert.match(output, /Не распределено по работам: 15000,00 ₽/);
  assert.doesNotMatch(output, /Переплата относительно обязательства: 5000,00 ₽/);
});
