import { parseArgs } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { GoogleDriveService } from './core/googleDrive';
import {
  AUDIO_FOLDER,
  CLOUD_EARNINGS_PATH,
  EARNINGS_FOLDER,
  MANIFEST_NAME,
  type Manifest,
  loadCloudManifest,
  loadManifest,
  saveManifest,
} from './core/earnings';

const DEFAULT_MONTHS = 2;
const DEFAULT_DIRS = ['EquityReport', EARNINGS_FOLDER];
// 雲端只依日期清理 CLOUD_EARNINGS_PATH (EquityReport 由 upload:drive 鏡像同步清除，不在此處理)；
// EarningsCall/audio 為手動補抓的法說會音檔，檔名日期在結尾，清空後保留資料夾供 rename:audio 使用；
// EarningsCall/manifest.json 為記錄轉錄狀態的檔案 (本地由 transcribe:earnings、雲端由 Colab 寫入)，
// 依紀錄的召開日期 (date) 移除過期場次

function printHelp(): void {
  console.log(`
=====================================================
  🧹 投資研究報告本地清理工具
=====================================================
使用方式:
  npm run clean:reports                        刪除超過 ${DEFAULT_MONTHS} 個月的報告
  npm run clean:reports -- --months <N>        自訂保留月數 (預設: ${DEFAULT_MONTHS})
  npm run clean:reports -- --dir <路徑>        只清理指定目錄 (預設: ${DEFAULT_DIRS.map(d => `./${d}`).join('、')})
  npm run clean:reports -- --dry-run           僅預覽，不實際刪除
  npm run clean:reports -- --local-only        只清理本地，不處理雲端
  npm run clean:reports -- --help              顯示此說明

判斷方式:
  以檔名前綴的日期 (YYYYMMDD_...) 為準，研究報告為報告日期、法說會逐字稿與摘要為召開日期，
  早於保留期限者刪除；清空後的子資料夾一併移除。
  檔名無日期前綴者一律保留並提示。
  ${EARNINGS_FOLDER}/${AUDIO_FOLDER} 的音檔以檔名結尾的召開日期判斷 (公司名稱(代號)-YYYYMMDD，由 rename:audio 命名)，
  與逐字稿同步刪除；資料夾清空後保留。
  ${EARNINGS_FOLDER}/${MANIFEST_NAME} 中召開日期 (date) 早於保留期限的場次紀錄一併移除。

雲端:
  「${CLOUD_EARNINGS_PATH.join('/')}」依相同規則清理，檔案移到垃圾桶，30 天內可復原；
  Colab 寫入的 ${MANIFEST_NAME} 同樣移除過期紀錄。
  請勿在 transcribe:earnings 或 Colab 轉錄期間清理，否則轉錄存檔會把移除的紀錄寫回。
  指定 --dir 或 --local-only 時不處理雲端。

提示:
  刪除後執行 npm run upload:drive，雲端 EquityReport 對應檔案會一併鏡像清除。
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

type DateParser = (fileName: string) => Date | null;

/** 將 regex 擷取的年月日轉為日期；格式不符或日期不存在時回傳 null。 */
function toValidDate(match: RegExpExecArray | null): Date | null {
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** 由檔名前綴 (YYYYMMDD_...) 取出報告日期。 */
function parseReportDate(fileName: string): Date | null {
  return toValidDate(/^(\d{4})(\d{2})(\d{2})_/.exec(fileName));
}

/** 由法說會音檔檔名結尾 (公司名稱(代號)-YYYYMMDD.副檔名，rename:audio 的格式) 取出召開日期。 */
function parseAudioDate(fileName: string): Date | null {
  return toValidDate(/\(\w+\)-(\d{4})(\d{2})(\d{2})\.[^.]+$/.exec(fileName));
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

/**
 * 遞迴掃描目錄，刪除報告日期早於 cutoff 的檔案，並移除因此清空的子資料夾。
 * isEarningsRoot 為 EarningsCall 根目錄：manifest.json 另由 pruneManifest 清理，audio 資料夾清空後保留。
 */
function cleanDirectory(
  dir: string, cutoff: Date, dryRun: boolean, stats: CleanupStats, label: string,
  parseDate: DateParser = parseReportDate, isEarningsRoot = false,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const displayPath = label ? `${label}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const isAudio = isEarningsRoot && entry.name === AUDIO_FOLDER;
      cleanDirectory(fullPath, cutoff, dryRun, stats, displayPath, isAudio ? parseAudioDate : parseDate);
      if (!dryRun && !isAudio && fs.readdirSync(fullPath).length === 0) {
        fs.rmdirSync(fullPath);
        console.log(`🗑️ [移除空資料夾] ${displayPath}`);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (isEarningsRoot && entry.name === MANIFEST_NAME) continue;

    stats.total++;

    const reportDate = parseDate(entry.name);
    if (!reportDate) {
      stats.skipped++;
      const hint = parseDate === parseAudioDate ? ' (可先執行 npm run rename:audio 統一檔名)' : '';
      console.warn(`⚠️ [無日期] 保留: ${displayPath}${hint}`);
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

/**
 * 遞迴清理雲端資料夾，檔案移到垃圾桶；回傳清理後資料夾是否已空 (供上層移除空資料夾)。
 */
async function cleanCloudDirectory(
  folderId: string, cutoff: Date, dryRun: boolean, stats: CleanupStats, label: string,
  parseDate: DateParser = parseReportDate, isRoot = true,
): Promise<boolean> {
  let remaining = 0;

  const dirs = await GoogleDriveService.getFolderDirsMap(folderId);
  for (const [name, id] of dirs) {
    const displayPath = `${label}/${name}`;
    const isAudio = isRoot && name === AUDIO_FOLDER;
    const isEmpty = await cleanCloudDirectory(
      id, cutoff, dryRun, stats, displayPath, isAudio ? parseAudioDate : parseDate, false,
    );
    if (!isEmpty || dryRun || isAudio) {
      remaining++;
      continue;
    }
    try {
      await GoogleDriveService.trashFile(id);
      console.log(`🗑️ [移除空資料夾] ☁️ ${displayPath}`);
    } catch (error: any) {
      remaining++;
      console.error(`❌ [失敗] ☁️ ${displayPath}: ${error.message}`);
    }
  }

  const files = await GoogleDriveService.listFolderFiles(folderId);
  for (const file of files) {
    const displayPath = `${label}/${file.name}`;
    if (isRoot && file.name === MANIFEST_NAME) {
      remaining++; // 由 pruneCloudManifest 清理內容
      continue;
    }
    stats.total++;

    const reportDate = parseDate(file.name || '');
    if (!reportDate) {
      stats.skipped++;
      remaining++;
      const hint = parseDate === parseAudioDate ? ' (可先執行 npm run rename:audio 統一檔名)' : '';
      console.warn(`⚠️ [無日期] 保留: ☁️ ${displayPath}${hint}`);
      continue;
    }

    if (reportDate >= cutoff) {
      stats.kept++;
      remaining++;
      continue;
    }

    try {
      if (!dryRun) {
        await GoogleDriveService.trashFile(file.id!);
      }
      stats.deleted++;
      stats.freedBytes += Number(file.size || 0);
      console.log(`${dryRun ? '🔍 [預覽]' : '🗑️ [刪除]'} ${formatDate(reportDate)} ☁️ ${displayPath}`);
    } catch (error: any) {
      stats.failed++;
      remaining++;
      console.error(`❌ [失敗] ☁️ ${displayPath}: ${error.message}`);
    }
  }

  return remaining === 0;
}

/** 刪除 manifest 中召開日期早於 cutoff 的場次紀錄並回傳數量；無日期的紀錄保留 (與轉錄程式的 prune_manifest 相同)。 */
function removeExpired(manifest: Manifest, cutoff: Date, dryRun: boolean, displayPath: string): number {
  const expired = Object.entries(manifest).filter(([, rec]) => {
    const date = toValidDate(/^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.date || ''));
    return date !== null && date < cutoff;
  });
  for (const [key] of expired) {
    delete manifest[key];
    console.log(`${dryRun ? '🔍 [預覽]' : '🗑️ [移除紀錄]'} ${displayPath}: ${key}`);
  }
  return expired.length;
}

/** 移除本地 manifest.json 的過期紀錄；回傳移除筆數，失敗時回傳 null。 */
function pruneManifest(cutoff: Date, dryRun: boolean): number | null {
  const displayPath = `${EARNINGS_FOLDER}/${MANIFEST_NAME}`;
  try {
    const manifest = loadManifest();
    if (!manifest) return 0;
    const removed = removeExpired(manifest, cutoff, dryRun, displayPath);
    if (removed > 0 && !dryRun) {
      saveManifest(manifest);
    }
    return removed;
  } catch (error: any) {
    console.error(`❌ [失敗] ${displayPath}: ${error.message}`);
    return null;
  }
}

/**
 * 移除雲端 (Colab) manifest.json 的過期紀錄；回傳移除筆數，失敗時回傳 null。
 * 請勿在 Colab 轉錄期間執行，否則 Colab 存檔會把移除的紀錄寫回。
 */
async function pruneCloudManifest(folderId: string, cutoff: Date, dryRun: boolean, label: string): Promise<number | null> {
  const displayPath = `☁️ ${label}/${MANIFEST_NAME}`;
  try {
    const loaded = await loadCloudManifest(folderId);
    if (!loaded) return 0;
    const removed = removeExpired(loaded.manifest, cutoff, dryRun, displayPath);
    if (removed > 0 && !dryRun) {
      // 與 Colab save_manifest 的 json.dumps(ensure_ascii=False, indent=1) 格式一致
      await GoogleDriveService.writeFileText(loaded.fileId, JSON.stringify(loaded.manifest, null, 1));
    }
    return removed;
  } catch (error: any) {
    console.error(`❌ [失敗] ${displayPath}: ${error.message}`);
    return null;
  }
}

function printStats(title: string, stats: CleanupStats, dryRun: boolean): void {
  const freedMb = (stats.freedBytes / 1024 / 1024).toFixed(1);
  console.log(`\n${title}`);
  console.log(`📊 掃描總數:   ${stats.total}`);
  console.log(`${dryRun ? '🔍 可刪除:    ' : '🗑️ 已刪除:    '} ${stats.deleted} (${freedMb} MB)`);
  console.log(`✅ 保留:       ${stats.kept}`);
  if (stats.skipped > 0) {
    console.log(`⚠️ 無日期保留: ${stats.skipped}`);
  }
  if (stats.failed > 0) {
    console.log(`❌ 失敗:       ${stats.failed}`);
  }
}

async function main(): Promise<void> {
  const options = {
    dir: { type: 'string' as const, short: 'd' },
    months: { type: 'string' as const, short: 'm' },
    'dry-run': { type: 'boolean' as const },
    'local-only': { type: 'boolean' as const },
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

  const localPaths = values.dir
    ? [path.resolve(values.dir)]
    : DEFAULT_DIRS.map(dir => path.join(process.cwd(), dir));
  const dryRun = values['dry-run'] === true;
  const cleanCloud = !values.dir && values['local-only'] !== true;
  const cutoff = subtractMonths(new Date(), months);

  console.log('=====================================================');
  console.log('  🧹 清理過期投資研究報告');
  console.log('=====================================================');
  console.log(`📁 目標目錄:   ${localPaths.join('、')}`);
  console.log(`☁️ 雲端目錄:   ${cleanCloud ? CLOUD_EARNINGS_PATH.join('/') : '不處理'}`);
  console.log(`🗓️ 保留期間:   最近 ${months} 個月`);
  console.log(`✂️ 刪除門檻:   報告日期早於 ${formatDate(cutoff)}`);
  console.log(`⚙️ 執行模式:   ${dryRun ? '預覽 (不會實際刪除)' : '實際刪除'}`);

  if (values.dir && !fs.existsSync(localPaths[0])) {
    console.error(`\n❌ 找不到指定的目錄: ${localPaths[0]}`);
    process.exit(1);
  }

  const stats: CleanupStats = { total: 0, deleted: 0, kept: 0, skipped: 0, failed: 0, freedBytes: 0 };
  const startTime = Date.now();

  console.log(`\n📦 開始掃描 ...\n`);
  for (const localPath of localPaths) {
    if (!fs.existsSync(localPath)) {
      console.warn(`⚠️ 目錄不存在，略過: ${localPath}`);
      continue;
    }
    const label = path.basename(localPath);
    cleanDirectory(localPath, cutoff, dryRun, stats, label, parseReportDate, label === EARNINGS_FOLDER);
  }
  const manifestPruned = values.dir ? 0 : pruneManifest(cutoff, dryRun);

  let cloudStats: CleanupStats | null = null;
  let cloudManifestPruned: number | null = 0;
  if (cleanCloud) {
    console.log(`\n☁️ 正在掃描雲端「${CLOUD_EARNINGS_PATH.join('/')}」...\n`);
    const folderId = await GoogleDriveService.findFolderByPath(CLOUD_EARNINGS_PATH);
    if (folderId) {
      const label = CLOUD_EARNINGS_PATH[CLOUD_EARNINGS_PATH.length - 1];
      cloudStats = { total: 0, deleted: 0, kept: 0, skipped: 0, failed: 0, freedBytes: 0 };
      await cleanCloudDirectory(folderId, cutoff, dryRun, cloudStats, label);
      cloudManifestPruned = await pruneCloudManifest(folderId, cutoff, dryRun, label);
    } else {
      console.warn(`⚠️ 雲端找不到「${CLOUD_EARNINGS_PATH.join('/')}」，略過。`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=====================================================');
  console.log(`  🎉 ${dryRun ? '預覽完成！' : '清理完成！'}`);
  console.log('=====================================================');
  console.log(`⏱️  耗時:       ${duration} 秒`);
  printStats('📁 本地', stats, dryRun);
  if (!values.dir) {
    console.log(`📋 manifest:   ${manifestPruned === null ? '❌ 清理失敗' : `${dryRun ? '可移除' : '已移除'} ${manifestPruned} 筆紀錄`}`);
  }
  if (cloudStats) {
    printStats(`☁️ 雲端 (${dryRun ? '預覽' : '已移到垃圾桶'})`, cloudStats, dryRun);
    console.log(`📋 manifest:   ${cloudManifestPruned === null ? '❌ 清理失敗' : `${dryRun ? '可移除' : '已移除'} ${cloudManifestPruned} 筆紀錄`}`);
  }
  console.log('=====================================================');

  if (!dryRun && stats.deleted > 0) {
    console.log('\n💡 執行 npm run upload:drive 可同步清除雲端 EquityReport 對應檔案。');
  }
  if (stats.failed > 0 || (cloudStats?.failed ?? 0) > 0 || manifestPruned === null || cloudManifestPruned === null) {
    process.exitCode = 1;
  }
}

main().catch((error: any) => {
  console.error('❌ 清理失敗：', error.message);
  process.exit(1);
});
