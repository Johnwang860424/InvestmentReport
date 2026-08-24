import { chromium, Browser, Page, BrowserContext, Frame } from 'playwright';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { DownloadManager } from '../core/downloader';
import { Config } from '../config';

export class KgiSessionRefreshRequiredError extends Error {
  constructor() {
    super('KGI session is missing or expired.');
    this.name = 'KgiSessionRefreshRequiredError';
  }
}

export class KGICrawler extends BaseSiteCrawler {
  readonly id = 'kgi';
  readonly name = '凱基投顧';
  readonly baseUrl = 'https://investment.kgisia.com.tw';

  /**
   * 凱基投顧登入流程
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態...`);
    await page.goto(`${this.baseUrl}/Portal/Report/DetailList?ThisType=3`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(1500);

    // 檢查是否已具備登入態 (未被重導向至登入頁，且能看見報告表格或登出元素)
    const isLoginFormVisible = await page.locator('#login-form').isVisible().catch(() => false);
    const isLoginUrl = page.url().includes('/Login/Login') || page.url().includes('/Login');
    const hasReportsTable = (await page.locator('table.cover tr, table tr').count().catch(() => 0)) > 0;
    const hasLogoutElement = (await page.locator('.logOut, a[href*="logoutForm"]').count().catch(() => 0)) > 0;

    if (!isLoginFormVisible && !isLoginUrl && (hasReportsTable || hasLogoutElement)) {
      console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
      await this.dismissPopups(page);
      return true;
    }

    console.log(`🔐 [${this.name}] 尚未登入，開始自動登入流程...`);
    throw new KgiSessionRefreshRequiredError();

    if (!page.url().includes('/Login/Login')) {
      await page.goto(`${this.baseUrl}/Portal/Login/Login`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    }

    await page.waitForSelector('#login-form', { state: 'visible', timeout: 15000 });

    const creds = this.getCredentials();

    await this.fillLoginForm(page, creds);

    // 攔截 alert 對話框
    let alertMsg = '';
    const dialogHandler = async (dialog: any) => {
      alertMsg = dialog.message();
      console.log(`⚠️ [${this.name}] 頁面提示: ${alertMsg}`);
      await dialog.accept().catch(() => { });
    };
    page.on('dialog', dialogHandler);

    try {
      const isVerified = await this.passTurnstile(page, creds);

      if (!isVerified) {
        throw new Error(
          `❌ [${this.name}] Cloudflare Turnstile 驗證未通過！\n` +
          `👉 建議解法：請於終端機執行一次性登入工具：\n` +
          `   Restart the crawler and complete the KGI login in the opened browser.\n` +
          `在跳出的 Chrome 視窗中完成勾選後，Session 將永久保存至 auth/kgi.json，日後即可完全免登入自動下載！`
        );
      }

      // 若 Turnstile 通過後頁面已自行跳轉，就不需要再送出表單
      const submitBtn = page.locator('#submitBtn');
      if (await submitBtn.isVisible().catch(() => false)) {
        console.log(`🚀 [${this.name}] 提交登入表單...`);
        await submitBtn.click();
      }

      // 等待登入後跳轉
      await page.waitForTimeout(3000);

      // 檢查是否登入成功
      const loggedIn = await page.locator('.logOut, a.logOut, a[href*="Logout"], a[href*="LogOut"]').isVisible().catch(() => false);
      const stillOnLogin = page.url().includes('/Login/Login') && (await page.locator('#login-form').isVisible().catch(() => false));

      if (loggedIn || !stillOnLogin) {
        console.log(`🎉 [${this.name}] 登入成功！`);
        await this.dismissPopups(page);
        await this.saveSession(context);
        return true;
      } else {
        throw new Error(`❌ [${this.name}] 登入未成功: ${alertMsg || '請確認帳號、密碼是否正確'}`);
      }
    } finally {
      page.off('dialog', dialogHandler);
    }
  }

  /**
   * 填入帳號與密碼 (reload 換新 challenge 後需要重填，故獨立成方法)
   */
  private async fillLoginForm(page: Page, creds: { user: string; pass: string }): Promise<void> {
    console.log(`📝 [${this.name}] 填入帳號與密碼...`);
    await page.fill('#Accounts', creds.user);
    // 觸發 blur 事件以同步設定 #Account 欄位
    await page.evaluate(() => {
      const accounts = document.getElementById('Accounts') as HTMLInputElement;
      const account = document.getElementById('Account') as HTMLInputElement;
      if (accounts && account) {
        account.value = accounts.value;
      }
    });
    await page.fill('#ipt', creds.pass);
    await page.waitForTimeout(500);
  }

