import { parseArgs } from 'util';
import { BrowserContext, Page } from 'playwright';
import { BrowserManager } from './core/browser';
import { CrawlOptions, SiteCrawler } from './core/types';
import { Config } from './config';
import { SITES_REGISTRY, getAllCrawlers, getCrawler } from './sites';
import { KgiSessionRefreshRequiredError, refreshKgiSession } from './sites/kgi';

/** 顯示命令列使用說明。 */
function printHelp(): void {
  console.log(`
投資報告爬蟲

使用方式：
  npm start
  npm start -- --site <站點代號>
  npm start -- --list

參數：
  --site, -s         只執行指定站點
  --category, -c     篩選報告類別
  --months, -m       下載最近 N 個月的報告
  --start-date       下載 YYYYMMDD 之後的報告
  --list, -l         顯示支援站點
  --help, -h         顯示本說明

支援站點：
${Object.keys(SITES_REGISTRY).map(id => `  - ${id}: ${getCrawler(id)?.name}`).join('\n')}
`);
}

/** 關閉本次站點任務建立的頁面與 Context。 */
async function closeTaskContext(page: Page | null, context: BrowserContext | null): Promise<void> {
  if (page) await page.close().catch(() => { });
  if (context) await context.close().catch(() => { });
}

/**
 * 執行單一站點；KGI 的登入狀態失效時，啟動人工驗證流程後自動重試一次。
 */
async function runCrawlerTask(crawler: SiteCrawler, crawlOptions: CrawlOptions): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      console.log(`\n=====================================================`);
      console.log(`開始執行站點任務：${crawler.name} (${crawler.id})`);
      console.log(`=====================================================`);

      context = await BrowserManager.createContextForSite(crawler.id);
      page = await context.newPage();
      await crawler.login(page, context);
      await crawler.crawlAndDownload(page, context, crawlOptions);
      console.log(`\n${crawler.name} 執行完成。`);
      return true;
    } catch (error: any) {
      const shouldRefreshKgiSession = error instanceof KgiSessionRefreshRequiredError && crawler.id === 'kgi' && attempt === 0;

      if (!shouldRefreshKgiSession) {
        console.error(`\n${crawler.name} 執行失敗：`, error.message);
        return false;
      }

      await closeTaskContext(page, context);
      page = null;
      context = null;

      console.log('\nKGI 登入狀態已失效，正在開啟人工更新流程…');
      try {
        await refreshKgiSession(async (authenticatedPage, authenticatedContext) => {
          console.log('凱基登入成功，將在相同瀏覽器環境下載報告。');
          await crawler.crawlAndDownload(authenticatedPage, authenticatedContext, crawlOptions);
        });
        console.log(`\n${crawler.name} 完成。`);
        return true;
      } catch (refreshError: any) {
        console.error('\n凱基登入或報告下載失敗：', refreshError.message);
        return false;
      }
    } finally {
      await closeTaskContext(page, context);
    }
  }

  return false;
}

async function main(): Promise<void> {
  const options = {
    site: { type: 'string' as const, short: 's' },
    category: { type: 'string' as const, short: 'c' },
    months: { type: 'string' as const, short: 'm' },
    'start-date': { type: 'string' as const },
    list: { type: 'boolean' as const, short: 'l' },
    help: { type: 'boolean' as const, short: 'h' },
  };
  const { values } = parseArgs({ options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.list) {
    for (const [id, factory] of Object.entries(SITES_REGISTRY)) {
      const crawler = factory();
      console.log(`${id}: ${crawler.name} (${crawler.baseUrl})`);
    }
    return;
  }

  let months: number | undefined;
  if (values.months !== undefined) {
    months = Number(values.months);
    if (!Number.isInteger(months) || months <= 0) {
      throw new Error(`--months 必須為正整數：${values.months}`);
    }
  }

  const startDate = values['start-date'];
  if (startDate !== undefined && !/^\d{8}$/.test(startDate)) {
    throw new Error(`--start-date 必須為 YYYYMMDD 格式：${startDate}`);
  }

  const crawlers = (values.site ? [getCrawler(values.site)] : getAllCrawlers())
    .filter((crawler): crawler is SiteCrawler => crawler !== null);
  if (crawlers.length === 0) {
    throw new Error(`找不到站點：${values.site ?? '(未指定)'}`);
  }

  console.log(`下載目錄：${Config.downloadDir}`);
  console.log(`瀏覽器模式：${Config.headless ? '無頭模式' : '顯示視窗模式'}`);

  const crawlOptions: CrawlOptions = {
    categories: values.category ? [values.category] : undefined,
    months,
    startDate,
  };

  try {
    const results = await Promise.all(crawlers.map(crawler => runCrawlerTask(crawler, crawlOptions)));
    if (results.some(result => !result)) {
      process.exitCode = 1;
      console.error('一個或多個站點任務執行失敗。');
    } else {
      console.log('所有站點任務已完成。');
    }
  } finally {
    await BrowserManager.close();
  }
}

main().catch(error => {
  console.error('爬蟲執行失敗：', error.message);
  process.exit(1);
});
