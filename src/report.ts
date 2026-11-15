import { parse } from 'csv-parse/sync';

export type Contract = { contractId: string; contractor: string; amount: bigint; signedAt: string };
export type Work = {
  workId: string; contractId: string; title: string; price: bigint;
  status: 'planned' | 'done' | 'cancelled'; completedAt: string | null; cancelledAt: string | null;
};
export type Payment = {
  paymentId: string; contractId: string; workId: string | null; purpose: string;
  amount: bigint; status: 'paid' | 'queued' | 'refunded'; createdAt: string;
  paidAt: string | null; refundedAt: string | null;
};
export type Input = { contracts: Contract[]; works: Work[]; payments: Payment[] };
export type WorkRow = {
  workId: string; title: string; status: Work['status']; price: bigint;
  paid: bigint; remaining: bigint;
};
export type ContractRow = {
  contractId: string; contractor: string; amount: bigint; paid: bigint;
  remaining: bigint; unallocatedPaid: bigint; works: WorkRow[];
};

function csvRows<T>(text: string, required: string[], map: (row: Record<string, string>) => T): T[] {
  const records = parse(text.replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (records.length && required.some((column) => !(column in records[0]!))) {
    throw new Error(`CSV не содержит обязательные колонки: ${required.filter((c) => !(c in records[0]!)).join(', ')}`);
  }
  return records.map(map);
}

export function parseMoney(value: string, field: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error(`Некорректная сумма в ${field}: ${value}`);
  const [rubles, fraction = ''] = normalized.split('.');
  return BigInt(rubles!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function formatMoney(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')} ₽`;
}

function date(value: string, field: string, optional = false): string | null {
  const v = value.trim();
  if (!v && optional) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new Error(`Некорректная дата в ${field}: ${value}`);
  }
  return v;
}

export function loadInput(contractsCsv: string, worksCsv: string, paymentsCsv: string): Input {
  const contracts = csvRows(contractsCsv, ['contract_id', 'contractor', 'amount', 'signed_at'], (r) => ({
    contractId: r.contract_id!, contractor: r.contractor!, amount: parseMoney(r.amount!, `contracts.${r.contract_id}`), signedAt: date(r.signed_at!, 'signed_at')!,
  }));
  const works = csvRows(worksCsv, ['work_id', 'contract_id', 'title', 'price', 'status', 'completed_at', 'cancelled_at'], (r) => {
    const status = r.status as Work['status'];
    if (!['planned', 'done', 'cancelled'].includes(status)) throw new Error(`Неизвестный статус работы ${r.work_id}: ${r.status}`);
    return { workId: r.work_id!, contractId: r.contract_id!, title: r.title!, price: parseMoney(r.price!, `works.${r.work_id}`), status,
      completedAt: date(r.completed_at ?? '', `works.${r.work_id}.completed_at`, true), cancelledAt: date(r.cancelled_at ?? '', `works.${r.work_id}.cancelled_at`, true) };
  });
  const payments = csvRows(paymentsCsv, ['payment_id', 'contract_id', 'work_id', 'purpose', 'amount', 'status', 'created_at', 'paid_at', 'refunded_at'], (r) => {
    const status = r.status as Payment['status'];
    if (!['paid', 'queued', 'refunded'].includes(status)) throw new Error(`Неизвестный статус платежа ${r.payment_id}: ${r.status}`);
    return { paymentId: r.payment_id!, contractId: r.contract_id!, workId: r.work_id || null, purpose: r.purpose!, amount: parseMoney(r.amount!, `payments.${r.payment_id}`), status,
      createdAt: date(r.created_at!, `payments.${r.payment_id}.created_at`)!, paidAt: date(r.paid_at ?? '', `payments.${r.payment_id}.paid_at`, true), refundedAt: date(r.refunded_at ?? '', `payments.${r.payment_id}.refunded_at`, true) };
  });
  return { contracts, works, payments };
}

export function buildReport(input: Input, asOf: string): ContractRow[] {
  date(asOf, 'report date');
  const contractIds = new Set<string>();
  for (const c of input.contracts) {
    if (contractIds.has(c.contractId)) throw new Error(`Дублируется договор ${c.contractId}`);
    contractIds.add(c.contractId);
  }
  const workIds = new Set<string>();
  for (const w of input.works) {
    if (workIds.has(w.workId)) throw new Error(`Дублируется работа ${w.workId}`);
    workIds.add(w.workId);
    if (!contractIds.has(w.contractId)) throw new Error(`Для работы ${w.workId} не найден договор ${w.contractId}`);
  }
  for (const p of input.payments) {
    if (!contractIds.has(p.contractId)) throw new Error(`Для платежа ${p.paymentId} не найден договор ${p.contractId}`);
    if (p.workId && !input.works.some((w) => w.workId === p.workId && w.contractId === p.contractId)) throw new Error(`Платёж ${p.paymentId} ссылается на неизвестную работу/другой договор: ${p.workId}`);
  }

  return input.contracts.map((contract) => {
    const works = input.works.filter((w) => w.contractId === contract.contractId)
      .sort((a, b) => a.workId.localeCompare(b.workId, 'en'));
    const paid = input.payments.filter((p) => p.contractId === contract.contractId && p.paidAt !== null && p.paidAt <= asOf && (p.status === 'paid' || (p.status === 'refunded' && p.refundedAt !== null && p.refundedAt > asOf)));
    const workPaid = new Map(works.map((w) => [w.workId, 0n]));
    let directUnallocated = 0n;
    for (const p of paid.filter((x) => x.workId !== null)) {
      const id = p.workId!;
      const w = works.find((x) => x.workId === id)!;
      const cancelled = w.status === 'cancelled' && w.cancelledAt !== null && w.cancelledAt <= asOf;
      const current = workPaid.get(id)!;
      const capacity = cancelled || current >= w.price ? 0n : w.price - current;
      const applied = p.amount < capacity ? p.amount : capacity;
      workPaid.set(id, current + applied);
      directUnallocated += p.amount - applied;
    }
    let contractUnallocated = 0n;
    const activeWorks = works.filter((w) => !(w.status === 'cancelled' && w.cancelledAt !== null && w.cancelledAt <= asOf));
    for (const p of paid.filter((x) => x.workId === null).sort((a, b) => (a.paidAt ?? '').localeCompare(b.paidAt ?? '') || a.paymentId.localeCompare(b.paymentId))) {
      let left = p.amount;
      for (const w of activeWorks) {
        if (left === 0n) break;
        const already = workPaid.get(w.workId)!;
        const capacity = w.price > already ? w.price - already : 0n;
        const applied = left < capacity ? left : capacity;
        workPaid.set(w.workId, already + applied);
        left -= applied;
      }
      contractUnallocated += left;
    }
    const workRows = works.map((w): WorkRow => {
      const cancelledByDate = w.status === 'cancelled' && w.cancelledAt !== null && w.cancelledAt <= asOf;
      const status = w.status === 'done' && w.completedAt !== null && w.completedAt > asOf ? 'planned'
        : w.status === 'cancelled' && w.cancelledAt !== null && w.cancelledAt > asOf ? 'planned' : w.status;
      const amountPaid = cancelledByDate ? 0n : workPaid.get(w.workId)!;
      const remaining = cancelledByDate ? 0n : w.price > amountPaid ? w.price - amountPaid : 0n;
      return { workId: w.workId, title: w.title, status, price: w.price, paid: amountPaid, remaining };
    });
    const paidTotal = paid.reduce((sum, p) => sum + p.amount, 0n);
    const cancelledValue = works.filter((w) => w.status === 'cancelled' && w.cancelledAt !== null && w.cancelledAt <= asOf)
      .reduce((sum, w) => sum + w.price, 0n);
    const obligation = contract.amount > cancelledValue ? contract.amount - cancelledValue : 0n;
    return { contractId: contract.contractId, contractor: contract.contractor, amount: contract.amount, paid: paidTotal,
      remaining: obligation > paidTotal ? obligation - paidTotal : 0n, unallocatedPaid: contractUnallocated + directUnallocated, works: workRows };
  });
}

export function renderReport(rows: ContractRow[], asOf: string): string {
  const out = [`Отчёт по состоянию на ${asOf}`, ''];
  for (const c of rows) {
    out.push(`${c.contractId} — ${c.contractor}`, `Договор: ${formatMoney(c.amount)} | выплачено: ${formatMoney(c.paid)} | осталось: ${formatMoney(c.remaining)}`);
    for (const w of c.works) out.push(`  ${w.workId} [${w.status}] ${w.title}: цена ${formatMoney(w.price)}, выплачено ${formatMoney(w.paid)}, осталось ${formatMoney(w.remaining)}`);
    if (c.unallocatedPaid > 0n) out.push(`  Не распределено по работам: ${formatMoney(c.unallocatedPaid)}`);
    out.push('');
  }
  const sums = rows.reduce((a, c) => ({ amount: a.amount + c.amount, paid: a.paid + c.paid, remaining: a.remaining + c.remaining, unallocated: a.unallocated + c.unallocatedPaid }), { amount: 0n, paid: 0n, remaining: 0n, unallocated: 0n });
  out.push(`ИТОГО ПО ДОГОВОРАМ: сумма ${formatMoney(sums.amount)} | выплачено ${formatMoney(sums.paid)} | осталось ${formatMoney(sums.remaining)}`);
  if (sums.unallocated > 0n) out.push(`В том числе выплачено без распределения по работам: ${formatMoney(sums.unallocated)}`);
  return out.join('\n');
}