  /**
   * 通過 Cloudflare Turnstile「我不是機器人」驗證。
   *
   * Turnstile 沒有題目可以解，能否通過取決於瀏覽器指紋與行為評分，因此策略是：
   *   1. 先安靜等待 —— managed / invisible 模式常會自動核發 Token，根本不需要點。
   *   2. 需要點時只點「一次」，並以帶弧度與隨機抖動的軌跡移動滑鼠。
   *   3. 失敗就整頁 reload 換一個全新 challenge，絕不原地重複點擊：
   *      高頻重複點擊是最明顯的 bot 特徵，會讓評分直接歸零而再也過不了。
   */
  private async passTurnstile(page: Page, creds: { user: string; pass: string }, maxRounds = 3): Promise<boolean> {
    for (let round = 1; round <= maxRounds; round++) {
      console.log(`🤖 [${this.name}] Cloudflare Turnstile 驗證中... (第 ${round}/${maxRounds} 輪)`);

      // 1. 安靜等待自動核發
      if (await this.waitForTurnstileToken(page, 10000)) return true;

      // 2. 只點一次
      if (!(await this.clickTurnstileCheckbox(page))) {
        console.warn(`⚠️ [${this.name}] 未找到 Turnstile 勾選框，繼續等待自動核發...`);
      }

      // 3. 給足時間讓 Cloudflare 完成評分
      if (await this.waitForTurnstileToken(page, 25000)) return true;

      if (round < maxRounds) {
        console.log(`🔄 [${this.name}] 本輪未取得 Token，重新載入登入頁以換取全新 challenge...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { });
        await page.waitForSelector('#login-form', { state: 'visible', timeout: 15000 }).catch(() => { });
        await this.fillLoginForm(page, creds).catch(() => { });
        await page.waitForTimeout(1500 + Math.random() * 2000);
      }
    }
    return false;
  }

  /**
   * 輪詢隱藏欄位 cf-turnstile-response，取得 Token 即代表驗證通過
   */
  private async waitForTurnstileToken(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 頁面已自行跳離登入頁，視為通過
      if (!page.url().includes('/Login')) {
        console.log(`🎉 [${this.name}] 驗證後頁面已自動跳轉。`);
        return true;
      }

      const token = await page.evaluate(() => {
        const el = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return el ? el.value : '';
      }).catch(() => '');

      if (token) {
        console.log(`🎉 [${this.name}] Turnstile 驗證通過！(Token 長度: ${token.length})`);
        return true;
      }

      await page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * 取得 Turnstile 的 challenge frame。
   *
   * 注意：這個 iframe 不在 document 樹裡 (parentElement 為 null)，因此
   * page.locator('iframe[src*=...]') 之類的 CSS 選擇器【永遠找不到它】。
   * 必須走 Playwright 的 frame 樹，再用 frameElement() 取回可量測的元素。
   */
  private async findTurnstileFrame(page: Page, timeoutMs = 15000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
      if (frame) return frame;
      await page.waitForTimeout(300);
    }
    return null;
  }

  /**
   * 對 Turnstile 勾選框做「單次」擬真點擊。
   * Playwright 的 mouse 事件走 CDP，本身就是 isTrusted 的可信事件，
   * 因此關鍵不在事件真偽，而在移動軌跡與節奏是否像真人。
   */
  private async clickTurnstileCheckbox(page: Page): Promise<boolean> {
    const frame = await this.findTurnstileFrame(page);
    if (!frame) return false;

    const el = await frame.frameElement().catch(() => null);
    if (!el) return false;

    const box = await el.boundingBox();
    if (!box || box.width === 0) return false;

    // 預設落在 widget 左側的圓圈處，若能量到 frame 內部真正的勾選框則優先採用
    let x = box.x + Math.min(30, box.width / 4);
    let y = box.y + box.height / 2;

    const inner = frame.locator('input[type="checkbox"], label.ctp-checkbox-label, .cb-lb').first();
    const innerBox = await inner.boundingBox({ timeout: 3000 }).catch(() => null);
    if (innerBox && innerBox.width > 0) {
      x = innerBox.x + innerBox.width / 2;
      y = innerBox.y + innerBox.height / 2;
    }

    await this.humanMouseMove(page, x, y);
    await page.waitForTimeout(120 + Math.random() * 200);
    await page.mouse.down();
    await page.waitForTimeout(60 + Math.random() * 90);
    await page.mouse.up();

    console.log(`🖱️ [${this.name}] 已點擊 Turnstile 勾選框 (${Math.round(x)}, ${Math.round(y)})，等待 Cloudflare 評分...`);
    return true;
  }

  /**
   * 以二次貝茲曲線移動滑鼠至目標點，模擬真人帶弧度、非等速的手部軌跡
   */
  private async humanMouseMove(page: Page, x: number, y: number): Promise<void> {
    const startX = Math.max(0, x - 150 - Math.random() * 250);
    const startY = Math.max(0, y - 80 - Math.random() * 180);
    await page.mouse.move(startX, startY);

    // 控制點偏離連線中點，讓路徑呈弧形而非機械式直線
    const ctrlX = (startX + x) / 2 + (Math.random() - 0.5) * 140;
    const ctrlY = (startY + y) / 2 + (Math.random() - 0.5) * 140;
    const steps = 22 + Math.floor(Math.random() * 16);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const inv = 1 - t;
      const px = inv * inv * startX + 2 * inv * t * ctrlX + t * t * x;
      const py = inv * inv * startY + 2 * inv * t * ctrlY + t * t * y;
      await page.mouse.move(px, py);
      await page.waitForTimeout(8 + Math.random() * 22);
    }

    await page.mouse.move(x, y);
  }

  /**
   * 關閉凱基投顧常見的彈窗 (例如密碼變更提醒)
   */
  private async dismissPopups(page: Page): Promise<void> {
    try {
      const pwdAlertBtn = page.locator('#alertChangePwd input.on, #alertChangePwd input[value*="不變更"]');
      if (await pwdAlertBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`ℹ️ [${this.name}] 關閉密碼變更提醒彈窗...`);
        await pwdAlertBtn.click().catch(() => { });
        await page.waitForTimeout(500);
      }
    } catch { }
  }

  /**
   * 解析並標準化報告發布日期為 YYYYMMDD
   */
  private normalizeDate(rawDateStr: string): string | null {
    const cleaned = rawDateStr.replace(/[\r\n\t]+/g, ' ').trim();
    if (!cleaned) return null;

    // 匹配 YYYY/MM/DD 或 YYYY-MM-DD 或 YYYY.MM.DD
    const ymdMatch = cleaned.match(/(\d{4})[./\s-]+(\d{1,2})[./\s-]+(\d{1,2})/);
    if (ymdMatch) {
      const year = ymdMatch[1];
      const month = ymdMatch[2].padStart(2, '0');
      const day = ymdMatch[3].padStart(2, '0');
      return `${year}${month}${day}`;
    }

    // 匹配民國年，例如 115/08/20 或 113.08.20
    const rocMatch = cleaned.match(/^(\d{2,3})[./\s-]+(\d{1,2})[./\s-]+(\d{1,2})/);
    if (rocMatch) {
      const year = String(parseInt(rocMatch[1], 10) + 1911);
      const month = rocMatch[2].padStart(2, '0');
      const day = rocMatch[3].padStart(2, '0');
      return `${year}${month}${day}`;
    }

    // 匹配 MM/DD (補當前年份)
    const mdMatch = cleaned.match(/^(\d{1,2})[./\s-]+(\d{1,2})$/);
    if (mdMatch) {
      const year = new Date().getFullYear();
      const month = mdMatch[1].padStart(2, '0');
      const day = mdMatch[2].padStart(2, '0');
      return `${year}${month}${day}`;
    }

    // 純數字取出前 8 位
    const digits = cleaned.replace(/[^\d]/g, '');
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }

    return null;
  }

  /**
   * 凱基投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);

    const categories = [
      { type: '3', name: '個股剖析', folder: 'EquityReport', aliases: ['個股', '個股報告', '台股個股'] },
      { type: '8', name: '海外個股剖析', folder: 'EquityReport', aliases: ['海外個股', '海外個股剖析', '美股個股', '美股'] },
      { type: '2', name: '產業脈動', folder: '產業', aliases: ['產業', '產業脈動', '台股產業', '產業報告'] },
      { type: '7', name: '海外產業脈動', folder: '海外產業', aliases: ['海外產業', '海外產業脈動'] },
      { type: '1', name: '大盤策略', folder: '大盤策略', aliases: ['大盤', '策略', '大盤策略', '總經'] },
      { type: '6', name: '海外大盤策略', folder: '海外大盤策略', aliases: ['海外大盤', '海外大盤策略', '海外總經'] },
    ];

    // 預設僅下載「個股剖析」(台股個股) 分類 (若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.type) ||
        c.aliases?.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.type === '3' || c.name === '個股剖析');

    if (targetCategories.length === 0) {
      throw new Error(
        `❌ [${this.name}] 找不到符合的分類「${options?.categories?.join('、')}」，` +
        `可用分類: ${categories.map(c => c.name).join('、')}`
      );
    }

    // 計算過去一個月的基準日期 (YYYYMMDD)
    const monthsBack = options?.months ?? 1;
    let cutoffDateStr = options?.startDate;
    if (!cutoffDateStr) {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
      const year = cutoffDate.getFullYear();
      const month = String(cutoffDate.getMonth() + 1).padStart(2, '0');
      const day = String(cutoffDate.getDate()).padStart(2, '0');
      cutoffDateStr = `${year}${month}${day}`;
    }

    console.log(`📅 [${this.name}] 時間過濾條件：抓取 ${cutoffDateStr} 至今 (過去 ${monthsBack} 個月) 之報告`);

    // 執行期間防重複快取
    const processedUrls = new Set<string>();
    const processedKeys = new Set<string>();

    let totalDownloaded = 0;
    let totalSkippedDate = 0;
    let totalSkippedExisting = 0;
    let totalSkippedInvalid = 0;

    for (const cat of targetCategories) {
      console.log(`\n📂 [${this.name}] 檢查分類: 【${cat.name}】...`);

      const targetUrl = `${this.baseUrl}/Portal/Report/DetailList?ThisType=${cat.type}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      await this.dismissPopups(page);

      let pageNum = 1;
      const maxPages = 20;

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在掃描【${cat.name}】第 ${pageNum} 頁...`);

        // 等待表格載入並取得所有資料列 (排除表頭 th)
        const rows = await page.locator('table.cover tr, table tr').all();
        const itemRows: any[] = [];
        for (const row of rows) {
          const hasTh = (await row.locator('th').count()) > 0;
          if (!hasTh) {
            itemRows.push(row);
          }
        }

        console.log(`📌 發現 ${itemRows.length} 篇報告`);

        if (itemRows.length === 0) {
          break;
        }

        // 收集本頁待處理的報告項目資訊
        const pageItems: ReportItem[] = [];
        let sawItemWithinCutoff = false;
        let sawItemOlderThanCutoff = false;

        for (const row of itemRows) {
          try {
            const tds = await row.locator('td').all();
            if (tds.length === 0) continue;

            // 取得日期 (通常在第一欄 td[0])
            const rawDate = (await tds[0].innerText().catch(() => '')).trim();
            const dateStr = this.normalizeDate(rawDate);
            if (!dateStr) {
              console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${rawDate}")，跳過此列。`);
              totalSkippedInvalid++;
              continue;
            }

            // 取得報告連結與標題 (尋找 a[href*="GetFile"])
            const linkElem = row.locator('a[href*="GetFile"], a[href*="/Portal/Report/GetFile"]').first();
            const href = await linkElem.getAttribute('href').catch(() => null);
            if (!href) continue;

            let title = (await linkElem.innerText().catch(() => '')).trim();
            if (!title) {
              // 備用從第二欄 td[1] 取得
              if (tds.length >= 2) {
                title = (await tds[1].innerText().catch(() => '')).trim();
              }
            }
            if (!title) continue;

            // 標題清理 (移除換行)
            title = title.replace(/[\r\n\t]+/g, ' ').trim();

            // 若為純語音音訊播報 (非 PDF 研究報告)，則跳過
            if (title.includes('語音') || title.includes('播報') || title.includes('Podcast')) {
              continue;
            }

            // 研究員 (選填)
            let author: string | undefined;
            if (tds.length >= 3) {
              const authorText = (await tds[2].innerText().catch(() => '')).trim();
              if (authorText && !authorText.includes('GetFile')) {
                author = authorText;
              }
            }

            const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
            const itemKey = `${dateStr}_${title}`;

            // 1. 時間過濾
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${title}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            sawItemWithinCutoff = true;

            // 2. 記憶體去重
            if (processedUrls.has(fullUrl) || processedKeys.has(itemKey)) {
              continue;
            }
            processedUrls.add(fullUrl);
            processedKeys.add(itemKey);

            const reportItem: ReportItem = {
              title,
              date: dateStr,
              category: cat.folder,
              siteId: this.id,
              broker: this.name,
              pageUrl: fullUrl,
              pdfUrl: fullUrl, // 直接透過 GetFile 下載 PDF
              author,
            };

            pageItems.push(reportItem);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 解析報告資訊出錯:`, err.message);
          }
        }

        // 逐一處理本頁符合條件的報告
        for (const item of pageItems) {
          // 3. 實體檔案防重複檢查
          if (DownloadManager.isDownloaded(item)) {
            const safeTitle = DownloadManager.sanitizeFilename(item.title);
            console.log(`⏩ [已存在] 跳過: 【${item.category}/${item.siteId}】${item.date}_${safeTitle}.pdf`);
            totalSkippedExisting++;
            continue;
          }

          try {
            const savedPath = await DownloadManager.saveReport(page, item);
            if (savedPath) {
              totalDownloaded++;
            }
            await page.waitForTimeout(800);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 下載報告失敗: ${item.title}`, err.message);
          }

