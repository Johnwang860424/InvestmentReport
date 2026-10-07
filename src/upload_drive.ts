import { parseArgs } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { GoogleDriveService } from './core/googleDrive';
import { CLOUD_ROOT_FOLDER, EARNINGS_FOLDER, readSummaryVersion, summaryNameOf } from './core/earnings';


function printHelp() {
  console.log(`
=====================================================
  ☁️ Google Drive 投資研究報告鏡像同步工具
=====================================================
使用方式:
  npm run upload:drive                      鏡像同步 (上傳新檔案、跳過已存在、雲端多餘檔案移到垃圾桶)
  npm run upload:drive -- --dir <路徑>      指定要同步的本地目錄 (預設: ./EquityReport，不可為 ./${EARNINGS_FOLDER})
  npm run upload:drive -- --help            顯示此說明

功能特色:
  ✅ 增量上傳: 自動跳過雲端已存在同名檔案
  🧹 鏡像清理: 本地若已刪除報告，雲端對應檔案會移到垃圾桶
  📝 法說會摘要: 將 ./${EARNINGS_FOLDER}/<YYYYMM>/*.md 上傳至雲端同名月份資料夾，
                 雲端沒有或本地較新才上傳，同名檔案直接覆蓋 (不做鏡像刪除)；
                 雲端已有對應摘要的 Colab 逐字稿 (.txt) 移到垃圾桶，摘要後又更新的逐字稿保留；
                 本地的逐字稿、manifest、音檔不上傳
=====================================================
`);
}

interface EarningsUploadStats {
  uploaded: number;
  replaced: number;
  transcriptsTrashed: number;
  failed: number;
}

/**
 * 上傳法說會摘要 (.md) 到雲端「投資報告/EarningsCall/<YYYYMM>」
 * 只上傳本地的摘要，不做鏡像刪除 (過期摘要由 clean:reports 依日期清理雲端)；
 * 雲端月份資料夾另有 Colab 產生的逐字稿，雲端已存在對應摘要者移到垃圾桶
 */
async function uploadEarningsSummaries(localRoot: string, rootFolderId: string): Promise<EarningsUploadStats> {
  const stats: EarningsUploadStats = { uploaded: 0, replaced: 0, transcriptsTrashed: 0, failed: 0 };

  const monthDirs = fs.readdirSync(localRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{6}$/.test(entry.name))
    .map(entry => entry.name)
    .sort();

  for (const month of monthDirs) {
    const localDir = path.join(localRoot, month);
    const localMds = fs.readdirSync(localDir).filter(name => name.endsWith('.md')).sort();
    if (localMds.length === 0) continue;

    const earningsFolderId = await GoogleDriveService.getOrCreateFolder(EARNINGS_FOLDER, rootFolderId);
    const folderId = await GoogleDriveService.getOrCreateFolder(month, earningsFolderId);

    const cloudFiles = await GoogleDriveService.listFolderFiles(folderId);
    const cloudMds = new Map(cloudFiles.filter(f => f.name?.endsWith('.md')).map(f => [f.name!, f]));
    const syncedMds = new Set<string>();

    for (const name of localMds) {
      const localPath = path.join(localDir, name);
      const displayPath = `${EARNINGS_FOLDER}/${month}/${name}`;
      const cloudFile = cloudMds.get(name);
      if (cloudFile && GoogleDriveService.modifiedTimeMs(cloudFile) >= fs.statSync(localPath).mtimeMs) {
        syncedMds.add(name);
        continue;
      }
      try {
        if (cloudFile) {
          await GoogleDriveService.replaceFile(cloudFile.id!, localPath);
          stats.replaced++;
          console.log(`♻️ [覆蓋] ${displayPath}`);
        } else {
          await GoogleDriveService.uploadFile(localPath, folderId);
          stats.uploaded++;
          console.log(`📤 [上傳] ${displayPath}`);
        }
        syncedMds.add(name);
      } catch (err: any) {
        stats.failed++;
        console.error(`❌ [失敗] ${displayPath}: ${err.message}`);
      }
    }

    // 雲端摘要已是該逐字稿版本 (或更新) 時，Colab 逐字稿不再需要，移到垃圾桶；
    // 摘要後 Colab 又重做過的逐字稿較新，保留給下次摘要
    for (const txt of cloudFiles.filter(f => f.name?.endsWith('.txt'))) {
      const mdName = summaryNameOf(txt.name!);
      if (!syncedMds.has(mdName)) continue;
      if (readSummaryVersion(path.join(localDir, mdName)) < GoogleDriveService.modifiedTimeMs(txt)) continue;
      const displayPath = `${EARNINGS_FOLDER}/${month}/${txt.name}`;
      try {
        await GoogleDriveService.trashFile(txt.id!);
        stats.transcriptsTrashed++;
        console.log(`🗑️ [移除逐字稿] ${displayPath}`);
      } catch (err: any) {
        stats.failed++;
        console.error(`❌ [失敗] ${displayPath}: ${err.message}`);
      }
    }
  }

  return stats;
}

