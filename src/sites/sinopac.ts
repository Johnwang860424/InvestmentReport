import { Page, BrowserContext } from 'playwright';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { DownloadManager } from '../core/downloader';
import { Config } from '../config';

export class SinopacCrawler extends BaseSiteCrawler {
  readonly id = 'sinopac';
  readonly name = '永豐投顧';
  readonly baseUrl = 'https://scm.sinotrade.com.tw';

  /**
   * 永豐投顧登入流程
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態...`);
    await page.goto(`${this.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    // 檢查是否已具備登入態
    const isAlreadyLoggedIn = await page.evaluate(() => {
      return document.body.innerText.includes('登出') ||
        !!document.querySelector('a[onclick*="Logout"], .logout-btn');
    });

    if (isAlreadyLoggedIn) {
      console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
      return true;
    }

    console.log(`🔐 [${this.name}] 尚未登入，開始自動登入...`);
    const creds = this.getCredentials();

    try {
      // 點擊右上角登入按鈕開啟燈箱
      const loginBtn = page.locator('.longin-btn, a:has-text("登入")').first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click();
        await page.waitForTimeout(1000);
      }

      // 等待帳密輸入框出現
      await page.waitForSelector('#member_id', { state: 'visible', timeout: 10000 });
      await page.fill('#member_id', creds.user);
      await page.fill('#member_password', creds.pass);

      // 提交登入並等待頁面重載或導航
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => { }),
        page.click('#do_login'),
      ]);

      await page.waitForTimeout(2000);

      // 驗證登入成功
      const loggedIn = await page.evaluate(() => {
        return document.body.innerText.includes('登出') ||
          !!document.querySelector('a[onclick*="Logout"], .logout-btn');
      });

      if (loggedIn) {
        console.log(`🎉 [${this.name}] 登入成功！`);
        await this.saveSession(context);
        return true;
      } else {
        // 抓取可能之錯誤訊息
        const errMsg = await page.evaluate(() => {
          return document.querySelector('#msgBox-cover .sys-info-message, #alert-window .sys-message-txt')?.textContent?.trim() || '';
        });
        throw new Error(`❌ [${this.name}] 登入失敗: ${errMsg || '請檢查帳號密碼是否正確'}`);
      }
    } catch (err: any) {
      console.error(`❌ [${this.name}] 登入過程發生錯誤:`, err.message);
      throw err;
    }
  }

  /**
   * 解析並標準化報告發布日期為 YYYYMMDD
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
   * 永豐投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);
    await page.goto(`${this.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // 永豐投顧分類項目定義 (包含 ServiceGUID 與儲存資料夾)
    const categories = [
      {
        guid: '2b545beb-df74-44eb-bf14-3248fe311cdd',
        name: '個股脈動',
        folder: 'EquityReport',
        aliases: ['個股', '個股報告', '個股脈動', '台股個股', 'equity', 'EquityReport'],
      },
      {
        guid: 'c672c640-097c-49b1-8e63-f92ee35aacf2',
        name: '每日精選個股',
        folder: 'EquityReport',
        aliases: ['每日精選', '法人方向盤', '每日精選個股'],
      },
      {
        guid: 'fa909470-7ea2-470b-ae49-e05ffab50b7b',
        name: '個股點評',
        folder: 'EquityReport',
        aliases: ['美股個股', '個股點評'],
      },
      {
        guid: 'a5e8a16f-942a-42b4-9ee5-48f296773462',
        name: '盤前必讀',
        folder: '晨訊',
        aliases: ['盤前', '盤前必讀', '晨訊'],
      },
      {
        guid: '809e24f7-6e2c-4b89-94ac-89b547b2c9ed',
        name: '每週精選',
        folder: '週報',
        aliases: ['每週精選', '週報'],
      },
      {
        guid: '5c257ae2-eb6c-4817-a007-9b0dd190a06a',
        name: '產業風雲',
        folder: '產業報告',
        aliases: ['產業', '產業風雲', '產業報告'],
      },
      {
        guid: '8dd54de5-3b5e-423d-8909-176c84e84c7d',
        name: '前瞻策略',
        folder: '總經策略',
        aliases: ['策略', '前瞻策略', '總經策略', '總經'],
      },
      {
        guid: 'ead5a394-cd0b-4972-859f-556620ecdbd9',
        name: '市場觀察家',
        folder: '深度觀點',
        aliases: ['市場觀察家', '深度觀點'],
      },
      {
        guid: '888bf10b-8230-4256-9b4e-e3ea6d1437c6',
        name: '選股週報',
        folder: '選股週報',
        aliases: ['選股週報', '白金選股'],
      },
    ];

    // 預設下載「個股脈動」(個股研究報告，若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.guid) ||
        c.aliases.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.name === '個股脈動');

    if (targetCategories.length === 0) {
      throw new Error(
        `❌ [${this.name}] 找不到符合的分類「${options?.categories?.join('、')}」，` +
        `可用分類: ${categories.map(c => c.name).join('、')}`
      );
    }

    // 取得頁面中的 RequestVerificationToken
    const token = await page.evaluate(() => {
      return (document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement)?.value || '';
    });

    if (!token) {
      throw new Error(`❌ [${this.name}] 無法取得 RequestVerificationToken！`);
    }

    // 計算時間過濾基準日 (YYYYMMDD)
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
    const processedGuids = new Set<string>();
    const processedKeys = new Set<string>();

    let totalDownloaded = 0;
    let totalSkippedDate = 0;
    let totalSkippedExisting = 0;
    let totalSkippedInvalid = 0;

    for (const cat of targetCategories) {
      console.log(`\n📂 [${this.name}] 檢查分類: 【${cat.name}】...`);

      let sdate = '';
      let pageNum = 1;
      const maxPages = 20;

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在讀取【${cat.name}】第 ${pageNum} 批報告清單 (基準日期參數: "${sdate || '最新'}")...`);

        // 呼叫 API 取得文章列表
        const apiResponse = await page.evaluate(
          async ({ tok, serviceGuid, dateParam }) => {
            const res = await fetch('/Article/GetSubscribeList', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
              },
              body: `__RequestVerificationToken=${encodeURIComponent(tok)}&ServiceGUID=${encodeURIComponent(serviceGuid)}&sdate=${encodeURIComponent(dateParam)}`,
            });
            return await res.json();
          },
          { tok: token, serviceGuid: cat.guid, dateParam: sdate }
        );

        if (apiResponse.Status !== 'Y' || !Array.isArray(apiResponse.data) || apiResponse.data.length === 0) {
          console.log(`ℹ️ [${this.name}] 【${cat.name}】已無更多報告資料。`);
          break;
        }

        const items = apiResponse.data;
        console.log(`📌 取得 ${items.length} 篇報告`);

        const pageItems: ReportItem[] = [];
        let sawItemWithinCutoff = false;
        let sawItemOlderThanCutoff = false;

        for (const item of items) {
          try {
            const rawTitle = item.Title || '';
            const rawDate = item.StartTime || item.PostTime || '';
            const dateStr = this.normalizeDate(rawDate);

            if (!rawTitle || !dateStr) {
              console.warn(`⚠️ [${this.name}] 報告資訊不完整 (標題: "${rawTitle}", 日期: "${rawDate}")，跳過。`);
              totalSkippedInvalid++;
              continue;
            }

            // 1. 時間過濾
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${rawTitle}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            sawItemWithinCutoff = true;

            const guid = item.GUID || '';
            const itemKey = `${dateStr}_${rawTitle}`;

            // 2. 記憶體防重複
            if ((guid && processedGuids.has(guid)) || processedKeys.has(itemKey)) {
              continue;
            }
            if (guid) processedGuids.add(guid);
            processedKeys.add(itemKey);

            const directPdfUrl = guid ? `${this.baseUrl}/Article/GetFile/${guid}` : undefined;
            const innerPageUrl = guid ? `${this.baseUrl}/Article/Inner/${guid}` : this.baseUrl;

            const reportItem: ReportItem = {
              title: rawTitle,
              date: dateStr,
              category: cat.folder,
              siteId: this.id,
              broker: this.name,
              pageUrl: innerPageUrl,
              pdfUrl: directPdfUrl,
              canPrintPage: Boolean(guid),
              author: item.ServiceName || this.name,
            };

            pageItems.push(reportItem);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 解析報告資訊出錯:`, err.message);
          }
        }

        // 逐一下載本批符合條件的報告
        for (const reportItem of pageItems) {
          // 3. 實體檔案防重複檢查
          if (DownloadManager.isDownloaded(reportItem)) {
            const safeTitle = DownloadManager.sanitizeFilename(reportItem.title);
            console.log(`⏩ [已存在] 跳過: 【${reportItem.category}/${reportItem.siteId}】${reportItem.date}_${safeTitle}.pdf`);
            totalSkippedExisting++;
            continue;
          }

          try {
            const savedPath = await DownloadManager.saveReport(page, reportItem);
            if (savedPath) {
              totalDownloaded++;
            }
            await page.waitForTimeout(500);
          } catch (err: any) {
            console.error(`❌ [${this.name}] 下載報告失敗: ${reportItem.title}`, err.message);
          }

          if (options?.maxCount && totalDownloaded >= options.maxCount) {
            console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
            return;
          }
        }

        // 當前批次均早於基準日，結束分頁
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前批次所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        // 取得最後一筆項目的日期作為下一頁 sdate 參數
        const lastItem = items[items.length - 1];
        const nextSDate = (lastItem.StartTime || lastItem.PostTime || '').replace(/\./g, '');
        if (!nextSDate || nextSDate === sdate) {
          break;
        }
        sdate = nextSDate;
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
