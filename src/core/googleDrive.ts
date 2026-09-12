import * as fs from 'fs';
import * as path from 'path';
import { google, drive_v3 } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';

// 設定 Google Drive 存取權限範圍
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

export interface SyncStats {
  total: number;
  uploaded: number;
  skipped: number;
  deleted: number;
  failed: number;
}

export class GoogleDriveService {
  private static driveInstance: drive_v3.Drive | null = null;
  // 資料夾 ID 快取 (避免重複查詢 API)
  private static folderCache: Map<string, string> = new Map();

  /**
   * 讀取已存在的 Token 憑證
   */
  private static loadSavedCredentialsIfExist(): any {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const content = fs.readFileSync(TOKEN_PATH, 'utf-8');
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
      }
    } catch (err) {
      console.warn('⚠️ 讀取 token.json 失敗，將重新進行授權驗證。');
    }
    return null;
  }

  /**
   * 儲存 Token 到本地檔案
   */
  private static saveCredentials(client: any): void {
    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }, null, 2);
    fs.writeFileSync(TOKEN_PATH, payload, 'utf-8');
    console.log('🔑 [Google Drive] 已成功將授權 Token 儲存至 token.json');
  }

  /**
   * 取得已授權的 Google Drive API Client
   */
  public static async getClient(): Promise<drive_v3.Drive> {
    if (this.driveInstance) {
      return this.driveInstance;
    }

    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(
        `❌ 找不到 credentials.json！\n` +
        `請確認已將 Google Cloud 下載的 OAuth 憑證檔命名為 "credentials.json" 並放置於專案根目錄：\n` +
        `${CREDENTIALS_PATH}`
      );
    }

    let client = this.loadSavedCredentialsIfExist();
    if (client) {
      try {
        await client.getAccessToken();
      } catch (err: any) {
        const errMsg = String(err?.message || err);
        if (errMsg.includes('invalid_grant') || err?.response?.data?.error === 'invalid_grant') {
          console.warn('⚠️ 授權憑證已過期或失效 (invalid_grant)，正在清除舊 Token 並重新開啟瀏覽器授權...');
          try {
            if (fs.existsSync(TOKEN_PATH)) {
              fs.unlinkSync(TOKEN_PATH);
            }
          } catch (e) {}
          client = null;
        } else {
          throw err;
        }
      }
    }

    if (!client) {
      console.log('🌐 [Google Drive] 正在開啟瀏覽器進行 Google 帳號授權...');
      client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
      });
      if (client && client.credentials) {
        this.saveCredentials(client);
        // 重新載入為標準 UserRefreshClient，使首次授權後可無縫直接繼續執行，無需手動重新執行指令
        client = this.loadSavedCredentialsIfExist() || client;
      }
    }

    this.driveInstance = google.drive({ version: 'v3', auth: client });
    return this.driveInstance;
  }

  /**
   * 在 Google Drive 上尋找或建立資料夾
   * @param folderName 資料夾名稱
   * @param parentFolderId 父資料夾 ID (選填，預設為根目錄)
   */
  public static async getOrCreateFolder(folderName: string, parentFolderId?: string): Promise<string> {
    const cacheKey = `${parentFolderId || 'root'}:${folderName}`;
    if (this.folderCache.has(cacheKey)) {
      return this.folderCache.get(cacheKey)!;
    }

    const drive = await this.getClient();
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
    if (parentFolderId) {
      query += ` and '${parentFolderId}' in parents`;
    }

    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    let folderId: string;
    if (res.data.files && res.data.files.length > 0) {
      folderId = res.data.files[0].id!;
    } else {
      const fileMetadata: drive_v3.Schema$File = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      };
      if (parentFolderId) {
        fileMetadata.parents = [parentFolderId];
      }

      const folder = await drive.files.create({
        requestBody: fileMetadata,
        fields: 'id',
      });
      folderId = folder.data.id!;
      console.log(`📁 [Google Drive] 已建立雲端資料夾: "${folderName}" (ID: ${folderId})`);
    }

    this.folderCache.set(cacheKey, folderId);
    return folderId;
  }

  /**
   * 批次取得雲端指定資料夾內的所有檔案名稱與 ID
   */
  public static async getFolderFilesMap(folderId: string): Promise<Map<string, string>> {
    const drive = await this.getClient();
    const map = new Map<string, string>();
    let pageToken: string | undefined = undefined;

    do {
      const res: drive_v3.Schema$FileList | any = await drive.files.list({
        q: `'${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 1000,
        pageToken: pageToken,
      });

      if (res.data.files) {
        for (const file of res.data.files) {
          if (file.name && file.id) {
            map.set(file.name, file.id);
          }
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return map;
  }

  /**
   * 批次取得雲端指定資料夾內的所有子資料夾名稱與 ID
   */
  public static async getFolderDirsMap(folderId: string): Promise<Map<string, string>> {
    const drive = await this.getClient();
    const map = new Map<string, string>();
    let pageToken: string | undefined = undefined;

    do {
      const res: any = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 1000,
        pageToken: pageToken,
      });

      if (res.data.files) {
        for (const dir of res.data.files) {
          if (dir.name && dir.id) {
            map.set(dir.name, dir.id);
          }
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return map;
  }

  /**
   * 上傳單一檔案到指定 Google Drive 資料夾
   * @param filePath 本地檔案路徑
   * @param parentFolderId 目標雲端資料夾 ID (選填)
   */
  public static async uploadFile(
    filePath: string,
    parentFolderId?: string
  ): Promise<drive_v3.Schema$File> {
    const drive = await this.getClient();
    const fileName = path.basename(filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`本地檔案不存在: ${filePath}`);
    }

    const fileMetadata: drive_v3.Schema$File = {
      name: fileName,
    };
    if (parentFolderId) {
      fileMetadata.parents = [parentFolderId];
    }

    const media = {
      body: fs.createReadStream(filePath),
    };

    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
    });

    return res.data;
  }

  /**
   * 遞迴將本地資料夾進行鏡像同步至 Google Drive
   * (新檔案上傳、已存在跳過、本地不存在的雲端檔案自動刪除)
   */
  public static async syncDirectory(
    localDirPath: string,
    parentDriveFolderId: string,
    stats: SyncStats = { total: 0, uploaded: 0, skipped: 0, deleted: 0, failed: 0 },
    relativePath = ''
  ): Promise<SyncStats> {
    if (!fs.existsSync(localDirPath)) {
      console.warn(`⚠️ 目錄不存在: ${localDirPath}`);
      return stats;
    }

    const drive = await this.getClient();
    const folderName = path.basename(localDirPath);
    const currentDriveFolderId = await this.getOrCreateFolder(folderName, parentDriveFolderId);

    // 1. 取得當前雲端目錄中已有檔案清單與子資料夾清單
    const existingCloudFiles = await this.getFolderFilesMap(currentDriveFolderId);
    const existingCloudDirs = await this.getFolderDirsMap(currentDriveFolderId);

    const localEntries = fs.readdirSync(localDirPath, { withFileTypes: true });
    const localFileNames = new Set<string>();
    const localDirNames = new Set<string>();

    const files = localEntries.filter(e => e.isFile());
    const dirs = localEntries.filter(e => e.isDirectory());

    for (const f of files) localFileNames.add(f.name);
    for (const d of dirs) localDirNames.add(d.name);

    // 2. 處理本地檔案上傳 (增量)
    for (const file of files) {
      stats.total++;
      const fullPath = path.join(localDirPath, file.name);
      const displayPath = relativePath ? `${relativePath}/${file.name}` : file.name;

      if (existingCloudFiles.has(file.name)) {
        stats.skipped++;
        console.log(`⏩ [已存在] 跳過: ${displayPath}`);
        continue;
      }

      try {
        console.log(`📤 [上傳中] (${stats.total}) ${displayPath}...`);
        await this.uploadFile(fullPath, currentDriveFolderId);
        stats.uploaded++;
        console.log(`✅ [完成] ${displayPath}`);
      } catch (err: any) {
        stats.failed++;
        console.error(`❌ [失敗] ${displayPath}: ${err.message}`);
      }
    }

    // 3. 鏡像清理：刪除本地不存在的雲端檔案
    for (const [cloudFileName, cloudFileId] of existingCloudFiles.entries()) {
      if (!localFileNames.has(cloudFileName)) {
        const displayPath = relativePath ? `${relativePath}/${cloudFileName}` : cloudFileName;
        try {
          console.log(`🗑️ [雲端清理] 刪除本地已不存在的檔案: ${displayPath}...`);
          await drive.files.delete({ fileId: cloudFileId });
          stats.deleted++;
          console.log(`🗑️ [已刪除] ${displayPath}`);
        } catch (err: any) {
          console.error(`❌ [刪除失敗] ${displayPath}: ${err.message}`);
        }
      }
    }

    // 4. 遞迴處理子資料夾
    for (const dir of dirs) {
      const subDirPath = path.join(localDirPath, dir.name);
      const subRelativePath = relativePath ? `${relativePath}/${dir.name}` : dir.name;
      await this.syncDirectory(subDirPath, currentDriveFolderId, stats, subRelativePath);
    }

    // 5. 鏡像清理：刪除本地不存在的雲端子資料夾
    for (const [cloudDirName, cloudDirId] of existingCloudDirs.entries()) {
      if (!localDirNames.has(cloudDirName)) {
        const displayPath = relativePath ? `${relativePath}/${cloudDirName}` : cloudDirName;
        try {
          console.log(`🗑️ [雲端清理] 刪除本地已不存在的資料夾: ${displayPath}...`);
          await drive.files.delete({ fileId: cloudDirId });
          stats.deleted++;
          console.log(`🗑️ [資料夾已刪除] ${displayPath}`);
        } catch (err: any) {
          console.error(`❌ [資料夾刪除失敗] ${displayPath}: ${err.message}`);
        }
      }
    }

    return stats;
  }
}
