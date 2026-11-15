import { parse } from 'csv-parse/sync';

export type Contract = { contractId: string; contractor: string; amount: bigint; signedAt: string };
export type Work = { workId: string; contractId: string; title: string; price: bigint; status: 'planned' | 'done' | 'cancelled'; completedAt: string | null; cancelledAt: string | null };
export type Payment = { paymentId: string; contractId: string; workId: string | null; purpose: string; amount: bigint; status: 'paid' | 'queued' | 'refunded'; createdAt: string; paidAt: string | null; refundedAt: string | null };
export type Input = { contracts: Contract[]; works: Work[]; payments: Payment[] };
export type WorkRow = { workId: string; title: string; status: Work['status']; price: bigint; paid: bigint; remaining: bigint };
export type ContractRow = { contractId: string; contractor: string; amount: bigint; cancelledAmount: bigint; obligation: bigint; paid: bigint; remaining: bigint; overpayment: bigint; unallocatedPaid: bigint; works: WorkRow[] };

function csvRows<T>(text: string, required: string[], map: (row: Record<string, string>) => T): T[] {
  const records = parse(text.replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (records.length && required.some((column) => !(column in records[0]!))) throw new Error(`CSV не содержит обязательные колонки: ${required.filter((c) => !(c in records[0]!)).join(', ')}`);
  return records.map(map);
}

export function parseMoney(value: string, field: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(`Некорректная сумма в ${field}: ${value}`);
  const [rubles, fraction = ''] = value.trim().split('.');
  return BigInt(rubles!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function formatMoney(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')} ₽`;
}

function date(value: string, field: string, optional = false): string | null {
  const v = value.trim();
  if (!v && optional) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!match) throw new Error(`Некорректная дата в ${field}: ${value}`);
  const [, y, m, d] = match;
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d)) throw new Error(`Некорректная дата в ${field}: ${value}`);
  return v;
}

export function loadInput(contractsCsv: string, worksCsv: string, paymentsCsv: string): Input {
  const contracts = csvRows(contractsCsv, ['contract_id', 'contractor', 'amount', 'signed_at'], (r) => ({ contractId: r.contract_id!, contractor: r.contractor!, amount: parseMoney(r.amount!, `contracts.${r.contract_id}`), signedAt: date(r.signed_at!, 'signed_at')! }));
  const works = csvRows(worksCsv, ['work_id', 'contract_id', 'title', 'price', 'status', 'completed_at', 'cancelled_at'], (r) => {
    if (!['planned', 'done', 'cancelled'].includes(r.status!)) throw new Error(`Неизвестный статус работы ${r.work_id}: ${r.status}`);
    return { workId: r.work_id!, contractId: r.contract_id!, title: r.title!, price: parseMoney(r.price!, `works.${r.work_id}`), status: r.status as Work['status'], completedAt: date(r.completed_at ?? '', `works.${r.work_id}.completed_at`, true), cancelledAt: date(r.cancelled_at ?? '', `works.${r.work_id}.cancelled_at`, true) };
  });
  const payments = csvRows(paymentsCsv, ['payment_id', 'contract_id', 'work_id', 'purpose', 'amount', 'status', 'created_at', 'paid_at', 'refunded_at'], (r) => {
    if (!['paid', 'queued', 'refunded'].includes(r.status!)) throw new Error(`Неизвестный статус платежа ${r.payment_id}: ${r.status}`);
    return { paymentId: r.payment_id!, contractId: r.contract_id!, workId: r.work_id || null, purpose: r.purpose!, amount: parseMoney(r.amount!, `payments.${r.payment_id}`), status: r.status as Payment['status'], createdAt: date(r.created_at!, `payments.${r.payment_id}.created_at`)!, paidAt: date(r.paid_at ?? '', `payments.${r.payment_id}.paid_at`, true), refundedAt: date(r.refunded_at ?? '', `payments.${r.payment_id}.refunded_at`, true) };
  });
  return { contracts, works, payments };
}

function numericIdOrder(a: string, b: string): number {
  const aa = /^(.*?)(\d+)$/.exec(a); const bb = /^(.*?)(\d+)$/.exec(b);
  if (aa && bb && aa[1] === bb[1]) return Number(aa[2]) - Number(bb[2]);
  return a.localeCompare(b, 'en');
}
function isCancelledBy(work: Work, asOf: string): boolean { return work.status === 'cancelled' && work.cancelledAt! <= asOf; }
function isPaidBy(payment: Payment, asOf: string): boolean { return payment.paidAt !== null && payment.paidAt <= asOf && (payment.status === 'paid' || (payment.status === 'refunded' && payment.refundedAt! > asOf)); }
function assertUnique(values: string[], entity: string): void {
  const seen = new Set<string>();
  for (const value of values) { if (seen.has(value)) throw new Error(`Дублируется ${entity} ${value}`); seen.add(value); }
}
function validate(input: Input, asOf: string): void {
  date(asOf, 'report date');
  assertUnique(input.contracts.map((c) => c.contractId), 'договор');
  assertUnique(input.works.map((w) => w.workId), 'работа');
  assertUnique(input.payments.map((p) => p.paymentId), 'платёж');
  const contracts = new Set(input.contracts.map((c) => c.contractId));
  const works = new Map(input.works.map((w) => [w.workId, w]));
  for (const w of input.works) {
    if (!contracts.has(w.contractId)) throw new Error(`Для работы ${w.workId} не найден договор ${w.contractId}`);
    if (w.status === 'cancelled' && !w.cancelledAt) throw new Error(`У отменённой работы ${w.workId} не указана дата cancelled_at`);
  }
  for (const p of input.payments) {
    if (!contracts.has(p.contractId)) throw new Error(`Для платежа ${p.paymentId} не найден договор ${p.contractId}`);
    if (p.workId && works.get(p.workId)?.contractId !== p.contractId) throw new Error(`Платёж ${p.paymentId} ссылается на неизвестную работу/другой договор: ${p.workId}`);
    if (p.status === 'paid' && !p.paidAt) throw new Error(`У оплаченного платежа ${p.paymentId} не указана дата paid_at`);
    if (p.status === 'refunded' && !p.refundedAt) throw new Error(`У возвращённого платежа ${p.paymentId} не указана дата refunded_at`);
  }
}