          // 達到上限篇數則提前結束
          if (options?.maxCount && totalDownloaded >= options.maxCount) {
            console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
            return;
          }
        }

        // 終止條件：整頁均早於基準日且無任何符合項目
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前頁所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        // 尋找下一頁按鈕
        const nextTargetPage = pageNum + 1;
        const nextPageNumLink = page.locator(`.page ul li a:has-text("${nextTargetPage}"), .pagination a:has-text("${nextTargetPage}")`).first();
        const nextBtn = page.locator('.page a:has-text(">"), .page a:has-text("下一頁"), .page .next, .pagination .next').first();

        let clickedNext = false;
        if (await nextPageNumLink.isVisible().catch(() => false)) {
          await nextPageNumLink.click();
          clickedNext = true;
        } else if (await nextBtn.isVisible().catch(() => false)) {
          await nextBtn.click();
          clickedNext = true;
        }

        if (clickedNext) {
          await page.waitForTimeout(2000);
          await this.dismissPopups(page);
          pageNum++;
        } else {
          break;
        }
      }
    }

    console.log(`\n=====================================================`);
    console.log(`📊 [${this.name}] 爬取總結:`);
    console.log(`  - 成功下載: ${totalDownloaded} 篇`);
    console.log(`  - 已存在跳過: ${totalSkippedExisting} 篇`);
    console.log(`  - 超過一個月跳過: ${totalSkippedDate} 篇`);
    console.log(`  - 資料不完整跳過: ${totalSkippedInvalid} 篇`);
    console.log(`=====================================================`);
  }
}

