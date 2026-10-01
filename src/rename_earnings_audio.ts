import { parseArgs } from 'util';
import * as path from 'path';
import { GoogleDriveService } from './core/googleDrive';
import {
  AUDIO_FOLDER,
  CLOUD_EARNINGS_PATH,
  MANIFEST_NAME,
  type ManifestEntry,
  loadCloudManifest,
} from './core/earnings';

const CLOUD_AUDIO_PATH = [...CLOUD_EARNINGS_PATH, AUDIO_FOLDER];

function printHelp(): void {
  console.log(`
=====================================================
  🏷️ 法說會音檔重新命名工具
=====================================================
使用方式:
  npm run rename:audio                 重新命名「${CLOUD_AUDIO_PATH.join('/')}」內的音檔
  npm run rename:audio -- --dry-run    僅預覽，不實際改名
  npm run rename:audio -- --help       顯示此說明

命名格式:
  公司名稱(股票代號)-YYYYMMDD.副檔名，例如 三芳(1307)-20260916.mp4

比對方式:
  從「${[...CLOUD_EARNINGS_PATH, MANIFEST_NAME].join('/')}」取得本次法說會的所有公司，
  依檔名中的股票代號比對，找不到再依公司名稱比對；
  符合多場時以檔名中的日期 (YYYYMMDD 或 YYMMDD) 篩選，仍無法唯一判定則略過並提示。
  改名不會改變檔案 ID，既有分享連結維持有效。
=====================================================
`);
}

const DATE_PATTERNS = [
  // 20260902、260909、1150915 (民國)
  /(?<!\d)(20\d{2}|1[01]\d|\d{2})(\d{2})(\d{2})(?!\d)/g,
  // 2026-09-24、2026 9 22、2026年9月24日、115.09.03、115年9月9日
  /(?<!\d)(20\d{2}|1[01]\d)\s*[年.\-/\s]\s*(\d{1,2})\s*[月.\-/\s]\s*(\d{1,2})(?!\d)/g,
];

/** 由檔名取出所有可能的日期 (西元或民國)，統一為 YYYY-MM-DD。 */
function extractDates(fileName: string): string[] {
  const dates = new Set<string>();
  for (const pattern of DATE_PATTERNS) {
    for (const [, year, month, day] of fileName.matchAll(pattern)) {
      const y = year.length === 2 ? 2000 + Number(year) : year.length === 3 ? 1911 + Number(year) : Number(year);
      const m = Number(month);
      const d = Number(day);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        dates.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      }
    }
  }
  return [...dates];
}

/** 比對用的公司簡稱：去掉「-KY」「*」等後綴與空白，檔名常省略這些字 */
function nameKey(name: string): string {
  return name.replace(/[-\s]*KY$/i, '').replace(/[*\s]/g, '');
}

/** 依股票代號、公司名稱比對 manifest；無法唯一判定時回傳所有候選以便提示。 */
function matchEntry(fileName: string, entries: ManifestEntry[]): { entry: ManifestEntry | null; candidates: ManifestEntry[] } {
  let candidates = entries.filter(e => new RegExp(`(?<!\\d)${e.code}(?!\\d)`).test(fileName));
  if (candidates.length === 0) {
    const compact = fileName.replace(/\s/g, '');
    candidates = entries.filter(e => nameKey(e.name).length >= 2 && compact.includes(nameKey(e.name)));
    // 名稱互為子字串時 (例如「三聯」與「聯」) 取最長者
    const longest = Math.max(0, ...candidates.map(e => nameKey(e.name).length));
    candidates = candidates.filter(e => nameKey(e.name).length === longest);
  }

  if (candidates.length > 1) {
    const dates = extractDates(fileName);
    const byDate = candidates.filter(e => dates.includes(e.date));
    if (byDate.length > 0) candidates = byDate;
  }

  return { entry: candidates.length === 1 ? candidates[0] : null, candidates };
}

