import { parseArgs } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { GoogleDriveService } from './core/googleDrive';

function printHelp() {
  console.log(`
=====================================================
  ☁️ Google Drive 投資研究報告鏡像同步工具
=====================================================
使用方式:
  npm run upload:drive                      鏡像同步 (上傳新檔案、跳過已存在、刪除雲端多餘檔案)
  npm run upload:drive -- --dir <路徑>      指定要同步的本地目錄 (預設: ./EquityReport)
  npm run upload:drive -- --help            顯示此說明

功能特色:
  ✅ 增量上傳: 自動跳過雲端已存在同名檔案
  🧹 鏡像清理: 本地若已刪除報告，雲端對應檔案也會自動刪除
=====================================================
`);
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

  const targetRootFolderName = '投資報告';

  try {
    console.log(`\n🔍 正在連接 Google Drive API...`);
    const drive = await GoogleDriveService.getClient();

    // 取得/建立 Google Drive 根目錄「投資報告」
    console.log(`📁 正在確認雲端「${targetRootFolderName}」資料夾...`);
    const rootFolderId = await GoogleDriveService.getOrCreateFolder(targetRootFolderName);
    console.log(`✅ 雲端目標根目錄 ID: ${rootFolderId}`);

    console.log(`\n📦 開始鏡像同步 ...\n`);
    const startTime = Date.now();

    const stats = await GoogleDriveService.syncDirectory(
      localPath,
      rootFolderId,
      { total: 0, uploaded: 0, skipped: 0, deleted: 0, failed: 0 },
      path.basename(localPath)
    );

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
