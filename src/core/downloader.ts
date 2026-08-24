import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config';
import { BrowserManager } from './browser';
import { ReportItem } from './types';

export class DownloadManager {
  /**
   * 清理檔案名稱中的非法字元與多餘空白
   */
  public static sanitizeFilename(name: string): string {
    return name
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 分類名稱與目錄名稱對應
   */
  public static getCategoryFolder(category: string): string {
    const mapping: Record<string, string> = {
      '個股': 'EquityReport',
      '個股報告': 'EquityReport',
      'equity': 'EquityReport',
      'EquityReport': 'EquityReport',
    };
    return mapping[category] || category;
  }

  /**
   * 確保目標子資料夾存在 (支援分類與券商/站點 ID 子目錄)
   */
  public static ensureDir(subDir: string, siteId?: string): string {
    const folderName = this.getCategoryFolder(subDir);
    const fullPath = siteId
      ? path.join(Config.downloadDir, folderName, this.sanitizeFilename(siteId.toLowerCase()))
      : path.join(Config.downloadDir, folderName);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    return fullPath;
  }

  /**
   * 取得報告預計儲存的完整檔案路徑
   */
  public static getReportFilePath(item: ReportItem, siteId?: string): string {
    const targetSiteId = item.siteId || siteId || item.broker;
    const targetDir = this.ensureDir(item.category, targetSiteId);
    const safeTitle = this.sanitizeFilename(item.title);
    const fileName = `${item.date}_${safeTitle}.pdf`;
    return path.join(targetDir, fileName);
  }

  /**
   * 檢查報告檔案是否已存在於本機
   */
  public static isDownloaded(item: ReportItem, siteId?: string): boolean {
    const filePath = this.getReportFilePath(item, siteId);
    return fs.existsSync(filePath);
  }

  /**
   * 檢查 buffer 是否為合法 PDF (檔頭必須為 %PDF)
   */
  private static isPdfBuffer(buffer: Buffer): boolean {
    return buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF';
  }

  /**
   * 下載 PDF 並驗證 HTTP 狀態與內容。
   * Session 過期時網站常以 HTTP 200 回傳登入頁；若不檢查就寫檔，
   * 之後每次執行的防重複檢查都會看到這個假檔案而永久跳過該篇報告，
   * 因此這裡驗證失敗一律擲出錯誤，絕不寫入。
   */
  private static async fetchPdf(page: Page, url: string): Promise<Buffer> {
    const response = await page.request.get(url);
    if (!response.ok()) {
      throw new Error(`下載回應狀態異常 (HTTP ${response.status()} ${response.statusText()}): ${url}`);
    }

    const buffer = await response.body();
    if (!this.isPdfBuffer(buffer)) {
      // 支援 PDF.js 內嵌 Base64 格式 (例如凱基投顧等券商系統)
      const text = buffer.toString('utf8');
      const base64Match = text.match(/convertDataURIToBinary\(['"]([^'"]+)['"]\)/) ||
                          text.match(/data:application\/pdf;base64,([A-Za-z0-9+/=]+)/);
      if (base64Match && base64Match[1]) {
        const cleanBase64 = base64Match[1].replace(/data:application\/pdf;base64,/i, '').trim();
        const extractedBuffer = Buffer.from(cleanBase64, 'base64');
        if (this.isPdfBuffer(extractedBuffer)) {
          return extractedBuffer;
        }
      }

      const contentType = response.headers()['content-type'] || '未知';
      throw new Error(
        `回應內容不是 PDF (content-type: ${contentType}，大小: ${buffer.length} bytes)，` +
        `可能是登入頁或錯誤頁，請確認 Session 是否已過期: ${url}`
      );
    }
    return buffer;
  }

  /**
   * 先寫入暫存檔再改名，避免中途失敗留下半截檔案而影響防重複檢查
   */
  private static writeAtomic(filePath: string, buffer: Buffer): void {
    const tmpPath = `${filePath}.part`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * 直接將 PDF Buffer 寫入目標路徑 (支援原子寫入與防重複)
   */
  public static savePdfBuffer(buffer: Buffer, item: ReportItem, siteId?: string): string | null {
    const filePath = this.getReportFilePath(item, siteId);
    const fileName = path.basename(filePath);
    const targetSiteId = item.siteId || siteId || item.broker || '';
    const label = targetSiteId ? `【${item.category}/${targetSiteId}】` : `【${item.category}】`;

    if (fs.existsSync(filePath)) {
      console.log(`⏩ [已存在] 跳過: ${label}${fileName}`);
      return filePath;
    }

    if (!this.isPdfBuffer(buffer)) {
      throw new Error(`內容不是有效的 PDF 格式 (大小: ${buffer.length} bytes): ${item.title}`);
    }

    console.log(`📥 [儲存中] ${label}${item.title}`);
    this.writeAtomic(filePath, buffer);
    console.log(`✅ [儲存成功] ${filePath}`);
    return filePath;
  }

  /**
   * 下載或儲存單篇研究報告
   * @param page Playwright Page
   * @param item 報告基本資訊
   * @param siteId 來源網站/券商 ID (選填，若需做站點隔離資料夾)
   */
  public static async saveReport(page: Page, item: ReportItem, siteId?: string): Promise<string | null> {
    const filePath = this.getReportFilePath(item, siteId);
    const fileName = path.basename(filePath);
    const targetSiteId = item.siteId || siteId || item.broker || '';
    const label = targetSiteId ? `【${item.category}/${targetSiteId}】` : `【${item.category}】`;

    // 1. 防重複檢查
    if (fs.existsSync(filePath)) {
      console.log(`⏩ [已存在] 跳過: ${label}${fileName}`);
      return filePath;
    }

    console.log(`📥 [下載中] ${label}${item.title}`);

    try {
      // 2. 若直接提供 PDF URL，支援 base64 或 HTTP 下載
      if (item.pdfUrl) {
        try {
          let buffer: Buffer;
          if (item.pdfUrl.startsWith('data:') || item.pdfUrl.startsWith('base64:')) {
            const base64Str = item.pdfUrl.replace(/^data:[^;]+;base64,/, '').replace(/^base64:/, '');
            buffer = Buffer.from(base64Str, 'base64');
            if (!this.isPdfBuffer(buffer)) {
              throw new Error(`Base64 內容不是有效的 PDF 檔案: ${item.title}`);
            }
          } else {
            buffer = await this.fetchPdf(page, item.pdfUrl);
          }
          this.writeAtomic(filePath, buffer);
          console.log(`✅ [儲存成功] ${filePath}`);
          return filePath;
        } catch (pdfErr: any) {
          if (item.canPrintPage) {
            console.warn(`⚠️ [${item.title}] 直接下載 PDF 失敗 (${pdfErr.message})，改由內頁渲染儲存...`);
          } else {
            throw pdfErr;
          }
        }
      }

      // 3. 若提供內頁網址，導訪並搜尋 PDF 下載點
      if (item.canPrintPage) {
        await page.goto(item.pageUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // 搜尋 a[href*=".pdf"]
        let resolvedPdfUrl: string | null = null;
        const pdfLinks = await page.locator('a[href*=".pdf"], a[download], .btn-download, a:has-text("下載")').all();
        for (const link of pdfLinks) {
          const href = await link.getAttribute('href');
          if (href && (href.includes('.pdf') || href.includes('download') || href.includes('file'))) {
            resolvedPdfUrl = href.startsWith('http') ? href : new URL(href, page.url()).toString();
            break;
          }
        }

        // 搜尋 embed/iframe (先確認元素存在，避免在沒有的頁面上空等 30 秒預設 timeout)
        if (!resolvedPdfUrl) {
          const embed = page.locator('embed[src*=".pdf"], iframe[src*=".pdf"]').first();
          const embedSrc = (await embed.count().catch(() => 0)) > 0
            ? await embed.getAttribute('src', { timeout: 2000 }).catch(() => null)
            : null;
          if (embedSrc) {
            resolvedPdfUrl = embedSrc.startsWith('http') ? embedSrc : new URL(embedSrc, page.url()).toString();
          }
        }

        if (resolvedPdfUrl) {
          const buffer = await this.fetchPdf(page, resolvedPdfUrl);
          this.writeAtomic(filePath, buffer);
          console.log(`✅ [儲存成功] ${filePath}`);
          return filePath;
        }

        // 4. 若無直接 PDF 連結，透過列印轉 PDF 儲存完整內頁
        //    (page.pdf() 僅支援 headless，headed 模式由 BrowserManager 轉交 headless 實例處理)
        console.warn(`⚠️ 未找到直接 PDF 連結，轉換網頁內容為 PDF: ${fileName}`);
        const tmpPath = `${filePath}.part`;
        try {
          await BrowserManager.printPageToPdf(page, page.url(), tmpPath);
          fs.renameSync(tmpPath, filePath);
        } catch (err) {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          throw err;
        }
        console.log(`📄 [列印儲存] ${filePath}`);
        return filePath;
      }

      if (item.pageUrl) {
        console.warn(`⚠️ 未驗證為報告內頁，略過網頁列印 fallback: ${item.pageUrl}`);
      }
      return null;
    } catch (err: any) {
      console.error(`❌ [下載失敗] ${item.title}:`, err.message);
      return null;
    }
  }
}
