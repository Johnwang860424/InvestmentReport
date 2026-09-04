import { parseArgs } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const DEFAULT_MONTHS = 2;

function printHelp(): void {
  console.log(`
=====================================================
  🧹 投資研究報告本地清理工具
=====================================================
使用方式:
  npm run clean:reports                        刪除超過 ${DEFAULT_MONTHS} 個月的報告
  npm run clean:reports -- --months <N>        自訂保留月數 (預設: ${DEFAULT_MONTHS})
  npm run clean:reports -- --dir <路徑>        指定要清理的目錄 (預設: ./EquityReport)
  npm run clean:reports -- --dry-run           僅預覽，不實際刪除
  npm run clean:reports -- --help              顯示此說明

判斷方式:
  以檔名前綴的報告日期 (YYYYMMDD_...) 為準，早於保留期限者刪除。
  檔名無日期前綴者一律保留並提示。

提示:
  刪除後執行 npm run upload:drive，雲端對應檔案會一併鏡像清除。
=====================================================
`);
}

/** 減去 N 個月，遇到月底不足天數時自動收斂到該月最後一天。 */
function subtractMonths(base: Date, months: number): Date {
  const result = new Date(base.getFullYear(), base.getMonth() - months, 1);
  const lastDayOfMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(base.getDate(), lastDayOfMonth));
  return result;
}

/** 由檔名前綴取出報告日期；格式不符或日期不存在時回傳 null。 */
function parseReportDate(fileName: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})_/.exec(fileName);
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function formatDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}${month}${day}`;
}

interface CleanupStats {
  total: number;
  deleted: number;
  kept: number;
  skipped: number;
  failed: number;
  freedBytes: number;
}

/** 遞迴掃描目錄，刪除報告日期早於 cutoff 的檔案。 */
function cleanDirectory(dir: string, cutoff: Date, dryRun: boolean, stats: CleanupStats, label: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const displayPath = label ? `${label}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      cleanDirectory(fullPath, cutoff, dryRun, stats, displayPath);
      continue;
    }
    if (!entry.isFile()) continue;

    stats.total++;

    const reportDate = parseReportDate(entry.name);
    if (!reportDate) {
      stats.skipped++;
      console.warn(`⚠️ [無日期] 保留: ${displayPath}`);
      continue;
    }

    if (reportDate >= cutoff) {
      stats.kept++;
      continue;
    }

    try {
      const size = fs.statSync(fullPath).size;
      if (!dryRun) {
        fs.unlinkSync(fullPath);
      }
      stats.deleted++;
      stats.freedBytes += size;
      console.log(`${dryRun ? '🔍 [預覽]' : '🗑️ [刪除]'} ${formatDate(reportDate)} ${displayPath}`);
    } catch (error: any) {
      stats.failed++;
      console.error(`❌ [失敗] ${displayPath}: ${error.message}`);
    }
  }
}

function main(): void {
  const options = {
    dir: { type: 'string' as const, short: 'd' },
    months: { type: 'string' as const, short: 'm' },
    'dry-run': { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };

  const { values } = parseArgs({ options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  let months = DEFAULT_MONTHS;
  if (values.months !== undefined) {
    months = Number(values.months);
    if (!Number.isInteger(months) || months <= 0) {
      throw new Error(`--months 必須為正整數：${values.months}`);
    }
  }

  const localPath = values.dir ? path.resolve(values.dir) : path.join(process.cwd(), 'EquityReport');
  const dryRun = values['dry-run'] === true;
  const cutoff = subtractMonths(new Date(), months);

  console.log('=====================================================');
  console.log('  🧹 清理過期投資研究報告');
  console.log('=====================================================');
  console.log(`📁 目標目錄:   ${localPath}`);
  console.log(`🗓️ 保留期間:   最近 ${months} 個月`);
  console.log(`✂️ 刪除門檻:   報告日期早於 ${formatDate(cutoff)}`);
  console.log(`⚙️ 執行模式:   ${dryRun ? '預覽 (不會實際刪除)' : '實際刪除'}`);

  if (!fs.existsSync(localPath)) {
    console.error(`\n❌ 找不到指定的目錄: ${localPath}`);
    process.exit(1);
  }

  const stats: CleanupStats = { total: 0, deleted: 0, kept: 0, skipped: 0, failed: 0, freedBytes: 0 };
  const startTime = Date.now();

  console.log(`\n📦 開始掃描 ...\n`);
  cleanDirectory(localPath, cutoff, dryRun, stats, '');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const freedMb = (stats.freedBytes / 1024 / 1024).toFixed(1);

  console.log('\n=====================================================');
  console.log(`  🎉 ${dryRun ? '預覽完成！' : '清理完成！'}`);
  console.log('=====================================================');
  console.log(`⏱️  耗時:       ${duration} 秒`);
  console.log(`📊 掃描總數:   ${stats.total}`);
  console.log(`${dryRun ? '🔍 可刪除:    ' : '🗑️ 已刪除:    '} ${stats.deleted} (${freedMb} MB)`);
  console.log(`✅ 保留:       ${stats.kept}`);
  if (stats.skipped > 0) {
    console.log(`⚠️ 無日期保留: ${stats.skipped}`);
  }
  if (stats.failed > 0) {
    console.log(`❌ 失敗:       ${stats.failed}`);
  }
  console.log('=====================================================');

  if (!dryRun && stats.deleted > 0) {
    console.log('\n💡 執行 npm run upload:drive 可同步清除雲端對應檔案。');
  }
  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error: any) {
  console.error('❌ 清理失敗：', error.message);
  process.exit(1);
}
