import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

export interface SiteCredentials {
  user: string;
  pass: string;
  branch?: string;
}

export const Config = {
  // 下載根目錄
  downloadDir: process.env.DOWNLOAD_DIR || 'D:\\投資報告',

  // 瀏覽器設定
  headless: process.env.HEADLESS === 'true',

  // Session 儲存目錄
  authDir: path.join(__dirname, '..', 'auth'),

  // 暫存目錄
  tempDir: path.join(__dirname, '..', 'temp'),

  // 各網站帳號密碼設定
  sites: {
    yuanta: {
      user: process.env.YUANTA_USER || '',
      pass: process.env.YUANTA_PASS || '',
    } as SiteCredentials,
    kgi: {
      user: process.env.KGI_USER || '',
      pass: process.env.KGI_PASS || '',
    } as SiteCredentials,
    fubon: {
      user: process.env.FUBON_USER || '',
      pass: process.env.FUBON_PASS || '',
    } as SiteCredentials,
    sinopac: {
      user: process.env.SINOPAC_USER || '',
      pass: process.env.SINOPAC_PASS || '',
    } as SiteCredentials,
    cathay: {
      user: process.env.CATHAY_USER || '',
      pass: process.env.CATHAY_PASS || '',
    } as SiteCredentials,
    capital: {
      user: process.env.CAPITAL_USER || '',
      pass: process.env.CAPITAL_PASS || '',
    } as SiteCredentials,
    esun: {
      user: process.env.ESUN_USER || '',
      pass: process.env.ESUN_PASS || '',
      branch: process.env.ESUN_BRANCH || '8840',
    } as SiteCredentials,
  },

  /**
   * 取得指定站點的 Session 儲存路徑
   */
  getAuthFilePath(siteId: string): string {
    return path.join(this.authDir, `${siteId}.json`);
  }
};
