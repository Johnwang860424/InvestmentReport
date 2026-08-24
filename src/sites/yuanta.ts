import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { CaptchaService } from '../core/captcha';
import { DownloadManager } from '../core/downloader';

export class YuantaCrawler extends BaseSiteCrawler {
  readonly id = 'yuanta';
  readonly name = '元大投顧';
  readonly baseUrl = 'https://www.yuanta-consulting.com.tw';

  /**
   * 元大投顧登入流程
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態...`);
    await page.goto(`${this.baseUrl}/report/list`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    // 檢查是否已具備登入態
    const isLogoutBtn = await page.locator('.button-send-logout').isVisible().catch(() => false);
    if (isLogoutBtn) {
      console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
      return true;
    }

    console.log(`🔐 [${this.name}] 尚未登入，開始自動登入與驗證碼辨識...`);
    if (!page.url().includes('/account/login')) {
      await page.goto(`${this.baseUrl}/account/login?ReturnUrl=%2freport%2flist`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    await page.waitForSelector('#loginForm', { state: 'visible', timeout: 15000 });

    const creds = this.getCredentials();
    const captchaPath = this.getTempCaptchaPath();

    // 殘留的舊圖檔會在截圖失敗時被當成本次的驗證碼讀取，因此進出都要清乾淨
    if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);

    try {
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`🔄 [${this.name}] 登入嘗試 (第 ${attempt} / ${maxAttempts} 次)...`);

        // 填入帳號與密碼
        await page.fill('#loginForm input[name="userName"]', creds.user);
        await page.fill('#loginForm input[name="password"]', creds.pass);

        // 截取驗證碼
        const captchaImg = page.locator('#loginForm .image-captcha');
        await captchaImg.waitFor({ state: 'visible', timeout: 5000 });
        if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);
        await captchaImg.screenshot({ path: captchaPath });
        await page.waitForTimeout(500);

        // AI 視覺辨識
        const captchaCode = CaptchaService.recognize(captchaPath, 5);
        if (!captchaCode) {
          console.log(`🔄 [${this.name}] 辨識結果無效，刷新驗證碼重試...`);
          await captchaImg.click();
          await page.waitForTimeout(1000);
          continue;
        }

        // 攔截 alert
        let alertMsg = '';
        const dialogHandler = async (dialog: any) => {
          alertMsg = dialog.message();
          console.log(`⚠️ [${this.name}] 頁面提示: ${alertMsg}`);
          await dialog.accept().catch(() => { });
        };
        page.once('dialog', dialogHandler);

        // 填入驗證碼並提交
        await page.fill('#loginForm input[name="captcha"]', captchaCode);
        await page.click('#loginForm .button-submit a');

        // 等待回應
        await page.waitForTimeout(3000);
        page.off('dialog', dialogHandler);

        // 驗證是否登入成功
        const loggedIn = await page.locator('.button-send-logout').isVisible().catch(() => false);
        const isLoginVisible = await page.locator('#loginForm').isVisible().catch(() => false);

        if (loggedIn || (!isLoginVisible && !page.url().includes('/account/login'))) {
          console.log(`🎉 [${this.name}] 登入成功！`);
          await this.saveSession(context);
          return true;
        } else {
          console.log(`⚠️ [${this.name}] 登入未成功（${alertMsg || '請檢查帳密或驗證碼'}），刷新驗證碼重試...`);
          await captchaImg.click();
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
   * 無法解析時回傳 null——不可退回「今天」，那會讓同一篇報告每天以新檔名重複下載。
   */
  private normalizeDate(rawDateStr: string): string | null {
    const cleaned = rawDateStr.replace(/[\r\n\t]+/g, ' ').trim();
    if (!cleaned) {
      return null;
    }

    // 匹配 YYYY/MM/DD 或 YYYY-MM-DD 或 YYYY.MM.DD 或包含空格/換行的日期
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

    // 若僅有純數字，取出前 8 位數字
    const digits = cleaned.replace(/[^\d]/g, '');
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }

    return null;
  }

  /**
   * 元大投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);
    await page.goto(`${this.baseUrl}/report/list`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    const categories = [
      { index: '0', name: '全部' },
      { index: '1', name: '台股個股', aliases: ['個股', '個股報告'] },
      { index: '2', name: '台股產業', aliases: ['產業', '產業報告'] },
      { index: '3', name: '全球總經', aliases: ['總經', '全球總經'] },
      { index: '4', name: '美股研究', aliases: ['美股', '美股研究'] },
      { index: '5', name: '日股研究', aliases: ['日股', '日股研究'] },
      { index: '6', name: 'ETF研究', aliases: ['ETF', 'ETF研究'] },
      { index: '7', name: '其他', aliases: ['其他'] },
    ];

    // 預設僅下載「台股個股」分類 (若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.index) ||
        c.aliases?.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.index === '1' || c.name === '台股個股');

    // 指定的分類拼錯時若靜默跳過，結果會與「沒有新報告」無法區分，因此直接報錯
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

      // 切換頁籤 (找不到頁籤就跳過該分類，否則會抓到別的頁籤內容卻標上這個分類)
      const tabSelector = `.widget-sheet-tabs .tab-menu[index="${cat.index}"]`;
      const tab = page.locator(tabSelector);
      if (!(await tab.isVisible().catch(() => false))) {
        console.error(`❌ [${this.name}] 找不到分類頁籤【${cat.name}】(${tabSelector})，跳過此分類。`);
        continue;
      }
      await tab.click();
      await page.waitForTimeout(1500);

      let pageNum = 1;
      const maxPages = 20; // 避免無窮分頁的安全上限

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在掃描【${cat.name}】第 ${pageNum} 頁...`);

        // 等待表格載入並取得所有報告列 (tr.item-by-list)
        const itemRows = await page.locator('tr.item-by-list').all();
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
            const dateElem = row.locator('.date').first();
            const rawDate = (await dateElem.innerText().catch(() => '')).trim();
            const dateStr = this.normalizeDate(rawDate);
            if (!dateStr) {
              console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${rawDate}")，跳過此列。`);
              totalSkippedInvalid++;
              continue;
            }

            // 報告內頁連結在 tr 的 url 屬性上
            const href = await row.getAttribute('url');
            if (!href) continue;

            const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;

            // 標題在 .ellipsis 或 .multiline-ellipsis
            const titleElem = row.locator('.ellipsis, .multiline-ellipsis').first();
            let title = (await titleElem.innerText().catch(() => '')).trim();
            if (!title) {
              const tds = await row.locator('td').all();
              if (tds.length >= 3) {
                title = (await tds[2].innerText().catch(() => '')).trim();
              }
            }
            if (!title) continue;

            // 研究員 (選填)
            const tds = await row.locator('td').all();
            const author = tds.length >= 4 ? (await tds[3].innerText().catch(() => '')).trim() : undefined;

            const itemKey = `${dateStr}_${title}`;

            // 1. 時間過濾 (過去一個月)
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${title}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            // 發現有在時間範圍內的報告
            sawItemWithinCutoff = true;

            // 2. 記憶體去重 (避免同一次執行重複處理相同項目)
            if (processedUrls.has(fullUrl) || processedKeys.has(itemKey)) {
              continue;
            }
            processedUrls.add(fullUrl);
            processedKeys.add(itemKey);

            const reportItem: ReportItem = {
              title,
              date: dateStr,
              category: (cat.index === '1' || cat.name.includes('個股')) ? 'EquityReport' : cat.name,
              siteId: this.id,
              broker: this.name,
              pageUrl: fullUrl,
              canPrintPage: true,
              author,
            };

            pageItems.push(reportItem);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 解析報告資訊出錯:`, err.message);
          }
        }

        // 逐一處理本頁符合時間條件的報告
        for (const item of pageItems) {
          // 3. 實體檔案防重複檢查 (若本機已存在檔案則直接跳過，不進入內頁)
          if (DownloadManager.isDownloaded(item)) {
            const safeTitle = DownloadManager.sanitizeFilename(item.title);
            console.log(`⏩ [已存在] 跳過: 【${item.category}/${item.siteId}】${item.date}_${safeTitle}.pdf`);
            totalSkippedExisting++;
            continue;
          }

          // 開啟獨立頁面進行下載，避免清單頁 Context 被破壞
          const detailPage = await context.newPage();
          try {
            const savedPath = await DownloadManager.saveReport(detailPage, item);
            if (savedPath) {
              totalDownloaded++;
            }
            await page.waitForTimeout(1000);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 下載報告失敗: ${item.title}`, err.message);
          } finally {
            await detailPage.close().catch(() => { });
          }

          // 達到上限篇數則提前結束
          if (options?.maxCount && totalDownloaded >= options.maxCount) {
            console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
            return;
          }
        }

        // 只有在「確實看到早於基準日的報告，且本頁沒有任何在範圍內的報告」時才停止翻頁；
        // 若整頁都是無法解析的雜列，不能當成已爬到更早的報告而中斷後續分頁
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前頁所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        // 尋找下一頁按鈕
        const nextBtn = page.locator('.PagedList-skipToNext:not(.disabled) a, .pagination .page-next:not(.disabled), .pagination a[rel="next"]').first();
        const hasNext = await nextBtn.isVisible().catch(() => false);
        if (hasNext) {
          await nextBtn.click();
          await page.waitForTimeout(2000);
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
