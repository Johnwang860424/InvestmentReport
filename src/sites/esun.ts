import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { CaptchaService } from '../core/captcha';
import { DownloadManager } from '../core/downloader';
import { Config } from '../config';

export class EsunCrawler extends BaseSiteCrawler {
  readonly id = 'esun';
  readonly name = '玉山投顧';
  readonly baseUrl = 'https://www.esunconsulting.com.tw';

  /**
   * 檢查當前頁面是否包含登出按鈕或處於已登入狀態
   */
  private async isLoggedIn(page: Page): Promise<boolean> {
    try {
      const hasLogoutBtn = await page.locator('a[href*="Logout"], a[href*="logout"], .btn_logout, a:has-text("登出")').isVisible().catch(() => false);
      const isLoginUrl = page.url().includes('/Login');
      return hasLogoutBtn || !isLoginUrl;
    } catch {
      return false;
    }
  }

  /**
   * 關閉可能干擾操作的彈出對話框 (如系統訊息或宣告)
   */
  private async dismissPopups(page: Page): Promise<void> {
    try {
      const closeBtns = page.locator('.popup_close, .popup_close:visible, #login_msg .popup_close');
      const count = await closeBtns.count();
      for (let i = 0; i < count; i++) {
        const btn = closeBtns.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true }).catch(() => {});
        }
      }
    } catch {}
  }

  /**
   * 玉山投顧登入流程
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態...`);

    // 嘗試前往國內個股報告頁確認 Session 是否有效
    const checkUrl = `${this.baseUrl}/Report/Index/b24e7257-323e-4f8b-a7fc-850bf6499251?sub_id=660389d6-c70a-4978-b607-c76c4a0599bb`;
    await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    if (await this.isLoggedIn(page) && !page.url().includes('/Login')) {
      console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
      await this.dismissPopups(page);
      return true;
    }

    console.log(`🔐 [${this.name}] 尚未登入，開始自動登入與驗證碼辨識...`);
    if (!page.url().includes('/Login')) {
      await page.goto(`${this.baseUrl}/Login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    await page.waitForSelector('#bid', { state: 'visible', timeout: 15000 });

    const creds = this.getCredentials();
    const branch = creds.branch || Config.sites.esun?.branch || '8840';
    const captchaPath = this.getTempCaptchaPath();

    if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);

    try {
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`🔄 [${this.name}] 登入嘗試 (第 ${attempt} / ${maxAttempts} 次)...`);

        // 等待分公司下拉選單就緒
        await page.waitForFunction(() => {
          const select = document.querySelector('#bid') as HTMLSelectElement;
          return select && select.options.length > 1;
        }, { timeout: 10000 }).catch(() => {});

        // 關閉任何可能擋住畫面的 popup
        await this.dismissPopups(page);

        // 選擇分公司
        await page.selectOption('#bid', branch).catch(async () => {
          // 若 selectOption 失敗則嘗試直接設定值
          await page.evaluate((b) => {
            const el = document.getElementById('bid') as HTMLSelectElement;
            if (el) el.value = b;
          }, branch);
        });

        // 填入帳號 / 身分證字號
        await page.fill('#ssn', creds.user);

        // 填入密碼
        await page.fill('#pwd', creds.pass);

        // 截取 4 位數字圖形驗證碼
        const captchaImg = page.locator('#vcodeimg');
        await captchaImg.waitFor({ state: 'visible', timeout: 8000 });
        await captchaImg.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);

        if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);
        await captchaImg.screenshot({ path: captchaPath });

        // AI 視覺辨識 (4 位數字)
        const captchaCode = CaptchaService.recognize(captchaPath, 4);
        if (!captchaCode) {
          console.log(`🔄 [${this.name}] 辨識結果無效，刷新驗證碼重試...`);
          await page.click('.input_verify_reflash').catch(() => {});
          await page.waitForTimeout(1500);
          continue;
        }

        // 攔截 alert 對話框
        let alertMsg = '';
        const dialogHandler = async (dialog: any) => {
          alertMsg = dialog.message();
          console.log(`⚠️ [${this.name}] 頁面提示: ${alertMsg}`);
          await dialog.accept().catch(() => {});
        };
        page.once('dialog', dialogHandler);

        // 填入驗證碼並提交
        await page.fill('input[name="vcode"]', captchaCode);
        await page.click('.btn_login a');

        // 等待送出與頁面跳轉
        await page.waitForTimeout(3500);
        page.off('dialog', dialogHandler);

        // 檢查頁面上是否出現登入錯誤訊息彈窗
        const msgPopup = page.locator('#login_msg');
        let errorPopupText = '';
        if (await msgPopup.isVisible().catch(() => false)) {
          errorPopupText = (await msgPopup.innerText().catch(() => '')).trim();
          console.log(`⚠️ [${this.name}] 登入錯誤訊息: "${errorPopupText}"`);
          await this.dismissPopups(page);
        }

        // 驗證是否登入成功
        const currentUrl = page.url();
        const loggedIn = await this.isLoggedIn(page);

        if (loggedIn && !currentUrl.includes('/Login')) {
          console.log(`🎉 [${this.name}] 登入成功！`);
          await this.dismissPopups(page);
          await this.saveSession(context);
          return true;
        }

        console.log(`⚠️ [${this.name}] 登入未成功（${errorPopupText || alertMsg || '可能驗證碼或帳密錯誤'}），刷新驗證碼重試...`);
        await page.click('.input_verify_reflash').catch(() => {});
        await page.waitForTimeout(1500);
      }

      throw new Error(`❌ [${this.name}] 超過最大嘗試次數，登入失敗！請檢查 .env 中的 ESUN_USER, ESUN_PASS 與 ESUN_BRANCH 設定。`);
    } finally {
      if (fs.existsSync(captchaPath)) fs.unlinkSync(captchaPath);
    }
  }

  /**
   * 解析並標準化報告發布日期為 YYYYMMDD。
   * 無法解析時回傳 null
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
   * 玉山投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);

    const categories = [
      {
        id: '660389d6-c70a-4978-b607-c76c4a0599bb',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國內個股研究報告',
        folder: 'EquityReport',
        aliases: ['個股', '個股報告', '國內個股', '台股個股', '國內個股研究報告'],
      },
      {
        id: '8f106c48-8643-4d69-87c6-4046ee3267be',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國外個股研究報告',
        folder: 'EquityReport',
        aliases: ['國外個股', '美股個股', '國外個股研究報告'],
      },
      {
        id: '9d7f021a-532d-45b8-960e-e131c2f8ab90',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國外個股週報',
        folder: 'EquityReport',
        aliases: ['國外個股週報', '美股週報'],
      },
      {
        id: '54b9a00b-b849-4969-90a9-6e3b9aa5d2c8',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國內產業週報',
        folder: '產業報告',
        aliases: ['產業', '產業報告', '國內產業週報', '產業週報'],
      },
      {
        id: '59f6060d-8aa2-401f-87dd-f92fe3497585',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國內市場資訊',
        folder: '市場資訊',
        aliases: ['國內市場', '國內市場資訊'],
      },
      {
        id: '2f5df589-8908-4cbc-b6e6-2887bbeef676',
        mainId: 'b24e7257-323e-4f8b-a7fc-850bf6499251',
        name: '國外市場資訊',
        folder: '市場資訊',
        aliases: ['國外市場', '國外市場資訊'],
      },
      {
        id: '132103bf-69fe-490a-91cc-614f9de553c0',
        mainId: '43bab54a-5bfd-458a-bebe-64c7c699d57c',
        name: '台股產業晨訊',
        folder: '晨訊',
        aliases: ['晨訊', '台股晨訊', '台股產業晨訊', '晨報'],
      },
      {
        id: 'bd706a62-fac5-4782-a0c9-6a6aff228021',
        mainId: '43bab54a-5bfd-458a-bebe-64c7c699d57c',
        name: '台股盤後分析',
        folder: '盤勢分析',
        aliases: ['盤後', '台股盤後分析', '盤後分析'],
      },
      {
        id: '857d3b21-7763-4614-af0e-d78596166ff0',
        mainId: '43bab54a-5bfd-458a-bebe-64c7c699d57c',
        name: '即時評論',
        folder: '即時評論',
        aliases: ['即時評論'],
      },
      {
        id: '151c8045-4fc4-43e0-b5c2-4217ba839bfa',
        mainId: '0f09ce9d-3870-4f57-94f3-5628a1429fd6',
        name: '美股晨訊',
        folder: '海外晨訊',
        aliases: ['美股晨訊'],
      },
      {
        id: '9baa0cee-3c34-49c2-ae97-77c5846a43d2',
        mainId: '0f09ce9d-3870-4f57-94f3-5628a1429fd6',
        name: '港股晨訊',
        folder: '海外晨訊',
        aliases: ['港股晨訊'],
      },
      {
        id: 'acfbf9d6-f9b0-4e13-adb7-51c24e59519e',
        mainId: '0f09ce9d-3870-4f57-94f3-5628a1429fd6',
        name: '日股晨訊',
        folder: '海外晨訊',
        aliases: ['日股晨訊'],
      },
      {
        id: '6f959d6e-6a35-4ec8-a2b4-3a004fdbb49a',
        mainId: '312ceb4a-c1b9-413e-902c-7761c2b1ec8e',
        name: '國內掛牌ETF',
        folder: 'ETF報告',
        aliases: ['ETF', '國內ETF', '國內掛牌ETF'],
      },
      {
        id: '0e43c2cc-7fa0-4fc6-9bc2-c25a1c51aea6',
        mainId: '312ceb4a-c1b9-413e-902c-7761c2b1ec8e',
        name: '複委託ETF',
        folder: 'ETF報告',
        aliases: ['複委託ETF', '海外ETF'],
      },
      {
        id: 'a16e672e-79eb-4a48-b22e-6af2172dac67',
        mainId: '8f237039-4acb-4210-9cc8-ad95bf75848d',
        name: '期貨週報',
        folder: '期貨報告',
        aliases: ['期貨週報'],
      },
      {
        id: 'c7fbe8bf-3858-4ff2-982b-a98a623e5b38',
        mainId: '8f237039-4acb-4210-9cc8-ad95bf75848d',
        name: '期貨晨訊',
        folder: '期貨報告',
        aliases: ['期貨晨訊'],
      },
    ];

    // 預設僅下載「國內個股研究報告」(若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.id) ||
        c.aliases?.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.name === '國內個股研究報告');

    if (targetCategories.length === 0) {
      throw new Error(
        `❌ [${this.name}] 找不到符合的分類「${options?.categories?.join('、')}」，` +
        `可用分類: ${categories.map(c => c.name).join('、')}`
      );
    }

    // 計算時間過濾基準日期 (YYYYMMDD)
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
      console.log(`\n📂 [${this.name}] 正在讀取分類: 【${cat.name}】...`);

      const listUrl = `${this.baseUrl}/Report/Index/${cat.mainId}?sub_id=${cat.id}`;
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);

      // 若被導回 Login 頁面，表示 Session 已過期
      if (page.url().includes('/Login')) {
        console.warn(`⚠️ [${this.name}] Session 已過期，嘗試重新登入...`);
        await this.login(page, context);
        await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
      }

      await this.dismissPopups(page);

      let pageNum = 1;
      const maxPages = 20;

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在掃描【${cat.name}】第 ${pageNum} 頁...`);

        // 解析報告清單中的所有項目
        const rawItems = await page.evaluate(() => {
          const listElements = Array.from(
            document.querySelectorAll('.reportList li, ul.reportList > li, .report-list tr, tr.item-by-list')
          );

          if (listElements.length > 0) {
            return listElements.map(li => {
              const timeEl = li.querySelector('.report_time, .time, .date, td:nth-child(2)');
              const titleEl = li.querySelector('.report_title a, .report_title, a[href*="Attachment"], a[href*="Detail"], td:nth-child(3)');
              const a = (titleEl?.tagName === 'A' ? titleEl : li.querySelector('a[href*="Attachment"], a[href*="Detail"], a')) as HTMLAnchorElement;
              return {
                rawDate: (timeEl as HTMLElement)?.innerText?.trim() || '',
                title: (titleEl as HTMLElement)?.innerText?.trim() || a?.innerText?.trim() || '',
                href: a?.href || a?.getAttribute('href') || '',
              };
            });
          }

          // 後備選取器：搜尋所有 Attachment 或 Detail 連結
          const anchors = Array.from(document.querySelectorAll('a[href*="/Report/Attachment"], a[href*="/Report/Detail"]'));
          return anchors.map(a => {
            const parent = a.closest('li, tr, div') || a.parentElement;
            const timeEl = parent?.querySelector('.report_time, .time, .date, span, p');
            return {
              rawDate: (timeEl as HTMLElement)?.innerText?.trim() || '',
              title: (a as HTMLElement)?.innerText?.trim() || '',
              href: (a as HTMLAnchorElement).href,
            };
          });
        });

        console.log(`📌 發現 ${rawItems.length} 篇報告`);

        if (rawItems.length === 0) {
          console.log(`ℹ️ [${this.name}] 本頁無報告資料，結束該分類爬取。`);
          break;
        }

        const pageItems: ReportItem[] = [];
        let sawItemWithinCutoff = false;
        let sawItemOlderThanCutoff = false;

        for (const row of rawItems) {
          try {
            if (!row.title || !row.href) continue;

            const dateStr = this.normalizeDate(row.rawDate);
            if (!dateStr) {
              console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${row.rawDate}")，跳過: ${row.title}`);
              totalSkippedInvalid++;
              continue;
            }

            // 1. 時間過濾
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${row.title}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            sawItemWithinCutoff = true;

            const fullUrl = row.href.startsWith('http') ? row.href : `${this.baseUrl}${row.href.startsWith('/') ? '' : '/'}${row.href}`;
            const itemKey = `${dateStr}_${row.title}`;

            // 2. 記憶體防重複
            if (processedUrls.has(fullUrl) || processedKeys.has(itemKey)) {
              continue;
            }
            processedUrls.add(fullUrl);
            processedKeys.add(itemKey);

            // 若連結直接為 Attachment 則直接做為 pdfUrl
            const isAttachment = fullUrl.includes('/Report/Attachment/');
            const reportItem: ReportItem = {
              title: row.title,
              date: dateStr,
              category: cat.folder,
              siteId: this.id,
              broker: this.name,
              pageUrl: fullUrl,
              pdfUrl: isAttachment ? fullUrl : undefined,
              canPrintPage: !isAttachment,
            };

            pageItems.push(reportItem);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 解析報告列出錯:`, err.message);
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

          try {
            const savedPath = await DownloadManager.saveReport(page, item);
            if (savedPath) {
              totalDownloaded++;
            }
            await page.waitForTimeout(800);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 下載報告失敗: ${item.title}`, err.message);
          }

          if (options?.maxCount && totalDownloaded >= options.maxCount) {
            console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
            return;
          }
        }

        // 時間截斷判斷
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前頁所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        // 尋找下一頁按鈕
        const nextBtn = page.locator('.pagesList .pageNext a, .pageNext a, a.pageNext, .pagination a[rel="next"], a:has-text("下一頁")').first();
        const hasNext = await nextBtn.isVisible().catch(() => false);
        if (hasNext) {
          console.log(`➡️ 切換至下一頁...`);
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
    console.log(`  - 超過時間範圍跳過: ${totalSkippedDate} 篇`);
    console.log(`  - 資料不完整跳過: ${totalSkippedInvalid} 篇`);
    console.log(`=====================================================`);
  }
}
