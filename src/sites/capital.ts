import { Page, BrowserContext } from 'playwright';
import { BaseSiteCrawler } from './base';
import { CrawlOptions, ReportItem } from '../core/types';
import { DownloadManager } from '../core/downloader';
import { BrowserManager } from '../core/browser';
import { Config } from '../config';

export class CapitalCrawler extends BaseSiteCrawler {
  readonly id = 'capital';
  readonly name = '群益投顧';
  readonly baseUrl = 'https://www.capitalim.com.tw';

  /**
   * 群益投顧登入流程 (若有設定帳密則執行登入，若無則以公開模式執行)
   */
  async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`\n🔍 [${this.name}] 檢查登入狀態與帳密設定...`);

    const creds = Config.sites.capital;
    if (!creds || !creds.user || !creds.pass) {
      console.log(`ℹ️ [${this.name}] 未在 .env 設定 CAPITAL_USER / CAPITAL_PASS，將以公開模式進行資料爬取與報告下載。`);
      return true;
    }

    try {
      console.log(`🔐 [${this.name}] 開始執行帳號登入...`);
      await page.goto(`${this.baseUrl}/newsite/index(popup:login)`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);

      // 檢查是否已登入
      const isLogoutBtn = await page.locator('header .logout, .btn-logout, menu .logout').isVisible().catch(() => false);
      if (isLogoutBtn) {
        console.log(`✨ [${this.name}] 已經處於登入狀態，跳過登入！`);
        return true;
      }

      // 填寫身分證字號與電子戶密碼
      const idInput = page.locator('.dialog:visible input[name="id01"], input[formcontrolname="id"]').first();
      const pwInput = page.locator('.dialog:visible input[name="pw01"], input[formcontrolname="password"]').first();
      const submitBtn = page.locator('.dialog:visible input[value="登入"], input[type="button"][value="登入"]').first();

      if (await idInput.isVisible().catch(() => false)) {
        await idInput.click();
        await idInput.fill(creds.user);
        await pwInput.click();
        await pwInput.fill(creds.pass);
        await page.waitForTimeout(500);

        await submitBtn.click({ force: true });
        await page.waitForTimeout(3000);

        await this.saveSession(context);
        console.log(`🎉 [${this.name}] 登入請求已送出並儲存 Session！`);
      }
      return true;
    } catch (err: any) {
      console.warn(`⚠️ [${this.name}] 登入過程發生異常 (將繼續嘗試以公開模式抓取):`, err.message);
      return true;
    }
  }

  /**
   * 解析並標準化報告發布日期為 YYYYMMDD
   */
  private normalizeDate(rawDateStr: string): string | null {
    if (!rawDateStr) return null;
    const cleaned = rawDateStr.replace(/[\r\n\t]+/g, ' ').trim();
    if (!cleaned) return null;

    // 匹配 YYYY-MM-DD 或 YYYY/MM/DD 或 YYYY.MM.DD
    const ymdMatch = cleaned.match(/(\d{4})[./\s-]+(\d{1,2})[./\s-]+(\d{1,2})/);
    if (ymdMatch) {
      const year = ymdMatch[1];
      const month = ymdMatch[2].padStart(2, '0');
      const day = ymdMatch[3].padStart(2, '0');
      return `${year}${month}${day}`;
    }

    // 匹配純 8 位數字
    const digits = cleaned.replace(/[^\d]/g, '');
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }

    return null;
  }

  /**
   * 群益投顧報告爬取與下載流程
   */
  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    console.log(`\n📊 [${this.name}] 開始爬取研究報告列表...`);

    // 確保頁面載入以建立完整的 Session / Origin 環境
    await page.goto(`${this.baseUrl}/newsite/research-report/shares;page=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(2000);

    const categories = [
      { key: 'shares', name: '台股個股', aliases: ['個股', '個股篇', '個股報告', 'shares', 'EquityReport'] },
      { key: 'industry', name: '台股產業', aliases: ['產業', '產業篇', '產業報告', 'industry'] },
      { key: 'macroeconomics', name: '全球總經', aliases: ['總經', '總經篇', '全球總經', 'macro', 'macroeconomics'] },
      { key: 'USstocks', name: '海外股票', aliases: ['海外股票', '海外股票篇', '美股', '美股研究', 'USstocks'] },
      { key: 'emerging', name: '興櫃報告', aliases: ['興櫃', '興櫃篇', '興櫃報告', 'emerging'] },
      { key: 'revenueEstimation', name: '營收預估', aliases: ['營收預估', '營收', 'revenueEstimation'] },
    ];

    // 預設僅下載「台股個股」分類 (若 options 明確指定則依設定)
    const targetCategories = options?.categories?.length
      ? categories.filter(c =>
        options.categories!.includes(c.name) ||
        options.categories!.includes(c.key) ||
        c.aliases.some(a => options.categories!.includes(a))
      )
      : categories.filter(c => c.key === 'shares');

    if (targetCategories.length === 0) {
      throw new Error(
        `❌ [${this.name}] 找不到符合的分類「${options?.categories?.join('、')}」，` +
        `可用分類: ${categories.map(c => c.name).join('、')}`
      );
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

    const processedKeys = new Set<string>();
    let totalDownloaded = 0;
    let totalSkippedDate = 0;
    let totalSkippedExisting = 0;
    let totalSkippedInvalid = 0;

    for (const cat of targetCategories) {
      console.log(`\n📂 [${this.name}] 檢查分類: 【${cat.name} (${cat.key})】...`);

      let pageNum = 1;
      const pageSize = 20;
      const maxPages = 50;

      while (pageNum <= maxPages) {
        console.log(`\n📄 [${this.name}] 正在掃描【${cat.name}】第 ${pageNum} 頁...`);

        // 透過頁面內部執行 fetch 呼叫 CMS API，自動攜帶正確的 Origin 與 Cookie
        const apiResult = await page.evaluate(
          async ({ categoryKey, pageIndex, pageSizeLimit }) => {
            try {
              const url = `https://www.capitalim.com.tw/cmsapi/newcms/api/IAArticle/Category/Publish?category=${categoryKey}&Page=${pageIndex}&Take=${pageSizeLimit}`;
              const res = await fetch(url, {
                headers: { Accept: 'application/json, text/plain, */*' },
              });
              if (!res.ok) {
                return { success: false, status: res.status, error: res.statusText, data: [] };
              }
              const json = await res.json();
              return {
                success: true,
                status: res.status,
                data: json.data || [],
                totalCount: json.totalCount,
                totalPages: json.totalPages,
              };
            } catch (err: any) {
              return { success: false, error: err.message, data: [] };
            }
          },
          { categoryKey: cat.key, pageIndex: pageNum, pageSizeLimit: pageSize }
        );

        if (!apiResult.success || !apiResult.data || apiResult.data.length === 0) {
          if (pageNum === 1 && !apiResult.success) {
            console.error(`❌ [${this.name}] 取得【${cat.name}】列表失敗:`, apiResult.error || `HTTP ${apiResult.status}`);
          } else {
            console.log(`ℹ️ [${this.name}] 【${cat.name}】已無更多報告資料。`);
          }
          break;
        }

        const rawArticles = apiResult.data;
        console.log(`📌 發現 ${rawArticles.length} 篇報告`);

        let sawItemWithinCutoff = false;
        let sawItemOlderThanCutoff = false;

        for (const article of rawArticles) {
          try {
            const rawDate = article.publishDate || '';
            const dateStr = this.normalizeDate(rawDate);
            if (!dateStr) {
              console.warn(`⚠️ [${this.name}] 無法解析報告日期 (原始值: "${rawDate}")，跳過。`);
              totalSkippedInvalid++;
              continue;
            }

            // 標題組合: titleOfContent + summary (若有)
            const titleHead = (article.titleOfContent || '').trim();
            const summary = (article.summary || '').trim();
            let fullTitle = titleHead;
            if (summary && summary !== titleHead && !summary.startsWith('http')) {
              fullTitle = `${titleHead} ${summary}`.trim();
            }
            if (!fullTitle) {
              fullTitle = `群益投顧_${cat.name}_${article.id}`;
            }

            const itemKey = `${dateStr}_${fullTitle}`;

            // 1. 時間過濾 (早於基準日則跳過)
            if (dateStr < cutoffDateStr) {
              console.log(`⏩ [時間過濾] 跳過日期【${dateStr}】之報告 (早於基準日 ${cutoffDateStr}): ${fullTitle}`);
              sawItemOlderThanCutoff = true;
              totalSkippedDate++;
              continue;
            }

            sawItemWithinCutoff = true;

            // 2. 記憶體去重
            if (processedKeys.has(itemKey)) {
              continue;
            }
            processedKeys.add(itemKey);

            const reportCategory = (cat.key === 'shares' || cat.name.includes('個股')) ? 'EquityReport' : cat.name;
            const reportItem: ReportItem = {
              title: fullTitle,
              date: dateStr,
              category: reportCategory,
              siteId: this.id,
              broker: this.name,
              pageUrl: `${this.baseUrl}/newsite/research-report/${cat.key}/${article.id}`,
              author: article.researcherName || undefined,
            };

            // 3. 實體檔案防重複檢查 (若檔案已存在則直接跳過，不呼叫詳細資料 API)
            if (DownloadManager.isDownloaded(reportItem, this.id)) {
              const safeTitle = DownloadManager.sanitizeFilename(reportItem.title);
              console.log(`⏩ [已存在] 跳過: 【${reportItem.category}/${this.id}】${reportItem.date}_${safeTitle}.pdf`);
              totalSkippedExisting++;
              continue;
            }

            // 4. 取得報告詳細資料 (包含官方原版 PDF Base64 或 HTML 內文)
            const detail = await page.evaluate(async (articleId) => {
              try {
                const res = await fetch(`https://www.capitalim.com.tw/cmsapi/newcms/api/IAArticle/${articleId}`, {
                  headers: { Accept: 'application/json, text/plain, */*' },
                });
                if (!res.ok) return null;
                return await res.json();
              } catch (err) {
                return null;
              }
            }, article.id);

            if (!detail) {
              console.warn(`⚠️ [${this.name}] 無法取得報告內文 ID: ${article.id}`);
              continue;
            }

            // 5. 若有附帶官方原版 PDF (Base64)，直接原子寫入存檔
            if (detail.file) {
              const base64Data = detail.file.replace(/^data:application\/pdf;base64,/, '').replace(/^data:[^;]+;base64,/, '');
              const buffer = Buffer.from(base64Data, 'base64');
              const savedPath = DownloadManager.savePdfBuffer(buffer, reportItem, this.id);
              if (savedPath) {
                totalDownloaded++;
              }
            } else if (detail.content) {
              // 6. 若無原版 PDF 檔案，將完整研究報告 HTML 內容排版並列印轉為 PDF
              console.log(`📄 [內文轉 PDF] 正在轉換【${reportItem.title}】為 PDF...`);
              const renderHtml = `
                <!DOCTYPE html>
                <html lang="zh-TW">
                <head>
                  <meta charset="utf-8">
                  <title>${reportItem.title}</title>
                  <style>
                    @page { margin: 15mm; size: A4; }
                    body {
                      font-family: "Microsoft JhengHei", "PingFang TC", -apple-system, sans-serif;
                      margin: 0;
                      color: #2c3e50;
                      line-height: 1.6;
                      font-size: 13px;
                    }
                    .header {
                      border-bottom: 2.5px solid #b50033;
                      padding-bottom: 12px;
                      margin-bottom: 18px;
                    }
                    .broker-tag {
                      display: inline-block;
                      background-color: #b50033;
                      color: #ffffff;
                      font-size: 12px;
                      font-weight: bold;
                      padding: 2px 8px;
                      border-radius: 3px;
                      margin-bottom: 8px;
                    }
                    h1 {
                      font-size: 20px;
                      margin: 4px 0 8px 0;
                      color: #111111;
                      line-height: 1.3;
                    }
                    .meta-bar {
                      font-size: 12px;
                      color: #555555;
                      background-color: #f8f9fa;
                      padding: 6px 10px;
                      border-radius: 4px;
                    }
                    .meta-bar span {
                      margin-right: 18px;
                    }
                    .summary-box {
                      background-color: #fff9f9;
                      border-left: 4px solid #b50033;
                      padding: 10px 14px;
                      font-size: 13px;
                      font-weight: 600;
                      color: #333333;
                      margin: 14px 0;
                    }
                    .report-content {
                      font-size: 13px;
                      line-height: 1.8;
                    }
                    .report-content p {
                      margin: 6px 0;
                    }
                    .report-content table {
                      width: 100%;
                      border-collapse: collapse;
                      margin: 10px 0;
                    }
                    .report-content th, .report-content td {
                      border: 1px solid #dddddd;
                      padding: 6px 8px;
                      text-align: left;
                    }
                    .footer {
                      margin-top: 25px;
                      padding-top: 10px;
                      border-top: 1px solid #eeeeee;
                      font-size: 11px;
                      color: #888888;
                      text-align: right;
                    }
                  </style>
                </head>
                <body>
                  <div class="header">
                    <div class="broker-tag">群益投顧研究報告</div>
                    <h1>${detail.titleOfContent || reportItem.title}</h1>
                    <div class="meta-bar">
                      <span>📅 發布日期：${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}</span>
                      <span>👤 研究員：${detail.researcherName || '群益研究部'}</span>
                      ${detail.stockSymbol ? `<span>📈 個股代號：${detail.stockName || ''} (${detail.stockSymbol})</span>` : ''}
                      ${detail.industry ? `<span>🏷️ 產業類別：${detail.industry}</span>` : ''}
                      ${detail.price && detail.pricePublish ? `<span>🎯 目標價：${detail.price}</span>` : ''}
                    </div>
                  </div>
                  ${detail.summary ? `<div class="summary-box">${detail.summary}</div>` : ''}
                  <div class="report-content">
                    ${detail.content}
                  </div>
                  <div class="footer">
                    資料來源：群益投顧 (Capital Investment Management) | 本報告僅供參考
                  </div>
                </body>
                </html>
              `;

              const detailPage = await context.newPage();
              try {
                await detailPage.setContent(renderHtml, { waitUntil: 'load' });
                const filePath = DownloadManager.getReportFilePath(reportItem, this.id);
                const tmpPath = `${filePath}.part`;
                await BrowserManager.printPageToPdf(detailPage, detailPage.url(), tmpPath);
                const fs = await import('fs');
                fs.renameSync(tmpPath, filePath);
                console.log(`✅ [儲存成功] ${filePath}`);
                totalDownloaded++;
              } catch (err: any) {
                console.error(`❌ [${this.name}] 轉存 PDF 失敗: ${reportItem.title}`, err.message);
              } finally {
                await detailPage.close().catch(() => { });
              }
            }

            await page.waitForTimeout(300);

            // 達到上限篇數則提前結束
            if (options?.maxCount && totalDownloaded >= options.maxCount) {
              console.log(`🎯 已達到最大指定下載篇數 (${options.maxCount} 篇)，停止下載。`);
              return;
            }
          } catch (err: any) {
            console.error(`❌ [${this.name}] 處理報告資訊出錯:`, err.message);
          }
        }

        // 當前頁所有報告均早於基準日，結束後續分頁爬取
        if (sawItemOlderThanCutoff && !sawItemWithinCutoff) {
          console.log(`🏁 【${cat.name}】當前頁所有報告均早於 ${cutoffDateStr}，結束後續分頁爬取。`);
          break;
        }

        pageNum++;
      }
    }

    console.log(`\n=====================================================`);
    console.log(`📊 [${this.name}] 爬取總結:`);
    console.log(`  - 成功下載: ${totalDownloaded} 篇`);
    console.log(`  - 已存在跳過: ${totalSkippedExisting} 篇`);
    console.log(`  - 超過指定期限跳過: ${totalSkippedDate} 篇`);
    console.log(`  - 資料不完整跳過: ${totalSkippedInvalid} 篇`);
    console.log(`=====================================================`);
  }
}
