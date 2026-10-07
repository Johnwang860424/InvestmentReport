import * as fs from 'fs';
import * as path from 'path';

// 雲端與本地共用的資料夾名稱 (須與 scripts/transcribe_earnings.py 一致)
export const CLOUD_ROOT_FOLDER = '投資報告';
export const EARNINGS_FOLDER = 'EarningsCall';
export const CLOUD_EARNINGS_PATH = [CLOUD_ROOT_FOLDER, EARNINGS_FOLDER];
export const AUDIO_FOLDER = 'audio';
export const MANIFEST_NAME = 'manifest.json';

/** 本地法說會根目錄：逐字稿、摘要、manifest.json、手動補抓的音檔 */
export const LOCAL_EARNINGS_ROOT = path.join(process.cwd(), EARNINGS_FOLDER);
export const LOCAL_MANIFEST_PATH = path.join(LOCAL_EARNINGS_ROOT, MANIFEST_NAME);
export const LOCAL_AUDIO_DIR = path.join(LOCAL_EARNINGS_ROOT, AUDIO_FOLDER);

/** 摘要檔頭記錄的逐字稿版本 (逐字稿修改時間)，用來判斷逐字稿是否在摘要後又更新 */
export const VERSION_LABEL = '逐字稿版本：';

export function readSummaryVersion(mdPath: string): number {
  if (!fs.existsSync(mdPath)) return 0;
  const match = new RegExp(`^- ${VERSION_LABEL}(\\S+)$`, 'm').exec(fs.readFileSync(mdPath, 'utf-8'));
  return match ? Date.parse(match[1]) || 0 : 0;
}

/** 逐字稿版本：修改時間取到毫秒 (摘要檔頭以 ISO 字串記錄，精度為毫秒) */
export function transcriptVersionMs(txtPath: string): number {
  return Math.floor(fs.statSync(txtPath).mtimeMs);
}

/** 逐字稿 (.txt) 對應的摘要檔名 (.md) */
export function summaryNameOf(transcriptName: string): string {
  return transcriptName.replace(/\.txt$/, '.md');
}

/** transcribe_earnings.py 寫入 manifest.json 的單場法說會紀錄 */
export interface ManifestEntry {
  code: string;
  name: string;
  date: string; // YYYY-MM-DD
  status?: string;
}

export type Manifest = Record<string, Partial<ManifestEntry>>;

/** 讀取本地 manifest.json；檔案不存在時回傳 null */
export function loadManifest(): Manifest | null {
  if (!fs.existsSync(LOCAL_MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf-8'));
}

/** 寫回本地 manifest.json，格式與 transcribe_earnings.py 的 json.dumps(ensure_ascii=False, indent=1) 一致 */
export function saveManifest(manifest: Manifest): void {
  const tmpPath = `${LOCAL_MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 1), 'utf-8');
  fs.renameSync(tmpPath, LOCAL_MANIFEST_PATH);
}