/**
 * Opens a native browser for manual Cloudflare verification. Once authenticated,
 * an optional task can keep using that same CDP page and context before they are
 * closed. The verified storage state is persisted both before and after the task.
 */
export async function refreshKgiSession(
  onAuthenticated?: (page: Page, context: BrowserContext) => Promise<void>,
): Promise<void> {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const browserPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!browserPath) throw new Error('Google Chrome or Microsoft Edge was not found.');

  const loginUrl = 'https://investment.kgisia.com.tw/Portal/Login/Login';
  const checkUrl = 'https://investment.kgisia.com.tw/Portal/Report/DetailList?ThisType=3';
  const port = 9222;
  const profilePath = path.join(Config.tempDir, 'kgi-login-profile');
  fs.mkdirSync(profilePath, { recursive: true });

  const chromeProcess = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    loginUrl,
  ], { detached: false, stdio: 'ignore' });

  await new Promise<void>(resolve => setTimeout(resolve, 1500));

  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    const credentials = Config.sites.kgi;

    if (!credentials.user || !credentials.pass) {
      throw new Error('Set KGI_USER and KGI_PASS before refreshing the KGI session.');
    }

    await page.waitForSelector('#Accounts', { state: 'visible', timeout: 15000 });
    await page.fill('#Accounts', credentials.user);
    await page.evaluate((user) => {
      const visibleAccount = document.getElementById('Accounts') as HTMLInputElement | null;
      const hiddenAccount = document.getElementById('Account') as HTMLInputElement | null;
      if (visibleAccount) visibleAccount.value = user;
      if (hiddenAccount) hiddenAccount.value = user;
    }, credentials.user);
    await page.fill('#ipt', credentials.pass);

    console.log('Complete Cloudflare manually in the opened browser. KGI will submit automatically after a token is available.');
    const deadline = Date.now() + 180000;
    let token = '';
    while (Date.now() < deadline && page.url().includes('/Login')) {
      token = await page.evaluate(() => {
        const field = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | HTMLTextAreaElement | null;
        return field?.value ?? '';
      });
      if (token) break;
      await page.waitForTimeout(1000);
    }

    if (page.url().includes('/Login')) {
      if (!token) throw new Error('Cloudflare verification timed out.');
      const submitButton = page.locator('#submitBtn');
      await submitButton.waitFor({ state: 'visible', timeout: 10000 });
      await submitButton.click();
      await page.waitForTimeout(1500);
    }

    await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const onLoginPage = page.url().includes('/Login');
    const hasLogout = (await page.locator('.logOut, a[href*="logoutForm"], a[href*="Logout"]').count().catch(() => 0)) > 0;
    const hasReportTable = (await page.locator('table.cover tr, table tr').count().catch(() => 0)) > 0;
    if (onLoginPage || !(hasLogout || hasReportTable)) {
      throw new Error(`KGI login was not confirmed: ${page.url()}`);
    }

    const saveSession = async () => {
      if (!fs.existsSync(Config.authDir)) fs.mkdirSync(Config.authDir, { recursive: true });
      const authFile = Config.getAuthFilePath('kgi');
      await context.storageState({ path: authFile });
      console.log(`KGI session saved to ${authFile}`);
    };

    await saveSession();
    if (onAuthenticated) {
      await onAuthenticated(page, context);
      await saveSession();
    }
  } finally {
    if (browser) await browser.close().catch(() => { });
    chromeProcess.kill();
  }
}
