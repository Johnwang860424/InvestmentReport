import { Page, BrowserContext } from 'playwright';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { DownloadManager } from '../core/downloader';
import { Config } from '../config';

export class CathayCrawler extends BaseSiteCrawler {
  readonly id = 'cathay';
  readonly name = '國泰投顧';
  readonly baseUrl = 'https://www.cathayfut.com.tw';

  /**
   * 國泰投顧 / 國泰證期登入檢查
   * 若有設定帳密則支援登入流程，未設定時亦可直接存取公開研究報告專區
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入與存取權限...`);

    const creds = Config.sites.cathay;
    if (creds && creds.user && creds.pass) {
      console.log(`🔑 [${this.name}] 檢測到已設定帳號，準備驗證登入態...`);
      // 可在此處執行會員登入
    } else {
      console.log(`ℹ️ [${this.name}] 使用公開研究報告專區模式執行 (免登入即可下載個股研究報告)`);
    }

    return true;
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
   * 國泰投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);

    const categories = [
      {
        type: 'stock',
        name: '個股報告',
        folder: 'EquityReport',
        aliases: ['個股', '個股報告'],
      },
      {
        type: 'popularStocks',
        name: '熱門個股週報',
        folder: 'EquityReport',
        aliases: ['熱門個股', '個股週報', '熱門個股週報'],
      },
      {
        type: 'tw',
        name: '台股晨訊',
        folder: '晨訊',
        aliases: ['晨訊', '台股晨訊', '晨報'],
      },
      {
        type: 'equity',
        name: '熱門股票期貨日報',
        folder: '期貨報告',
        aliases: ['熱門股期', '股票期貨', '熱門股票期貨日報'],
      },
      {
        type: 'daily',
        name: '台指期盤後日報',
        folder: '期貨報告',
        aliases: ['台指期', '期貨日報', '台指期盤後日報'],
      },
      {
        type: 'cftc',
        name: 'CFTC大額籌碼報告',
        folder: '籌碼報告',
        aliases: ['CFTC', '大額籌碼', 'CFTC大額籌碼報告'],
      },
      {
        type: 'overseas',
        name: '國外期貨週報',
        folder: '海外期貨',
        aliases: ['國外期貨', '外期週報', '國外期貨週報'],
      },
      {
        type: 'us',
        name: '國外期貨日報',
        folder: '海外期貨',
        aliases: ['外期日報', '國外期貨日報'],
      },
    ];

    // 預設下載「個股報告」與「熱門個股週報」(若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.type) ||
        c.aliases?.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.type === 'stock' || c.type === 'popularStocks');

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
      console.log(`\n📂 [${this.name}] 正在讀取分類: 【${cat.name}】...`);

      const listUrl = `${this.baseUrl}/include/research_report_general.aspx?reportType=${cat.type}&_t=${Date.now()}`;
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);

      // 取得表格所有行
      const rawRows = await page.evaluate(() => {
        const trs = Array.from(document.querySelectorAll('table tr'));
        // 略過表頭行
        return trs.slice(1).map(tr => {
          const tds = Array.from(tr.querySelectorAll('td'));
          const a = tr.querySelector('a');
          return {
            title: tds[0]?.innerText.trim() || '',
            rawDate: tds[1]?.innerText.trim() || '',
            fid: a?.id || '',
            href: a?.getAttribute('href') || '',
            cls: a?.className || '',
          };
        });
      });

      console.log(`📌 發現 ${rawRows.length} 篇報告`);

      const pageItems: ReportItem[] = [];

      for (const row of rawRows) {
        try {
          if (!row.title) continue;

          const dateStr = this.normalizeDate(row.rawDate);
          if (!dateStr) {
            console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${row.rawDate}")，跳過此列。`);
            totalSkippedInvalid++;
            continue;
          }

          // 1. 時間過濾
          if (dateStr < cutoffDateStr) {
            console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${row.title}`);
            totalSkippedDate++;
            continue;
          }

          // 解析 PDF 下載網址
          let pdfUrl: string | undefined;
          if (row.fid) {
            pdfUrl = `${this.baseUrl}/include/ShowPDF.ashx?fid=${encodeURIComponent(row.fid)}`;
          } else if (row.href && row.href.includes('.pdf')) {
            pdfUrl = row.href.startsWith('http') ? row.href : `${this.baseUrl}/${row.href}`;
          }

          if (!pdfUrl) {
            console.warn(`⚠️ [${this.name}] 找不到報告下載識別碼 (FID)，跳過: ${row.title}`);
            totalSkippedInvalid++;
            continue;
          }

          const itemKey = `${dateStr}_${row.title}`;

          // 2. 記憶體防重複
          if (processedUrls.has(pdfUrl) || processedKeys.has(itemKey)) {
            continue;
          }
          processedUrls.add(pdfUrl);
          processedKeys.add(itemKey);

          const reportItem: ReportItem = {
            title: row.title,
            date: dateStr,
            category: cat.folder,
            siteId: this.id,
            broker: this.name,
            pageUrl: listUrl,
            pdfUrl,
          };

          pageItems.push(reportItem);
        } catch (err: any) {
          console.error(`❌ [${this.name}] 解析報告列出錯:`, err.message);
        }
      }

      // 逐一下載本分類符合條件的報告
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
          await page.waitForTimeout(500);
        } catch (err: any) {
          console.error(`❌ [${this.name}] 下載報告失敗: ${item.title}`, err.message);
        }

        // 達到最大指定篇數則提早返回
        if (options?.maxCount && totalDownloaded >= options.maxCount) {
          console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
          return;
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
