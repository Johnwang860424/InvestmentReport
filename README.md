# 全球/台灣券商投資研究報告自動下載器 (Multi-Site Framework)

本專案是一套基於 **TypeScript + Playwright** 與 **Antigravity CLI (`agy`) AI 視覺辨識** 的多站點投資報告爬蟲框架。

---

## 🌟 架構特色

1. **策略模式 (Plugin/Adapter 架構)**：
   * 通用功能（AI 驗證碼辨識、瀏覽器 Context、PDF 下載去重、Session 管理）抽離至 `src/core/`。
   * 每個網站皆為獨立的模組（位於 `src/sites/`），新增網站極為簡便，互不干擾。
2. **AI 視覺辨識驗證碼 (`agy` CLI 整合)**：
   * 遇到圖形驗證碼時，自動截圖並呼叫 `agy` CLI 進行高精度文字辨識，支援失敗重試。
3. **Session / Cookie 隔離儲存**：
   * 各站點的登入狀態獨立保存在 `auth/<siteId>.json`，下次執行自動跳過登入與驗證碼。
4. **統一 CLI 控制台**：
   * 支援一鍵執行所有站點、指定單一站點或指定特定分類下載。

---

## 📂 專案目錄結構

```
┌── src/
│   ├── core/                  # 🛠️ 共通核心模組
│   │   ├── types.ts           # 共通介面與型別定義
│   │   ├── browser.ts         # 瀏覽器與 Session 管理
│   │   ├── captcha.ts         # agy CLI AI 視覺辨識服務
│   │   └── downloader.ts      # PDF 下載、去重與歸檔
│   ├── sites/                 # 🌐 各網站爬蟲實作
│   │   ├── base.ts            # 基礎抽象類別 BaseSiteCrawler
│   │   ├── capital.ts         # 群益投顧實作
│   │   ├── cathay.ts          # 國泰投顧實作
│   │   ├── esun.ts            # 玉山投顧實作
│   │   ├── fubon.ts           # 富邦投顧實作
│   │   ├── kgi.ts             # 凱基投顧實作
│   │   ├── sinopac.ts         # 永豐投顧實作
│   │   ├── yuanta.ts          # 元大投顧實作
│   │   └── index.ts           # 站點註冊清單 (Registry)
│   ├── config.ts              # 環境變數與設定集中管理
│   └── index.ts               # 🚀 統一 CLI 入口
├── auth/                      # 🔐 各站點 Session 儲存目錄 (自動生成)
├── EquityReport/              # 📥 下載之個股研究報告 PDF
│   ├── capital/               # 🏢 群益投顧專屬子目錄
│   ├── cathay/                # 🏢 國泰投顧專屬子目錄
│   ├── esun/                  # 🏢 玉山投顧專屬子目錄
│   ├── fubon/                 # 🏢 富邦投顧專屬子目錄
│   ├── kgi/                   # 🏢 凱基投顧專屬子目錄
│   ├── sinopac/               # 🏢 永豐投顧專屬子目錄
│   └── yuanta/                # 🏢 元大投顧專屬子目錄
├── .env.example               # 環境變數範本
├── .env                       # 帳密設定檔 (自行建立)
├── package.json
└── tsconfig.json
```

---

## 🚀 快速開始

### 1. 設定帳號密碼
在根目錄建立 `.env` 檔案：

```env
# 全域設定
DOWNLOAD_DIR=
HEADLESS=false

# 永豐投顧 (Sinopac)
SINOPAC_USER=你的身分證字號或統一編號
SINOPAC_PASS=你的投顧密碼

# 元大投顧 (Yuanta)
YUANTA_USER=你的身分證字號或統一編號
YUANTA_PASS=你的投顧密碼

# 凱基投顧 (KGI)
KGI_USER=你的身分證字號或Email
KGI_PASS=你的投顧密碼

# 國泰投顧 (Cathay - 國泰證期顧問，留空時以公開專區模式執行)
CATHAY_USER=
CATHAY_PASS=

# 群益投顧 (Capital - 留空時以公開專區模式直接抓取)
CAPITAL_USER=
CAPITAL_PASS=

# 富邦投顧 (Fubon)
FUBON_USER=你的身分證字號
FUBON_PASS=你的會員密碼

# 玉山投顧 (Esun)
ESUN_USER=你的身分證字號或帳號
ESUN_PASS=你的投顧密碼
ESUN_BRANCH=8840 (選填，預設8840經紀本部)
```

