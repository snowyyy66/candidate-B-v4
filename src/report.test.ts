import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, type Input, type Work } from './report.ts';

const contract = { contractId: 'D-1', contractor: 'Подрядчик', amount: 10000n, signedAt: '2026-01-01' };
const work: Work = { workId: 'W-1', contractId: 'D-1', title: 'Работа', price: 10000n, status: 'done', completedAt: '2026-01-02', cancelledAt: null };

function report(works: Work[], payments: Input['payments']) {
  return buildReport({ contracts: [contract], works, payments }, '2026-01-10')[0]!;
}

test('caps work payment at its price and reports excess as unallocated', () => {
  const row = report([work], [{ paymentId: 'P-1', contractId: 'D-1', workId: 'W-1', purpose: 'Оплата', amount: 12000n, status: 'paid', createdAt: '2026-01-03', paidAt: '2026-01-04', refundedAt: null }]);
  assert.equal(row.works[0]!.paid, 10000n);
  assert.equal(row.works[0]!.remaining, 0n);
  assert.equal(row.unallocatedPaid, 2000n);
  assert.equal(row.paid, 12000n);
});

test('excludes a payment queued after the report date', () => {
  const row = report([work], [{ paymentId: 'P-2', contractId: 'D-1', workId: null, purpose: 'В очереди', amount: 3000n, status: 'queued', createdAt: '2026-01-03', paidAt: null, refundedAt: null }]);
  assert.equal(row.paid, 0n);
  assert.equal(row.works[0]!.remaining, 10000n);
});

test('a cancelled work has no outstanding payable amount', () => {
  const cancelled: Work = { ...work, status: 'cancelled', completedAt: null, cancelledAt: '2026-01-05' };
  const row = report([cancelled], []);
  assert.equal(row.works[0]!.remaining, 0n);
  assert.equal(row.remaining, 0n);
});

test('counts a refund only from its refund date onward', () => {
  const payments: Input['payments'] = [{ paymentId: 'P-3', contractId: 'D-1', workId: null, purpose: 'Аванс', amount: 2000n, status: 'refunded', createdAt: '2026-01-02', paidAt: '2026-01-03', refundedAt: '2026-01-08' }];
  const beforeRefund = buildReport({ contracts: [contract], works: [work], payments }, '2026-01-05')[0]!;
  const afterRefund = buildReport({ contracts: [contract], works: [work], payments }, '2026-01-09')[0]!;
  assert.equal(beforeRefund.paid, 2000n);
  assert.equal(afterRefund.paid, 0n);
});