export function buildReport(input: Input, asOf: string): ContractRow[] {
  validate(input, asOf);
  return input.contracts.map((contract) => {
    const works = input.works.filter((w) => w.contractId === contract.contractId).sort((a, b) => numericIdOrder(a.workId, b.workId));
    const paid = input.payments.filter((p) => p.contractId === contract.contractId && isPaidBy(p, asOf));
    const workPaid = new Map(works.map((w) => [w.workId, 0n]));
    let unallocatedPaid = 0n;
    for (const p of paid.filter((payment) => payment.workId !== null)) {
      const work = works.find((item) => item.workId === p.workId)!;
      if (p.purpose.toLocaleLowerCase('ru').includes('материал')) { unallocatedPaid += p.amount; continue; }
      const current = workPaid.get(work.workId)!;
      const capacity = isCancelledBy(work, asOf) || current >= work.price ? 0n : work.price - current;
      const applied = p.amount < capacity ? p.amount : capacity;
      workPaid.set(work.workId, current + applied);
      unallocatedPaid += p.amount - applied;
    }
    const activeWorks = works.filter((w) => !isCancelledBy(w, asOf));
    for (const p of paid.filter((payment) => payment.workId === null).sort((a, b) => a.paidAt!.localeCompare(b.paidAt!) || numericIdOrder(a.paymentId, b.paymentId))) {
      let left = p.amount;
      for (const w of activeWorks) {
        const current = workPaid.get(w.workId)!;
        const capacity = w.price > current ? w.price - current : 0n;
        const applied = left < capacity ? left : capacity;
        workPaid.set(w.workId, current + applied); left -= applied;
        if (left === 0n) break;
      }
      unallocatedPaid += left;
    }
    const workRows = works.map((w): WorkRow => {
      const cancelled = isCancelledBy(w, asOf);
      const status = (w.status !== 'planned' && ((w.status === 'done' && w.completedAt! > asOf) || cancelled && w.cancelledAt! > asOf)) ? 'planned' : w.status;
      const amountPaid = cancelled ? 0n : workPaid.get(w.workId)!;
      return { workId: w.workId, title: w.title, status, price: w.price, paid: amountPaid, remaining: cancelled ? 0n : w.price > amountPaid ? w.price - amountPaid : 0n };
    });
    const cancelledAmount = works.filter((w) => isCancelledBy(w, asOf)).reduce((sum, w) => sum + w.price, 0n);
    const obligation = contract.amount > cancelledAmount ? contract.amount - cancelledAmount : 0n;
    const paidTotal = paid.reduce((sum, p) => sum + p.amount, 0n);
    const obligationRemaining = obligation > paidTotal ? obligation - paidTotal : 0n;
    const workRemaining = workRows.reduce((sum, work) => sum + work.remaining, 0n);
    const remaining = obligationRemaining < workRemaining ? obligationRemaining : workRemaining;
    return { contractId: contract.contractId, contractor: contract.contractor, amount: contract.amount, cancelledAmount, obligation, paid: paidTotal, remaining, overpayment: paidTotal > obligation ? paidTotal - obligation : 0n, unallocatedPaid, works: workRows };
  });
}

export function renderReport(rows: ContractRow[], asOf: string): string {
  const out = [`Отчёт по состоянию на ${asOf}`, ''];
  for (const c of rows) {
    out.push(`${c.contractId} — ${c.contractor}`, `Сумма договора: ${formatMoney(c.amount)} | уменьшение по отменам: ${formatMoney(c.cancelledAmount)} | обязательство: ${formatMoney(c.obligation)} | выплачено: ${formatMoney(c.paid)} | осталось: ${formatMoney(c.remaining)}`);
    for (const w of c.works) out.push(`  ${w.workId} [${w.status}] ${w.title}: цена ${formatMoney(w.price)}, выплачено ${formatMoney(w.paid)}, осталось ${formatMoney(w.remaining)}`);
    if (c.unallocatedPaid > 0n) out.push(`  Не распределено по работам: ${formatMoney(c.unallocatedPaid)}`);
    if (c.overpayment > 0n) out.push(`  Переплата относительно обязательства: ${formatMoney(c.overpayment)}`);
    out.push('');
  }
  const totals = rows.reduce((a, c) => ({ amount: a.amount + c.amount, cancelled: a.cancelled + c.cancelledAmount, obligation: a.obligation + c.obligation, paid: a.paid + c.paid, remaining: a.remaining + c.remaining, overpayment: a.overpayment + c.overpayment, unallocated: a.unallocated + c.unallocatedPaid }), { amount: 0n, cancelled: 0n, obligation: 0n, paid: 0n, remaining: 0n, overpayment: 0n, unallocated: 0n });
  out.push(`ИТОГО: сумма договоров ${formatMoney(totals.amount)} | уменьшение ${formatMoney(totals.cancelled)} | обязательство ${formatMoney(totals.obligation)} | выплачено ${formatMoney(totals.paid)} | осталось ${formatMoney(totals.remaining)}`);
  if (totals.unallocated > 0n) out.push(`Не распределено по работам: ${formatMoney(totals.unallocated)}`);
  if (totals.overpayment > 0n) out.push(`Переплата относительно обязательств: ${formatMoney(totals.overpayment)}`);
  return out.join('\n');
}
