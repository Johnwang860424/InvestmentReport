import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { CaptchaService } from '../core/captcha';
import { DownloadManager } from '../core/downloader';

export class FubonCrawler extends BaseSiteCrawler {
  readonly id = 'fubon';
  readonly name = '富邦投顧';
  readonly baseUrl = 'https://fubonresearch.fubon.com/Research';

  /**
   * 富邦投顧登入流程
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態...`);
    try {
      await page.goto(`${this.baseUrl}/Report/Index?c1=2`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      // 若已登入，當前網址會停留在 Report/Index 且具有報告列表
      const isReportPage = page.url().includes('/Report/Index');
      const hasReports = (await page.locator('.box2.gradient, .grid3 .box2').count().catch(() => 0)) > 0;
      if (isReportPage && hasReports) {
        console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
        return true;
      }
    } catch {
      // 忽略導頁超時，直接進入登入頁
    }

    console.log(`🔐 [${this.name}] 尚未登入，開始自動登入與驗證碼辨識...`);
    await page.goto(`${this.baseUrl}/Member/Login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#idno, #codeimg', { state: 'visible', timeout: 15000 });

    const creds = this.getCredentials();
    const captchaPath = this.getTempCaptchaPath();

    if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);

    try {
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`🔄 [${this.name}] 登入嘗試 (第 ${attempt} / ${maxAttempts} 次)...`);

        // 填入帳號 (身分證字號) 與密碼
        await page.fill('#idno', creds.user);
        await page.fill('#pwd', creds.pass);

        // 截取驗證碼
        const captchaImg = page.locator('#codeimg');
        await captchaImg.waitFor({ state: 'visible', timeout: 5000 });
        if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);
        await captchaImg.screenshot({ path: captchaPath });
        await page.waitForTimeout(500);

        // AI 視覺辨識 (富邦投顧驗證碼為 6 位數字)
        const captchaCode = CaptchaService.recognize(captchaPath, 6) || CaptchaService.recognize(captchaPath, 5);
        if (!captchaCode) {
          console.log(`🔄 [${this.name}] 辨識結果無效，刷新驗證碼重試...`);
          await captchaImg.click();
          await page.waitForTimeout(1000);
          continue;
        }

        // 攔截 alert / dialog
        let alertMsg = '';
        const dialogHandler = async (dialog: any) => {
          alertMsg = dialog.message();
          console.log(`⚠️ [${this.name}] 頁面提示: ${alertMsg}`);
          await dialog.accept().catch(() => {});
        };
        page.once('dialog', dialogHandler);

        // 填入驗證碼並送出
        await page.fill('#code', captchaCode);
        await page.click('button[type="submit"], .btn1');

        // 等待回應
        await page.waitForTimeout(3000);
        page.off('dialog', dialogHandler);

        // 檢查頁面彈窗錯誤訊息 (jquery-confirm)
        const errPop = await page.locator('.jconfirm-content').first().innerText().catch(() => '');
        if (errPop) {
          console.log(`⚠️ [${this.name}] 頁面彈窗: ${errPop.trim()}`);
          await page.locator('.jconfirm-buttons button').click().catch(() => {});
          await page.waitForTimeout(1000);
        }

        // 驗證是否登入成功 (導向首頁或報告頁，且登入表單消失)
        const isLoginVisible = await page.locator('#idno').isVisible().catch(() => false);
        if (!isLoginVisible || page.url().includes('/Home/') || page.url().includes('/Report/')) {
          console.log(`🎉 [${this.name}] 登入成功！`);
          await this.saveSession(context);
          return true;
        } else {
          console.log(`⚠️ [${this.name}] 登入未成功（${alertMsg || errPop || '請檢查帳密或驗證碼'}），刷新驗證碼重試...`);
          await captchaImg.click().catch(() => {});
          await page.waitForTimeout(1500);
        }
      }

      throw new Error(`❌ [${this.name}] 超過最大嘗試次數，登入失敗！`);
    } finally {
      if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);
    }
  }

  /**
   * 解析並標準化報告發布日期為 YYYYMMDD。
   */
  private normalizeDate(rawDateStr: string): string | null {
    const cleaned = rawDateStr.replace(/[\r\n\t]+/g, ' ').trim();
    if (!cleaned) {
      return null;
    }

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

    // 若僅有純數字，取出前 8 位數字
    const digits = cleaned.replace(/[^\d]/g, '');
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }

    return null;
  }

  /**
   * 富邦投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);

    const categories = [
      {
        c1: '2',
        c2: '14',
        name: '個股報告',
        folder: 'EquityReport',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['個股', '個股報告', 'EquityReport'],
      },
      {
        c1: '2',
        c2: '15',
        name: '產業報告',
        folder: '產業報告',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['產業', '產業報告'],
      },
      {
        c1: '2',
        c2: '16',
        name: 'Quickmail',
        folder: 'Quickmail',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['Quickmail', 'quickmail'],
      },
      {
        c1: '2',
        c2: '13',
        name: '策略報告',
        folder: '策略報告',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['策略', '策略報告'],
      },
      {
        c1: '2',
        c2: '12',
        name: '中文Morning Call',
        folder: '晨訊',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['晨訊', 'Morning Call', '中文Morning Call'],
      },
      {
        c1: '1',
        c2: '',
        name: '大盤策略及熱門議題',
        folder: '大盤策略',
        url: `${this.baseUrl}/Report/Index`,
        aliases: ['大盤', '大盤策略', '熱門議題'],
      },
      {
        c1: '4',
        c2: '',
        name: '海外個股及產業報告',
        folder: '海外報告',
        url: `${this.baseUrl}/Report/Oversea`,
        aliases: ['海外個股', '海外報告', '美股'],
      },
      {
        c1: '3',
        c2: '',
        name: '海外大盤策略及熱門議題',
        folder: '海外報告',
        url: `${this.baseUrl}/Report/Oversea`,
        aliases: ['海外大盤', '海外策略'],
      },
      {
        c1: '5',
        c2: '',
        name: '總經新聞評論',
        folder: '總經報告',
        url: `${this.baseUrl}/Report/Macro`,
        aliases: ['總經', '總經新聞', '新聞評論'],
      },
      {
        c1: '6',
        c2: '',
        name: '總經週報',
        folder: '總經報告',
        url: `${this.baseUrl}/Report/Macro`,
        aliases: ['總經週報', '週報'],
      },
      {
        c1: '7',
        c2: '',
        name: '總經專題',
        folder: '總經報告',
        url: `${this.baseUrl}/Report/Macro`,
        aliases: ['總經專題', '專題'],
      },
    ];

    // 預設僅下載「個股報告」(c1=2 個股及產業報告, c2=14 個股報告)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        c.aliases?.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.name === '個股報告');

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
      console.log(`\n📂 [${this.name}] 檢查分類: 【${cat.name}】(c1=${cat.c1}${cat.c2 ? `, c2=${cat.c2}` : ''})...`);

      let pageNum = 1;
      const pageSize = 20;
      const maxPages = 20; // 避免無窮分頁的安全上限

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在掃描【${cat.name}】第 ${pageNum} 頁...`);

        const listPageUrl = cat.c2
          ? `${cat.url}?c1=${cat.c1}&c2=${cat.c2}&p_=${pageNum}&ps_=${pageSize}`
          : `${cat.url}?c1=${cat.c1}&p_=${pageNum}&ps_=${pageSize}`;
        await page.goto(listPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);

        // 取得本頁所有卡片 (.box2.gradient 或 .grid3 .box2)
        const rawCards = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('.box2.gradient, .grid3 .box2, .box2'));
          return cards.map(c => {
            const titleEl = c.querySelector('h3.stockname, h3');
            const stockNoEl = c.querySelector('.stock .no');
            const dateEl = c.querySelector('.date .dt, .date, span.dt, p.mt10');
            const detailA = c.querySelector('a.btn5[href*="Detail"], a[href*="Detail"]');
            const authorEl = c.querySelector('p.txt1 font.blue, .analyst, .author');
            const rawText = (c as HTMLElement).innerText || '';

            return {
              title: titleEl?.textContent?.trim() || '',
              stockNo: stockNoEl?.textContent?.trim() || '',
              rawDate: dateEl?.textContent?.trim() || '',
              detailHref: detailA?.getAttribute('href') || '',
              author: authorEl?.textContent?.trim() || '',
              rawText,
            };
          });
        });

        // 過濾無效卡片 (必須有標題或內頁連結)
        const validCards = rawCards.filter(c => c.title && c.detailHref);
        console.log(`📌 發現 ${validCards.length} 篇報告`);

        if (validCards.length === 0) {
          console.log(`ℹ️ [${this.name}] 本頁無更多報告，結束此分類。`);
          break;
        }

        const pageItems: ReportItem[] = [];
        let sawItemWithinCutoff = false;
        let sawItemOlderThanCutoff = false;

        for (const card of validCards) {
          try {
            // 從 rawDate 或 card text 中抽取日期
            const dateMatch = card.rawDate.match(/(\d{4}[./\s-]\d{1,2}[./\s-]\d{1,2})/)
              || card.rawText.match(/(\d{4}[./\s-]\d{1,2}[./\s-]\d{1,2})/);

            const rawDateStr = dateMatch ? dateMatch[1] : card.rawDate;
            const dateStr = this.normalizeDate(rawDateStr);

            if (!dateStr) {
              console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${card.rawDate}")，跳過此篇。`);
              totalSkippedInvalid++;
              continue;
            }

            let fullTitle = card.title;
            if (card.stockNo && !fullTitle.includes(card.stockNo)) {
              fullTitle = `${card.stockNo} ${fullTitle}`;
            }

            const detailUrl = card.detailHref.startsWith('http')
              ? card.detailHref
              : new URL(card.detailHref, this.baseUrl).toString();

            const itemKey = `${dateStr}_${fullTitle}`;

            // 1. 時間過濾 (過去一個月)
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${fullTitle}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            sawItemWithinCutoff = true;

            // 2. 記憶體去重
            if (processedUrls.has(detailUrl) || processedKeys.has(itemKey)) {
              continue;
            }
            processedUrls.add(detailUrl);
            processedKeys.add(itemKey);

            const reportItem: ReportItem = {
              title: fullTitle,
              date: dateStr,
              category: cat.folder,
              siteId: this.id,
              broker: this.name,
              pageUrl: detailUrl,
              canPrintPage: true,
              author: card.author || undefined,
            };

            pageItems.push(reportItem);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 解析報告資訊出錯:`, err.message);
          }
        }

        // 逐一下載本頁符合條件的報告
        for (const item of pageItems) {
          // 3. 實體檔案防重複檢查
          if (DownloadManager.isDownloaded(item)) {
            const safeTitle = DownloadManager.sanitizeFilename(item.title);
            console.log(`⏩ [已存在] 跳過: 【${item.category}/${item.siteId}】${item.date}_${safeTitle}.pdf`);
            totalSkippedExisting++;
            continue;
          }

          // 開啟獨立頁面進行下載，避免影響列表頁 Context
          const detailPage = await context.newPage();
          try {
            const savedPath = await DownloadManager.saveReport(detailPage, item);
            if (savedPath) {
              totalDownloaded++;
            }
            await page.waitForTimeout(800);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 下載報告失敗: ${item.title}`, err.message);
          } finally {
            await detailPage.close().catch(() => {});
          }

          // 達到指定上限篇數則提早結束
          if (options?.maxCount && totalDownloaded >= options.maxCount) {
            console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
            return;
          }
        }

        // 若本頁所有報告皆早於 cutoffDate，停止後續分頁
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前頁所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        // 若本頁報告數量少於 pageSize，表示已是最後一頁
        if (validCards.length < pageSize) {
          break;
        }

        pageNum++;
      }
    }

    console.log(`\n=====================================================`);
    console.log(`📊 [${this.name}] 爬取總結:`);
    console.log(`  - 成功下載: ${totalDownloaded} 篇`);
    console.log(`  - 已存在跳過: ${totalSkippedExisting} 篇`);
    console.log(`  - 超過時間範圍跳過: ${totalSkippedDate} 篇`);
    console.log(`  - 資料不完整跳過: ${totalSkippedInvalid} 篇`);
    console.log(`=====================================================`);
  }
}
