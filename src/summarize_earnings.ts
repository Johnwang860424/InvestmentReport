import { parseArgs } from 'util';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GoogleDriveService } from './core/googleDrive';
import {
  CLOUD_EARNINGS_PATH,
  EARNINGS_FOLDER,
  LOCAL_EARNINGS_ROOT,
  VERSION_LABEL,
  readSummaryVersion,
  summaryNameOf,
  transcriptVersionMs,
} from './core/earnings';

const DEFAULT_MODEL = 'gemini-3.8-flash-high';
const AGY_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_TRANSCRIPT_CHARS = 500; // 逐字稿內文太短 (多半是靜音或下載到錯的影片) 就不摘要
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_CONCURRENCY = 3;

function printHelp(): void {
  console.log(`
=====================================================
  📝 法說會逐字稿摘要工具 (agy CLI)
=====================================================
使用方式:
  npm run summarize:earnings                       處理當月 (台北時間)
  npm run summarize:earnings -- --month <YYYYMM>   指定月份，例如 202608
  npm run summarize:earnings -- --model <名稱>     指定 agy 模型 (預設: ${DEFAULT_MODEL})，可用 agy models 查詢
  npm run summarize:earnings -- --limit <N>        本次最多摘要幾場 (測試用)
  npm run summarize:earnings -- --concurrency <N>  同時摘要幾場 (預設: ${DEFAULT_CONCURRENCY})，遇到 agy 額度限制可調低為 1
  npm run summarize:earnings -- --force            已有摘要的場次也重新產生
  npm run summarize:earnings -- --local-only       不下載雲端 (Colab) 的逐字稿
  npm run summarize:earnings -- --help             顯示此說明

流程:
  1. 下載 Colab 寫入雲端「${CLOUD_EARNINGS_PATH.join('/')}/<YYYYMM>」的逐字稿 (本地沒有或雲端較新者)
  2. 比對 ./${EARNINGS_FOLDER}/<YYYYMM> 的逐字稿 (.txt，由 npm run transcribe:earnings 或 Colab 產生) 與摘要 (.md)，
     找出尚未摘要、或逐字稿在摘要後又更新過的場次 (摘要內記錄了逐字稿版本)
  3. 同時處理多場：用 agy 產生同名 .md
  摘要完成後執行 npm run upload:drive 上傳至雲端 (同名檔案直接覆蓋)
=====================================================
`);
}

/**
 * 下載 Colab 寫入雲端的逐字稿到本地月份資料夾；本地檔案的修改時間設為雲端修改時間，
 * 摘要記錄的版本因此與雲端一致，upload:drive 才能判斷雲端逐字稿是否已摘要。回傳下載份數。
 */
async function pullCloudTranscripts(month: string, localDir: string): Promise<number> {
  const folderId = await GoogleDriveService.findFolderByPath([...CLOUD_EARNINGS_PATH, month]);
  if (!folderId) return 0;

  let downloaded = 0;
  for (const file of await GoogleDriveService.listFolderFiles(folderId)) {
    if (!file.name?.endsWith('.txt')) continue;
    const txtPath = path.join(localDir, file.name);
    const cloudMs = GoogleDriveService.modifiedTimeMs(file);
    if (fs.existsSync(txtPath) && transcriptVersionMs(txtPath) >= cloudMs) continue;
    if (readSummaryVersion(summaryNameOf(txtPath)) >= cloudMs) continue; // 已摘要過這個版本
    await GoogleDriveService.downloadFile(file.id!, txtPath);
    const modified = new Date(cloudMs);
    fs.utimesSync(txtPath, modified, modified);
    downloaded++;
    console.log(`📥 [下載逐字稿] ${file.name}`);
  }
  return downloaded;
}

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}${get('month')}`;
}

function buildPrompt(txtPath: string, name: string): string {
  return `請讀取 ${txtPath} 這份「${name}」法人說明會的語音辨識逐字稿 (開頭幾行是公司、日期、來源等檔頭)。