async function main() {
  const options = {
    dir: { type: 'string' as const, short: 'd' },
    help: { type: 'boolean' as const, short: 'h' },
  };

  const { values } = parseArgs({ options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  const localPath = values.dir ? path.resolve(values.dir) : path.join(process.cwd(), 'EquityReport');

  console.log('=====================================================');
  console.log('  🚀 投資研究報告鏡像同步至 Google Drive');
  console.log('=====================================================');
  console.log(`📁 本地目錄:   ${localPath}`);
  console.log(`🔄 同步模式:   鏡像同步 (增量上傳 + 雲端多餘檔案自動清理)`);

  if (!fs.existsSync(localPath)) {
    console.error(`\n❌ 找不到指定的本地目錄: ${localPath}`);
    process.exit(1);
  }

  // 本地與雲端 EarningsCall 各有對方沒有的檔案 (本地逐字稿、Colab 逐字稿與 manifest 等)，不可鏡像同步
  if (path.basename(localPath) === EARNINGS_FOLDER) {
    console.error(`\n❌ 「${EARNINGS_FOLDER}」不能用 --dir 鏡像同步；法說會摘要會在同步後自動上傳。`);
    process.exit(1);
  }

  try {
    console.log(`\n🔍 正在連接 Google Drive API...`);

    // 取得/建立 Google Drive 根目錄「投資報告」
    console.log(`📁 正在確認雲端「${CLOUD_ROOT_FOLDER}」資料夾...`);
    const rootFolderId = await GoogleDriveService.getOrCreateFolder(CLOUD_ROOT_FOLDER);
    console.log(`✅ 雲端目標根目錄 ID: ${rootFolderId}`);

    console.log(`\n📦 開始鏡像同步 ...\n`);
    const startTime = Date.now();

    const stats = await GoogleDriveService.syncDirectory(
      localPath,
      rootFolderId,
      { total: 0, uploaded: 0, skipped: 0, deleted: 0, failed: 0 },
      path.basename(localPath)
    );

    const earningsLocalPath = path.join(process.cwd(), EARNINGS_FOLDER);
    let earningsStats: EarningsUploadStats | null = null;
    if (fs.existsSync(earningsLocalPath)) {
      console.log(`\n📝 開始上傳法說會摘要 ...\n`);
      earningsStats = await uploadEarningsSummaries(earningsLocalPath, rootFolderId);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n=====================================================');
    console.log('  🎉 鏡像同步完成！');
    console.log('=====================================================');
    console.log(`⏱️  耗時:       ${duration} 秒`);
    console.log(`📊 掃描總數:   ${stats.total}`);
    console.log(`✅ 新增上傳:   ${stats.uploaded}`);
    console.log(`⏩ 已存在跳過: ${stats.skipped}`);
    if (stats.deleted > 0) {
      console.log(`🗑️ 雲端已清理: ${stats.deleted}`);
    }
    if (stats.failed > 0) {
      console.log(`❌ 失敗:       ${stats.failed}`);
    }
    if (earningsStats) {
      console.log(`📝 法說會摘要: 上傳 ${earningsStats.uploaded}、覆蓋 ${earningsStats.replaced}` +
        `、移除逐字稿 ${earningsStats.transcriptsTrashed}` +
        (earningsStats.failed > 0 ? `、失敗 ${earningsStats.failed}` : ''));
    }
    console.log('=====================================================');

  } catch (error: any) {
    console.error('\n❌ 同步過程發生錯誤:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
