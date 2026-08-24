import { Page, BrowserContext } from 'playwright';

/**
 * 研究報告項目結構
 */
export interface ReportItem {
  title: string;           // 報告標題 (例如: 健策 (3653 TT)：出貨量優於預期)
  date: string;            // 發布日期 (格式化為 YYYYMMDD，例如: 20260820)
  category: string;        // 分類 (例如: EquityReport、產業、總經)
  pageUrl: string;         // 報告內頁或下載連結 URL
  canPrintPage?: boolean;
  siteId?: string;         // 券商/站點代號 ID (例如: yuanta, fubon)
  broker?: string;         // 券商名稱 (選填)
  pdfUrl?: string;         // 直接 PDF 連結 (若有)
  author?: string;         // 研究員/出處 (選填)
}

/**
 * 爬蟲執行選項
 */
export interface CrawlOptions {
  categories?: string[];   // 指定分類 (若無則抓取全部或預設分類)
  maxCount?: number;       // 最大下載篇數 (選填)
  startDate?: string;      // 起始日期 (YYYYMMDD，選填)
  months?: number;         // 抓取過去幾個月 (選填，預設 1 個月)
}

/**
 * 各網站爬蟲必須實作的標準介面
 */
export interface SiteCrawler {
  readonly id: string;           // 站點唯一代號 (例如: "yuanta", "fubon")
  readonly name: string;         // 站點中文名稱 (例如: "元大投顧")
  readonly baseUrl: string;      // 站點首頁網址

  /**
   * 登入站點 (若已有有效 Session 則直接返回 true)
   */
  login(page: Page, context: BrowserContext): Promise<boolean>;

  /**
   * 爬取報告清單並觸發下載
   */
  crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void>;
}
