# 全球/台灣券商投資研究報告自動下載器 (Multi-Site Framework)

本專案是一套基於 **TypeScript + Playwright** 與 **Antigravity CLI (`agy`) AI 視覺辨識** 的多站點投資報告爬蟲框架，並整合 **Google Drive 同步** 與 **法說會逐字稿 / 摘要流程**。

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
5. **Google Drive 鏡像同步**：
   * 研究報告增量上傳至雲端「投資報告」資料夾，本地刪除的檔案雲端同步移到垃圾桶。
6. **法說會逐字稿與摘要**：
   * 從公開資訊觀測站抓取法說會影音，在本地以 faster-whisper 轉成逐字稿（有 NVIDIA GPU 時自動使用），再用 `agy` 產生 Markdown 摘要並上傳雲端。
7. **過期報告清理**：
   * 依檔名日期自動清除本地與雲端超過保留期限的報告、逐字稿與音檔。

---

## 📂 專案目錄結構

```
┌── src/
│   ├── core/                  # 🛠️ 共通核心模組
│   │   ├── types.ts           # 共通介面與型別定義
│   │   ├── browser.ts         # 瀏覽器與 Session 管理
│   │   ├── captcha.ts         # agy CLI AI 視覺辨識服務
│   │   ├── downloader.ts      # PDF 下載、去重與歸檔
│   │   ├── googleDrive.ts     # Google Drive API (授權、上傳、鏡像同步)
│   │   └── earnings.ts        # 法說會共用設定 (雲端路徑、manifest、摘要版本)
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
│   ├── index.ts               # 🚀 統一 CLI 入口 (下載研究報告)
│   ├── upload_drive.ts        # ☁️ 同步至 Google Drive
│   ├── cleanup_reports.ts     # 🧹 清理過期報告
│   ├── summarize_earnings.ts  # 📝 法說會逐字稿摘要
│   └── rename_earnings_audio.ts # 🏷️ 法說會音檔重新命名
├── scripts/
│   └── transcribe_earnings.py # 🎙️ 法說會影音 → 逐字稿 (Python，以 uv 執行)
├── auth/                      # 🔐 各站點 Session 儲存目錄 (自動生成)
├── EquityReport/              # 📥 下載之個股研究報告 PDF (依站點分子目錄)
├── EarningsCall/              # 📝 法說會逐字稿與摘要 (<YYYYMM>/*.txt、*.md)、manifest.json、audio/
├── credentials.json           # Google OAuth 憑證 (自行放置)
├── token.json                 # Google 授權 Token (首次授權後自動生成)
├── .env.example               # 環境變數範本
├── .env                       # 帳密設定檔 (自行建立)
├── package.json
└── tsconfig.json
```

---

## 🚀 快速開始

### 1. 安裝套件
```powershell
npm install
npx playwright install chromium
```

