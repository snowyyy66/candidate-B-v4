import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport, loadInput, renderReport } from './report.js';

async function main(): Promise<void> {
  const [date, dataDir = 'data'] = process.argv.slice(2);
  if (!date) throw new Error('Использование: npm run report -- YYYY-MM-DD [папка-с-CSV]');
  const dir = resolve(dataDir);
  const [contracts, works, payments] = await Promise.all([
    readFile(resolve(dir, 'contracts.csv'), 'utf8'),
    readFile(resolve(dir, 'works.csv'), 'utf8'),
    readFile(resolve(dir, 'payments.csv'), 'utf8'),
  ]);
  console.log(renderReport(buildReport(loadInput(contracts, works, payments), date), date));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => { console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