function targetName(entry: ManifestEntry, fileName: string): string {
  // 去掉 Windows 檔名不允許的字元 (例如「聖暉*」的 *)，方便下載到本地
  const name = entry.name.replace(/[\\/:*?"<>|]/g, '');
  return `${name}(${entry.code})-${entry.date.replace(/-/g, '')}${path.extname(fileName)}`;
}

async function loadManifest(): Promise<ManifestEntry[]> {
  const folderId = await GoogleDriveService.findFolderByPath(CLOUD_EARNINGS_PATH);
  if (!folderId) {
    throw new Error(`雲端找不到「${CLOUD_EARNINGS_PATH.join('/')}」`);
  }
  const loaded = await loadCloudManifest(folderId);
  if (!loaded) {
    throw new Error(`雲端找不到「${[...CLOUD_EARNINGS_PATH, MANIFEST_NAME].join('/')}」`);
  }
  return Object.values(loaded.manifest).filter((e): e is ManifestEntry => !!(e.code && e.name && e.date));
}

async function main(): Promise<void> {
  const options = {
    'dry-run': { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };

  const { values } = parseArgs({ options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  const dryRun = values['dry-run'] === true;

  console.log('=====================================================');
  console.log('  🏷️ 法說會音檔重新命名');
  console.log('=====================================================');
  console.log(`☁️ 音檔目錄:   ${CLOUD_AUDIO_PATH.join('/')}`);
  console.log(`📋 Manifest:   ${[...CLOUD_EARNINGS_PATH, MANIFEST_NAME].join('/')}`);
  console.log(`⚙️ 執行模式:   ${dryRun ? '預覽 (不會實際改名)' : '實際改名'}`);

  const entries = await loadManifest();
  console.log(`\n📋 manifest 共 ${entries.length} 場法說會\n`);

  const audioFolderId = await GoogleDriveService.findFolderByPath(CLOUD_AUDIO_PATH);
  if (!audioFolderId) {
    throw new Error(`雲端找不到「${CLOUD_AUDIO_PATH.join('/')}」`);
  }
  const files = await GoogleDriveService.listFolderFiles(audioFolderId);
  const existingNames = new Set(files.map(f => f.name!));

  const stats = { total: files.length, renamed: 0, unchanged: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    const fileName = file.name!;
    const { entry, candidates } = matchEntry(fileName, entries);

    if (!entry) {
      stats.skipped++;
      if (candidates.length === 0) {
        console.warn(`⚠️ [找不到對應公司] 略過: ${fileName}`);
      } else {
        const list = candidates.map(e => `${e.name}(${e.code}) ${e.date}`).join('、');
        console.warn(`⚠️ [無法唯一判定] 略過: ${fileName} → 候選: ${list}`);
      }
      continue;
    }

    const fileDates = extractDates(fileName);
    if (fileDates.length > 0 && !fileDates.includes(entry.date)) {
      console.warn(`⚠️ [日期不符] 檔名為 ${fileDates.join('、')}，manifest 為 ${entry.date}，以 manifest 為準: ${fileName}`);
    }

    const newName = targetName(entry, fileName);
    if (newName === fileName) {
      stats.unchanged++;
      console.log(`⏩ [已是正確名稱] ${fileName}`);
      continue;
    }
    if (existingNames.has(newName)) {
      stats.skipped++;
      console.warn(`⚠️ [目標名稱已存在] 略過: ${fileName} → ${newName}`);
      continue;
    }

    try {
      if (!dryRun) {
        await GoogleDriveService.renameFile(file.id!, newName);
      }
      existingNames.delete(fileName);
      existingNames.add(newName);
      stats.renamed++;
      console.log(`${dryRun ? '🔍 [預覽]' : '✅ [改名]'} ${fileName} → ${newName}`);
    } catch (error: any) {
      stats.failed++;
      console.error(`❌ [失敗] ${fileName}: ${error.message}`);
    }
  }

  console.log('\n=====================================================');
  console.log(`  🎉 ${dryRun ? '預覽完成！' : '改名完成！'}`);
  console.log('=====================================================');
  console.log(`📊 檔案總數:   ${stats.total}`);
  console.log(`${dryRun ? '🔍 可改名:    ' : '✅ 已改名:    '} ${stats.renamed}`);
  console.log(`⏩ 無需變更:   ${stats.unchanged}`);
  if (stats.skipped > 0) {
    console.log(`⚠️ 略過:       ${stats.skipped}`);
  }
  if (stats.failed > 0) {
    console.log(`❌ 失敗:       ${stats.failed}`);
    process.exitCode = 1;
  }
  console.log('=====================================================');
}

main().catch((error: any) => {
  console.error('❌ 改名失敗：', error.message);
  process.exit(1);
});