另需安裝：
* Antigravity CLI (`agy`) 並加入 PATH，供驗證碼辨識與法說會摘要使用。
* [uv](https://docs.astral.sh/uv/)（`winget install astral-sh.uv`），供法說會轉逐字稿使用；Python 與套件會在首次執行時自動安裝，不需另外安裝 Python 或 ffmpeg。

### 2. 設定帳號密碼
在根目錄建立 `.env` 檔案（可複製 `.env.example`）：

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

> `DOWNLOAD_DIR` 留空時預設為 `D:\投資報告`，報告存於 `<DOWNLOAD_DIR>/EquityReport/<siteId>/`。
> `upload:drive` 與 `clean:reports` 預設讀取專案根目錄的 `./EquityReport`，若下載目錄不同請以 `--dir` 指定。

### 3. 設定 Google Drive (同步與法說會功能需要)
1. 在 Google Cloud Console 建立專案並啟用 **Google Drive API**。
2. 建立 OAuth 用戶端 ID（應用程式類型：桌面應用程式），下載 JSON 並命名為 `credentials.json` 放在專案根目錄。
3. 首次執行 `npm run upload:drive` 等指令時會開啟瀏覽器授權，Token 會存成 `token.json`，之後自動沿用。

---

## 📥 下載研究報告

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

## ☁️ 同步至 Google Drive

```powershell
npm run upload:drive                    # 鏡像同步 ./EquityReport 至雲端「投資報告」
npm run upload:drive -- --dir <路徑>    # 指定要同步的本地目錄
```

* **增量上傳**：雲端已有同名檔案則跳過。
* **鏡像清理**：本地已刪除的報告，雲端對應檔案會移到垃圾桶。
* **法說會摘要**：同時把 `./EarningsCall/<YYYYMM>/*.md` 上傳到雲端同名月份資料夾（雲端沒有或本地較新才上傳；月份資料夾不存在時自動建立）；逐字稿、`manifest.json`、音檔只留在本地。`EarningsCall` 不做鏡像刪除，也不能用 `--dir` 指定。

---

## 🎙️ 法說會逐字稿與摘要

整體流程：

```
npm run transcribe:earnings ──► 本地 EarningsCall/<YYYYMM>/*.txt (逐字稿) + EarningsCall/manifest.json
       │
npm run summarize:earnings  ──► 本地 EarningsCall/<YYYYMM>/*.md (摘要)
       │
npm run upload:drive        ──► 摘要上傳雲端 投資報告/EarningsCall/<YYYYMM>/ (逐字稿只留在本地)
```

### 1. 轉逐字稿 (`scripts/transcribe_earnings.py`)
```powershell
npm run transcribe:earnings                                 # 處理當月 (台北時間)，自動偵測 GPU
npm run transcribe:earnings:gpu                             # NVIDIA 顯示卡：另外安裝 CUDA 12 / cuDNN 9 函式庫後執行
npm run transcribe:earnings -- --month 202609               # 補抓指定月份
npm run transcribe:earnings -- --codes 2330,2317            # 只處理特定股票代號
npm run transcribe:earnings -- --redo 2330_20261015         # 強制重做 (可重複指定)
npm run transcribe:earnings -- --url 2330_20261015=<網址>   # 手動指定影音來源 (可重複指定)
npm run transcribe:earnings -- --failed                     # 列出失敗場次與下次是否重試
npm run transcribe:earnings -- --help                       # 所有參數
```
* 從公開資訊觀測站抓取當月法說會清單與影音連結（irconference、webpro、YouTube 等），下載音訊並以 faster-whisper 轉成繁體中文逐字稿。
* 以 `EarningsCall/manifest.json` 記錄處理狀態，重跑時自動跳過已完成場次（已有逐字稿或摘要的場次也會補登為完成），暫時性失敗會隔一段時間重試；可隨時 `Ctrl+C` 中斷，重跑從未完成的場次繼續。
* 首次執行會下載 Whisper 模型（`large-v3-turbo` 約 1.6 GB）；記憶體不足或 CPU 太慢可加 `--model medium`。
* **速度**：有 NVIDIA GPU 時一小時的法說會約 1～2 分鐘；只用 CPU 約需數分鐘到十幾分鐘（視 CPU 而定），場次多時建議讓它整晚執行。
  * `transcribe:earnings:gpu` 會額外下載約 1 GB 的 CUDA 函式庫（只有第一次）；已自行安裝 CUDA 12 與 cuDNN 9 時用 `transcribe:earnings` 即可。GPU 無法使用時會自動改用 CPU 並提示。
* `--url` 的來源可為網址、Google Drive 分享連結（需設為「知道連結的任何人」可檢視）或本地檔案路徑，會優先於觀測站連結嘗試；場次代號或日期錯誤時會出現「不在本月清單」的警告。
* YouTube 要求登入驗證時，加上 `--cookies <cookies.txt>` 或 `--cookies-from-browser firefox`。有安裝 Node.js 時會自動提供給 yt-dlp 解析 YouTube。

### 2. 產生摘要
```powershell
npm run summarize:earnings                        # 處理當月 (台北時間)
npm run summarize:earnings -- --month 202609      # 指定月份
npm run summarize:earnings -- --concurrency 1     # 遇到 agy 額度限制時降低同時處理數
npm run summarize:earnings -- --force             # 已有摘要的場次也重新產生
```
比對本地逐字稿與摘要，只處理尚未摘要、或逐字稿在摘要後又更新過的場次。完成後執行 `npm run upload:drive` 上傳。

### 3. 手動補抓的音檔
無法自動下載的場次，把音檔放到本地 `EarningsCall/audio/`，統一命名為 `公司名稱(代號)-YYYYMMDD.副檔名` 後重跑 `transcribe:earnings`，會優先使用這些音檔：
```powershell
npm run rename:audio -- --dry-run    # 預覽 (依 manifest.json 比對公司與日期)
npm run rename:audio                 # 實際改名
```

---

## 🧹 清理過期報告

```powershell
npm run clean:reports                  # 刪除超過 2 個月的報告 (本地 + 雲端 EarningsCall)
npm run clean:reports -- --months 3    # 自訂保留月數
npm run clean:reports -- --dry-run     # 僅預覽
npm run clean:reports -- --local-only  # 只清理本地
```

* 以檔名前綴日期 (`YYYYMMDD_...`) 判斷，無日期的檔案保留並提示；`EarningsCall/audio/` 的音檔以檔名結尾的召開日期判斷。
* 本地 `EarningsCall/manifest.json` 的過期紀錄一併移除。**請勿在 `transcribe:earnings` 執行期間清理**。
* 雲端 `EarningsCall` 依相同規則移到垃圾桶（30 天內可復原）。
* 刪除後執行 `npm run upload:drive`，雲端 `EquityReport` 會同步清除。

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