### 2. 常用指令

#### 📌 基本語法
```powershell
npm start [-- 參數選項]
npx tsx src/index.ts [參數選項]
```

#### ⚙️ 參數選項說明
| 參數 | 縮寫 | 說明 | 範例 |
| :--- | :--- | :--- | :--- |
| `--site` | `-s` | 指定要執行的站點 ID (留空則執行所有站點) | `--site esun` |
| `--months` | `-m` | 指定抓取過去幾個月內的報告 (預設 `1` 個月) | `--months 2` |
| `--start-date` | | 指定報告起始日期 (`YYYYMMDD` 格式) | `--start-date 20260801` |
| `--category` | `-c` | 指定報告分類 (如：個股、產業、總經) | `--category 個股` |
| `--list` | `-l` | 列出所有目前支援的券商站點清單 | `--list` |
| `--help` | `-h` | 顯示完整指令說明 | `--help` |

#### 🎯 常見使用範例

```powershell
# 1. 執行所有已支援的券商 (預設抓取「個股」分類且過濾過去 1 個月報告)
npm start

# 2. 僅執行指定券商 (以玉山投顧為例)
npm start -- --site esun

# 3. 指定抓取特定時間範圍 (過去 2 個月，或指定特定起始日)
npm start -- --site esun --months 2
npm start -- --site kgi --start-date 20260801

# 4. 查看所有支援的券商站點清單
npm start -- --list

# 5. 查看指令說明
npm start -- --help
```

#### 🏢 支援站點對照表 (Site ID)
| 券商名稱 | Site ID (`--site`) | 認證模式 | 報告儲存目錄 |
| :--- | :--- | :--- | :--- |
| **玉山投顧** | `esun` | 帳密 + AI 視覺驗證碼 | `EquityReport/esun/` |
| **凱基投顧** | `kgi` | 帳密 + AI 視覺驗證碼 | `EquityReport/kgi/` |
| **元大投顧** | `yuanta` | 帳密 + AI 視覺驗證碼 | `EquityReport/yuanta/` |
| **富邦投顧** | `fubon` | 帳密登入 | `EquityReport/fubon/` |
| **永豐投顧** | `sinopac` | 帳密登入 | `EquityReport/sinopac/` |
| **國泰證期** | `cathay` | 公開專區 / 帳密 | `EquityReport/cathay/` |
| **群益投顧** | `capital` | 公開專區 / 帳密 | `EquityReport/capital/` |

---

## 🛠️ 未來如何新增一個新網站？

只需 2 個簡單步驟：

### 步驟 1：建立 `src/sites/<siteName>.ts`
繼承 `BaseSiteCrawler` 並實作 `login` 與 `crawlAndDownload`：

```typescript
import { BaseSiteCrawler } from './base';
import { Page, BrowserContext } from 'playwright';
import { CrawlOptions } from '../core/types';

export class FubonCrawler extends BaseSiteCrawler {
  readonly id = 'fubon';
  readonly name = '富邦投顧';
  readonly baseUrl = 'https://...';

  async login(page: Page, context: BrowserContext): Promise<boolean> {
    // 實作登入與驗證碼辨識邏輯 (可使用 CaptchaService.recognize)
    return true;
  }

  async crawlAndDownload(page: Page, context: BrowserContext, options?: CrawlOptions): Promise<void> {
    // 實作爬取列表與 DownloadManager.saveReport 呼叫
  }
}
```

### 步驟 2：在 `src/sites/index.ts` 註冊新站點
```typescript
export const SITES_REGISTRY: Record<string, () => SiteCrawler> = {
  yuanta: () => new YuantaCrawler(),
  fubon: () => new FubonCrawler(), // 新增這一行即可！
};
```
