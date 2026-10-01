import * as fs from 'fs';
import { GoogleDriveService } from './googleDrive';

// 雲端與本地共用的資料夾名稱 (須與 colab/earnings_call_transcribe.ipynb 一致)
export const CLOUD_ROOT_FOLDER = '投資報告';
export const EARNINGS_FOLDER = 'EarningsCall';
export const CLOUD_EARNINGS_PATH = [CLOUD_ROOT_FOLDER, EARNINGS_FOLDER];
export const AUDIO_FOLDER = 'audio';
export const MANIFEST_NAME = 'manifest.json';

/** 摘要檔頭記錄的逐字稿版本 (雲端修改時間)，用來判斷逐字稿是否在摘要後又更新 */
export const VERSION_LABEL = '逐字稿版本：';

export function readSummaryVersion(mdPath: string): number {
  if (!fs.existsSync(mdPath)) return 0;
  const match = new RegExp(`^- ${VERSION_LABEL}(\\S+)$`, 'm').exec(fs.readFileSync(mdPath, 'utf-8'));
  return match ? Date.parse(match[1]) || 0 : 0;
}

/** 逐字稿 (.txt) 對應的摘要檔名 (.md) */
export function summaryNameOf(transcriptName: string): string {
  return transcriptName.replace(/\.txt$/, '.md');
}

/** Colab 寫入 manifest.json 的單場法說會紀錄 */
export interface ManifestEntry {
  code: string;
  name: string;
  date: string; // YYYY-MM-DD
  status?: string;
}

export type Manifest = Record<string, Partial<ManifestEntry>>;

/** 讀取雲端資料夾內的 manifest.json；檔案不存在時回傳 null */
export async function loadCloudManifest(folderId: string): Promise<{ fileId: string; manifest: Manifest } | null> {
  const fileId = (await GoogleDriveService.getFolderFilesMap(folderId)).get(MANIFEST_NAME);
  if (!fileId) return null;
  return { fileId, manifest: JSON.parse(await GoogleDriveService.readFileText(fileId)) };
}
