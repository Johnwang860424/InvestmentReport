import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config';

export class BrowserManager {
  private static browser: Browser | null = null;
  private static browserLaunchPromise: Promise<Browser> | null = null;
  private static printBrowser: Browser | null = null;
  private static printBrowserLaunchPromise: Promise<Browser> | null = null;
  private static resolvedChannel: string | null = null;

  private static readonly launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // tsx/esbuild may emit __name calls inside injected page functions.
  private static readonly NAME_POLYFILL = `
if (typeof __name === 'undefined') {
  Object.defineProperty(globalThis, '__name', {
    value: function (target, value) {
      try {
        Object.defineProperty(target, 'name', { value: value, configurable: true });
      } catch (e) { }
      return target;
    },
    configurable: true,
    writable: true,
  });
}
`;

  private static candidateChannels(): (string | undefined)[] {
    return ['chrome', 'msedge', undefined];
  }

  private static async launchBrowser(): Promise<Browser> {
    const channels = this.resolvedChannel === null
      ? this.candidateChannels()
      : [this.resolvedChannel === 'chromium' ? undefined : this.resolvedChannel];
    let lastError: unknown;

    for (const channel of channels) {
      try {
        const browser = await chromium.launch({
          channel,
          headless: Config.headless,
          args: this.launchArgs,
        });
        this.resolvedChannel ??= channel ?? 'chromium';
        return browser;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Unable to launch a browser: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
  }

  private static async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browserLaunchPromise ??= this.launchBrowser();
      try {
        this.browser = await this.browserLaunchPromise;
      } finally {
        this.browserLaunchPromise = null;
      }
    }
    return this.browser;
  }

  /**
   * Creates an isolated context for a site. auth/<siteId>.json is loaded on
   * every run when available; no Chromium profile directory is used.
   */
  public static async createContextForSite(
    siteId: string,
    _options: { headless?: boolean } = {},
  ): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const authFile = Config.getAuthFilePath(siteId);

    if (!fs.existsSync(Config.authDir)) {
      fs.mkdirSync(Config.authDir, { recursive: true });
    }

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      acceptDownloads: true,
    };

    const context = fs.existsSync(authFile)
      ? await browser.newContext({ ...contextOptions, storageState: authFile })
      : await browser.newContext(contextOptions);

    if (fs.existsSync(authFile)) {
      console.log(`🔑 [Session] 載入 ${siteId}: ${path.basename(authFile)}`);
    } else {
      console.log(`ℹ️ [Session] ${siteId} 尚無登入快照，建立新 Context。`);
    }

    await context.addInitScript({ content: this.NAME_POLYFILL });
    return context;
  }

  /** Save the active site's session as the source of truth for future runs. */
  public static async saveContextState(context: BrowserContext, siteId: string): Promise<void> {
    if (!fs.existsSync(Config.authDir)) {
      fs.mkdirSync(Config.authDir, { recursive: true });
    }
    const authFile = Config.getAuthFilePath(siteId);
    await context.storageState({ path: authFile });
    console.log(`💾 [Session] ${siteId} 已儲存至 ${path.basename(authFile)}`);
  }

  public static async printPageToPdf(sourcePage: Page, url: string, filePath: string): Promise<void> {
    if (Config.headless) {
      await sourcePage.pdf({ path: filePath, format: 'A4', printBackground: true });
      return;
    }

    if (!this.printBrowser) {
      this.printBrowserLaunchPromise ??= chromium.launch({
        headless: true,
        args: this.launchArgs,
      });
      try {
        this.printBrowser = await this.printBrowserLaunchPromise;
      } finally {
        this.printBrowserLaunchPromise = null;
      }
    }

    const storageState = await sourcePage.context().storageState();
    const context = await this.printBrowser.newContext({ storageState });
    const page = await context.newPage();
    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1000);
      } else {
        await page.setContent(await sourcePage.content(), { waitUntil: 'load' });
      }
      await page.pdf({ path: filePath, format: 'A4', printBackground: true });
    } finally {
      await page.close().catch(() => { });
      await context.close().catch(() => { });
    }
  }

  public static async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => { });
      this.browser = null;
    }
    this.browserLaunchPromise = null;

    if (this.printBrowser) {
      await this.printBrowser.close().catch(() => { });
      this.printBrowser = null;
    }
    this.printBrowserLaunchPromise = null;
  }
}