逐字稿可能有同音錯字或專有名詞辨識錯誤，請依上下文判斷。
請用台灣繁體中文、Markdown 格式整理，只根據逐字稿內容，不要補充外部資訊；數字請保留原始單位，無法確定的數字請標註「（辨識存疑）」。
請依序使用以下二級標題：

## 一句話結論
## 營運重點
## 財務數字（營收、毛利率、營益率、EPS、資本支出等，逐字稿有提到才列）
## 展望與指引
## Q&A 重點
## 風險與不確定因素

直接輸出摘要本文，第一行就是「## 一句話結論」，不要有任何開場白或結尾說明，也不要建立或修改任何檔案。`;
}

/**
 * 從 agy 輸出中取出摘要本文：去掉 ```markdown 圍欄，並捨棄第一個 Markdown 標題之前的開場白
 */
function extractMarkdown(output: string): string {
  let text = output.trim();
  const fenced = /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced && fenced[1].includes('## ')) {
    text = fenced[1].trim();
  }
  const firstHeading = text.search(/^#{1,6} /m);
  return firstHeading > 0 ? text.slice(firstHeading).trim() : text;
}

/** 執行 agy 並收集輸出；逾時會被中止 (signal 不為 null) */
function runAgy(args: string[]): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('agy', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: AGY_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function summarize(txtPath: string, model: string, transcriptVersion: string): Promise<string> {
  const raw = fs.readFileSync(txtPath, 'utf-8');
  // 逐字稿檔頭 (公司、日期、來源…) 與內文以空行分隔
  const splitAt = raw.indexOf('\n\n');
  const header = splitAt >= 0 ? raw.slice(0, splitAt) : '';
  const body = splitAt >= 0 ? raw.slice(splitAt + 2) : raw;
  if (body.length < MIN_TRANSCRIPT_CHARS) {
    throw new SkipError(`逐字稿過短 (${body.length} 字)`);
  }

  const headerLines = header.split('\n').filter(Boolean);
  const name = (headerLines[0] || path.basename(txtPath, '.txt')).replace(/^公司：/, '');

  const result = await runAgy(
    ['-p', buildPrompt(txtPath, name), '--model', model,
      '--dangerously-skip-permissions', '--add-dir', path.dirname(txtPath)],
  );
  if (result.signal) {
    throw new Error(`agy 逾時或被中止 (${result.signal})，超過 ${AGY_TIMEOUT_MS / 60000} 分鐘`);
  }
  if (result.status !== 0) {
    throw new Error(`agy 結束代碼 ${result.status}：${(result.stderr || result.stdout || '').trim().slice(-300)}`);
  }

  const summary = extractMarkdown(result.stdout || '');
  if (summary.length < 200) {
    throw new Error(`agy 輸出過短，可能不是摘要：${summary.slice(0, 200)}`);
  }

  const meta = [...headerLines, `摘要模型：${model}`, `${VERSION_LABEL}${transcriptVersion}`]
    .map(line => `- ${line}`).join('\n');
  return `# ${name} 法說會摘要\n\n${meta}\n\n${summary}\n`;
}

class SkipError extends Error {}

function parsePositiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} 必須為正整數：${value}`);
  }
  return n;
}

async function main(): Promise<void> {
  const options = {
    month: { type: 'string' as const, short: 'm' },
    model: { type: 'string' as const },
    limit: { type: 'string' as const, short: 'n' },
    concurrency: { type: 'string' as const, short: 'c' },
    force: { type: 'boolean' as const, short: 'f' },
    'local-only': { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };

  const { values } = parseArgs({ options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  const month = values.month || currentMonth();
  if (!/^\d{6}$/.test(month)) {
    throw new Error(`--month 格式須為 YYYYMM：${month}`);
  }
  const limit = parsePositiveInt('--limit', values.limit, Infinity);
  const concurrency = parsePositiveInt('--concurrency', values.concurrency, DEFAULT_CONCURRENCY);
  const model = values.model || DEFAULT_MODEL;
  const force = values.force === true;
  const localDir = path.join(LOCAL_EARNINGS_ROOT, month);

  console.log('=====================================================');
  console.log('  📝 法說會逐字稿摘要 (agy)');
  console.log('=====================================================');
  console.log(`📁 本地目錄:   ${localDir}`);
  console.log(`🤖 摘要模型:   ${model}`);
  console.log(`⚡ 同時處理:   ${concurrency} 場`);
  if (force) {
    console.log('⚙️ 執行模式:   強制重新摘要');
  }

  const startTime = Date.now();
  const stats = { summarized: 0, skipped: 0, failed: 0 };

  // 1. 下載 Colab 產生的雲端逐字稿；無法連線雲端時只處理本地逐字稿
  fs.mkdirSync(localDir, { recursive: true });
  if (values['local-only'] !== true) {
    console.log(`\n☁️ 檢查雲端「${[...CLOUD_EARNINGS_PATH, month].join('/')}」的逐字稿...`);
    try {
      const downloaded = await pullCloudTranscripts(month, localDir);
      console.log(`☁️ 下載 ${downloaded} 份雲端逐字稿`);
    } catch (err: any) {
      console.warn(`⚠️ 無法讀取雲端逐字稿，只處理本地逐字稿：${err.message}`);
    }
  }

  // 2. 比對逐字稿與摘要，找出待摘要場次
  const txts = fs.readdirSync(localDir).filter(name => name.endsWith('.txt')).sort();
  const pending = txts
    .filter(name => force
      || readSummaryVersion(path.join(localDir, summaryNameOf(name))) < transcriptVersionMs(path.join(localDir, name)))
    .slice(0, limit);

  console.log(`\n🤖 共有 ${txts.length} 份逐字稿，待摘要 ${pending.length} 場\n`);

  // 3. 同時處理 concurrency 場
  //    連續失敗達上限時不再開始新場次，進行中的場次會跑完
  let consecutiveFailures = 0;
  let nextIndex = 0;
  let stopped = false;

  const processOne = async (index: number): Promise<void> => {
    const name = pending[index];
    const txtPath = path.join(localDir, name);
    const mdPath = summaryNameOf(txtPath);
    const t0 = Date.now();
    console.log(`🤖 [摘要中] (${index + 1}/${pending.length}) ${name}...`);
    try {
      // 先記下版本，摘要期間逐字稿若被重做，下次會再摘要
      const version = new Date(transcriptVersionMs(txtPath)).toISOString();
      fs.writeFileSync(mdPath, await summarize(txtPath, model, version), 'utf-8');
      stats.summarized++;
      consecutiveFailures = 0;
      console.log(`✅ [完成] ${path.basename(mdPath)} (${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    } catch (err: any) {
      if (err instanceof SkipError) {
        stats.skipped++;
        console.log(`⏩ [跳過] ${name}: ${err.message}`);
        return;
      }
      stats.failed++;
      consecutiveFailures++;
      console.error(`❌ [失敗] ${name}: ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !stopped) {
        stopped = true;
        console.error(`\n⛔ 連續失敗 ${MAX_CONSECUTIVE_FAILURES} 次，可能已達 agy 額度上限，不再開始新的場次；稍後重跑會從未完成的場次繼續。`);
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < pending.length) {
      await processOne(nextIndex++);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=====================================================');
  console.log('  🎉 完成！');
  console.log('=====================================================');
  console.log(`⏱️  耗時:       ${duration} 秒`);
  console.log(`🤖 新增摘要:   ${stats.summarized}`);
  if (stats.skipped > 0) {
    console.log(`⏩ 逐字稿過短: ${stats.skipped}`);
  }
  if (stats.failed > 0) {
    console.log(`❌ 摘要失敗:   ${stats.failed}`);
    process.exitCode = 1;
  }
  console.log('=====================================================');

  if (stats.summarized > 0) {
    console.log('\n💡 執行 npm run upload:drive 可將摘要上傳至雲端。');
  }
}

main().catch((error: any) => {
  console.error('\n❌ 執行失敗:', error.message);
  process.exit(1);
});
