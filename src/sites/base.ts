import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SiteCrawler, CrawlOptions } from '../core/types';
import { Config, SiteCredentials } from '../config';
import { BrowserManager } from '../core/browser';

export abstract class BaseSiteCrawler implements SiteCrawler {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly baseUrl: string;

  /**
   * 取得當前站點的帳號密碼
   */
  protected getCredentials(): SiteCredentials {
    const creds = Config.sites[this.id as keyof typeof Config.sites];
    if (!creds || !creds.user || !creds.pass) {
      throw new Error(`❌ 請在 .env 檔案中設定 ${this.id.toUpperCase()}_USER 與 ${this.id.toUpperCase()}_PASS！`);
    }
    return creds;
  }

  /**
   * 產生當前站點的驗證碼暫存圖檔路徑
   */
  protected getTempCaptchaPath(): string {
    if (!fs.existsSync(Config.tempDir)) {
      fs.mkdirSync(Config.tempDir, { recursive: true });
    }
    return path.join(Config.tempDir, `${this.id}_captcha.png`);
  }

  /**
   * 儲存當前站點的登入 Session
   */
  protected async saveSession(context: BrowserContext): Promise<void> {
    await BrowserManager.saveContextState(context, this.id);
  }

  /**
   * 各站專屬登入實作
   */
  abstract login(page: Page, context: BrowserContext): Promise<boolean>;

  /**
   * 各站專屬爬取與下載實作
   */
  abstract crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void>;
}
