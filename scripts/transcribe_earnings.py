# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "beautifulsoup4",
#   "imageio-ffmpeg",
#   "opencc-python-reimplemented",
#   "requests",
#   "tzdata",
#   "yt-dlp[default]",
# ]
# ///
"""法說會影音 → 逐字稿（本地執行）

1. 從公開資訊觀測站 t100sb02_1 抓取指定月份（預設當月）的法說會清單
2. 下載「影音連結資訊」中的影音（irconference mp4、webpro 串流、YouTube 及 yt-dlp 能解析的網站），
   或使用 ./EarningsCall/audio 內手動補抓的音檔
3. 切成數段交給 agy (雲端 Gemini) 轉成繁體中文逐字稿，存到 ./EarningsCall/<YYYYMM>/；轉錄時背景預先下載後面幾場
4. ./EarningsCall/manifest.json 記錄已處理的場次，重跑時自動跳過；
   有 token.json (npm run upload:drive 授權產生) 時與雲端 Colab 的 manifest.json 同步，兩邊不會重複轉錄
   - 失敗分為「永久」（該連結不是影音、影片已刪除）與「暫時」（YouTube 驗證、網路問題），暫時性失敗隔一段時間自動重試
   - 公司之後補上新的影音連結時，會自動重新處理

執行：npm run transcribe:earnings -- --help
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Taipei')
TODAY = dt.datetime.now(TZ).date()

# ===== 預設設定 (多數可用命令列參數覆寫) =====
MARKETS = ['sii', 'otc']                   # sii 上市、otc 上櫃、rotc 興櫃、pub 公開發行
AGY_MODEL = 'gemini-3.8-flash-high'        # 與 summarize_earnings.ts 相同；可用 agy models 查詢
AGY_CONCURRENCY = 3                        # 同時交給 agy 轉寫幾段；遇到 agy 額度限制可調低為 1
CHUNK_MINUTES = 10                         # 每段音檔長度 (分鐘)；太長 agy 容易逾時或漏段
AGY_TIMEOUT_SECONDS = 15 * 60              # 單段轉寫逾時
AGY_RETRIES = 1                            # 單段失敗時重試次數
MAX_CONSECUTIVE_AGY_FAILURES = 3           # 連續幾場因 agy 失敗就停止 (多半是額度用完)
DOWNLOAD_WORKERS = 2                       # 轉錄時，背景同時預先下載幾場；YouTube 常要求驗證時可調為 1
MAX_ATTEMPTS = 5                           # 暫時性失敗（YouTube 驗證、網路逾時…）最多嘗試幾次；出現新連結時重新計算
RETRY_AFTER_HOURS = 24                     # 暫時性失敗後，隔多久才再試
MIN_TRANSCRIPT_CHARS = 500                 # 逐字稿內文少於此字數視為失敗（靜音、片頭音樂或抓錯影片）
MANIFEST_KEEP_MONTHS = 6                   # manifest 保留最近幾個月的紀錄，更舊的自動清除
YT_PLAYER_CLIENTS = 'tv,web_safari,mweb'   # YouTube 播放器用戶端，依序嘗試；None = yt-dlp 預設
YT_SLEEP_SECONDS = 10                      # 每支 YouTube 下載前等待秒數，降低被判定為機器人；0 = 不等

# 與 src/core/earnings.ts 共用的路徑
CLOUD_EARNINGS_PATH = ['投資報告', 'EarningsCall']
EARNINGS_ROOT = Path.cwd() / 'EarningsCall'
TOKEN_PATH = Path.cwd() / 'token.json'
MANIFEST_PATH = EARNINGS_ROOT / 'manifest.json'
AUDIO_DIR = EARNINGS_ROOT / 'audio'
WORK = Path.cwd() / 'temp' / 'earnings_call'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0 Safari/537.36')


@dataclass
class Event:
    market: str
    code: str
    name: str
    date: dt.date
    date_text: str
    time: str
    summary: str
    urls: list = field(default_factory=list)

    @property
    def key(self):
        return f'{self.code}_{self.date:%Y%m%d}'

    @property
    def stem(self):
        return f'{self.date:%Y%m%d}_{self.code}_{safe_name(self.name)}'


# ===== 共用函式（manifest 與重試判斷）=====

# 這些錯誤代表「這條連結」再試也不會成功（公司官網頁面、影片已刪除、內容不是法說會…），之後不再嘗試該連結；
# 其他錯誤（YouTube 機器人驗證、網路逾時、限流…）視為暫時性，隔 RETRY_AFTER_HOURS 再試。
# 證交所自己的連結（irconference / webpro）常是先公告、影片稍後才上架，一律視為暫時性。
PERMANENT_ERROR_PATTERNS = [
    'Unsupported URL', 'yt-dlp 沒有產生檔案', '逐字稿過短', 'HTTP Error 404', 'HTTP Error 410',
    'Video unavailable', 'Private video', 'This video has been removed', 'is not a valid URL',
]


class CloudManifest:
    """讀寫雲端「投資報告/EarningsCall/manifest.json」(Colab 使用的同一份)。
    沿用 npm run upload:drive 等指令授權產生的 token.json，直接呼叫 Google Drive REST API。"""

    TOKEN_API = 'https://oauth2.googleapis.com/token'
    API = 'https://www.googleapis.com/drive/v3/files'
    UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
    FOLDER = 'application/vnd.google-apps.folder'

    def __init__(self, token_path):
        self.creds = json.loads(token_path.read_text(encoding='utf-8'))
        self.access_token = None
        self.expires_at = 0
        self.file_id = None

    def _request(self, method, url, headers=None, **kwargs):
        import requests

        if time.time() > self.expires_at - 60:
            r = requests.post(self.TOKEN_API, timeout=30, data={
                'client_id': self.creds['client_id'], 'client_secret': self.creds['client_secret'],
                'refresh_token': self.creds['refresh_token'], 'grant_type': 'refresh_token'})
            if r.status_code != 200:
                raise RuntimeError(f'Google 授權失敗 ({r.text.strip()[:100]})，請執行 npm run upload:drive 重新授權')
            self.access_token = r.json()['access_token']
            self.expires_at = time.time() + r.json().get('expires_in', 3600)
        r = requests.request(method, url, timeout=60, **kwargs,
                             headers={'Authorization': f'Bearer {self.access_token}', **(headers or {})})
        r.raise_for_status()
        return r

    def _find(self, name, parent, folder):
        op = '=' if folder else '!='
        q = (f"name='{name}' and '{parent}' in parents and trashed=false "
             f"and mimeType{op}'{self.FOLDER}'")
        files = self._request('GET', self.API, params={'q': q, 'fields': 'files(id)', 'spaces': 'drive'}).json()['files']
        return files[0]['id'] if files else None

    def _create(self, name, parent, mime):
        body = {'name': name, 'parents': [parent], 'mimeType': mime}
        return self._request('POST', self.API, json=body, params={'fields': 'id'}).json()['id']

    def _manifest_id(self, create):
        if self.file_id:
            return self.file_id
        parent = 'root'
        for name in CLOUD_EARNINGS_PATH:
            folder_id = self._find(name, parent, folder=True)
            if not folder_id:
                if not create:
                    return None
                folder_id = self._create(name, parent, self.FOLDER)
            parent = folder_id
        self.file_id = self._find(MANIFEST_PATH.name, parent, folder=False)
        if not self.file_id and create:
            self.file_id = self._create(MANIFEST_PATH.name, parent, 'application/json')
        return self.file_id

    def load(self):
        file_id = self._manifest_id(create=False)
        if not file_id:
            return {}
        text = self._request('GET', f'{self.API}/{file_id}', params={'alt': 'media'}).text
        return json.loads(text) if text.strip() else {}

    def save(self, manifest):
        file_id = self._manifest_id(create=True)
        data = json.dumps(manifest, ensure_ascii=False, indent=1).encode('utf-8')
        self._request('PATCH', f'{self.UPLOAD_API}/{file_id}', params={'uploadType': 'media'},
                      data=data, headers={'Content-Type': 'application/json'})


_cloud = None        # CloudManifest；None = manifest 只存本地
_prune_month = None  # (年, 月)：合併雲端紀錄後再清一次過期紀錄，避免已清除的紀錄被合併回來


def connect_cloud(enabled):
    global _cloud
    if not enabled:
        return
    if not TOKEN_PATH.exists():
        print('⚠️ 找不到 token.json，manifest 只存本地；執行一次 npm run upload:drive 授權後即可與 Colab 同步')
        return
    try:
        _cloud = CloudManifest(TOKEN_PATH)
    except (ValueError, KeyError) as e:
        print(f'⚠️ token.json 格式不符 ({e})，manifest 只存本地')


def record_rank(rec):
    """兩邊都有同一場紀錄時的取捨：已完成優先，其次取最後更新時間較新者。"""
    return rec.get('status') == 'done', rec.get('updated') or rec.get('last_attempt') or ''


def merge_manifest(manifest, other):
    for key, rec in other.items():
        if key not in manifest or record_rank(rec) > record_rank(manifest[key]):
            manifest[key] = rec


def cloud_failed(action, e):
    global _cloud
    _cloud = None
    print(f'⚠️ 雲端 manifest {action}失敗，本次改為只存本地 (下次執行會再合併)：{short_error(str(e))[:200]}')


def load_manifest():
    manifest = {}
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    if _cloud:
        try:
            merge_manifest(manifest, _cloud.load())
        except Exception as e:
            cloud_failed('讀取', e)
    return manifest


def save_manifest(manifest):
    """存本地，並與雲端合併後寫回；先讀最新的雲端內容合併，避免蓋掉 Colab 同時寫入的紀錄。"""
    if _cloud:
        try:
            merge_manifest(manifest, _cloud.load())
            if _prune_month:
                prune_manifest(manifest, *_prune_month)
        except Exception as e:
            cloud_failed('讀取', e)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST_PATH.with_suffix('.tmp')
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, MANIFEST_PATH)
    if _cloud:
        try:
            _cloud.save(manifest)
        except Exception as e:
            cloud_failed('寫入', e)


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\s]+', '_', s).strip('_')


def is_local(url):
    return not url.startswith(('http://', 'https://'))


def short_error(message):
    """從 yt-dlp / ffmpeg 的輸出挑出關鍵的一行（優先取最後一個 ERROR 行）。"""
    lines = [l.strip() for l in message.splitlines() if l.strip()]
    errs = [l for l in lines if l.startswith('ERROR')]
    return (errs or lines or [message])[-1]


def is_permanent_error(url, message):
    if 'twse.com.tw' in url:
        return False
    return any(p in message for p in PERMANENT_ERROR_PATTERNS)


def live_urls(rec, urls):
    """排除已確認無法使用的連結。"""
    dead = set(rec.get('dead_urls', []))
    return [u for u in urls if u not in dead]


def has_new_urls(rec, urls):
    """清單中出現尚未嘗試過的連結（例如公司後來補上 YouTube）。"""
    tried = set(rec.get('tried_urls', []))
    return any(u not in tried for u in live_urls(rec, urls))


def retry_blocker(rec, urls):
    """回傳這場暫不處理的原因；None 代表可以處理。"""
    if not live_urls(rec, urls):
        return '所有連結皆無法使用'
    if has_new_urls(rec, urls):
        return None
    if rec.get('attempts', 0) >= MAX_ATTEMPTS:
        return '已達重試上限'
    last = rec.get('last_attempt')
    if last:
        next_try = dt.datetime.fromisoformat(last) + dt.timedelta(hours=RETRY_AFTER_HOURS)
        if dt.datetime.now(TZ) < next_try:
            return f'{next_try:%m/%d %H:%M} 後重試'
    return None


def prune_manifest(manifest, year, month):
    """清除 MANIFEST_KEEP_MONTHS 個月以前的紀錄（補抓舊月份時保留該月以後的紀錄）。"""
    y, m = divmod(TODAY.year * 12 + TODAY.month - 1 - MANIFEST_KEEP_MONTHS, 12)
    cutoff = min(dt.date(y, m + 1, 1), dt.date(year, month, 1)).isoformat()
    old = [k for k, v in manifest.items() if v.get('date', cutoff) < cutoff]
    for k in old:
        del manifest[k]
    return len(old)


AUDIO_NAME_RE = re.compile(r'\((\w+)\)-(\d{8})\.[^.]+$')


def manual_sources(url_args):
    """手動指定的來源：--url 參數，以及 ./EarningsCall/audio 內以 公司名稱(代號)-YYYYMMDD.副檔名 命名的音檔。"""
    sources = {}
    for arg in url_args:
        key, sep, url = arg.partition('=')
        if not sep or not re.fullmatch(r'\w+_\d{8}', key):
            sys.exit(f'--url 格式須為 代號_YYYYMMDD=網址或檔案路徑：{arg}')
        sources.setdefault(key, []).append(url.strip())
    if AUDIO_DIR.is_dir():
        for p in sorted(AUDIO_DIR.iterdir()):
            m = AUDIO_NAME_RE.search(p.name)
            if p.is_file() and m:
                sources.setdefault(f'{m[1]}_{m[2]}', []).append(str(p.resolve()))
    return sources


def apply_manual_sources(manual, key, urls):
    """手動指定的來源排在最前面，觀測站原本的連結留作備援。"""
    return list(dict.fromkeys(manual.get(key, []) + urls))


# ===== 抓取法說會清單 =====

BASE = 'https://mopsov.twse.com.tw/mops/web'
DATE_RE = re.compile(r'(\d{2,3})/(\d{1,2})/(\d{1,2})')
URL_RE = re.compile(r'https?://[^\s<>"\']+')
_session = None


def http():
    global _session
    if _session is None:
        import requests
        _session = requests.Session()
        _session.headers.update({'User-Agent': UA, 'Referer': f'{BASE}/t100sb02_1'})
    return _session


def url_priority(url):
    """中文場 mp4 > 其他 irconference > webpro 串流 > YouTube > 其他網站。"""
    if 'irconference.twse.com.tw' in url:
        return 0 if '_ch' in url else 1
    if 'webpro.twse.com.tw' in url:
        return 2
    if 'youtu' in url:
        return 3
    return 4


def fetch_market(typek, year, month):
    import requests
    from bs4 import BeautifulSoup

    data = {'encodeURIComponent': 1, 'step': 1, 'firstin': 'true', 'off': 1,
            'TYPEK': typek, 'year': year - 1911, 'month': f'{month:02d}', 'co_id': ''}
    for attempt in range(4):
        try:
            r = http().post(f'{BASE}/ajax_t100sb02_1', data=data, timeout=60)
            r.encoding = 'utf-8'
            if '查無資料' in r.text:
                return []
            if 'myTable' in r.text:
                break
        except requests.RequestException as e:
            print(f'  {typek} 第 {attempt + 1} 次失敗：{e}')
        time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f'{typek} 清單抓取失敗（可能被限流，稍後再試）')

    soup = BeautifulSoup(r.text, 'html.parser')
    rows = []
    for tr in soup.select('#myTable tr[data-type=body]'):
        tds = tr.find_all('td')
        if len(tds) < 10:
            continue
        dates = DATE_RE.findall(tds[2].get_text())
        if not dates:
            continue
        y, mo, d = dates[-1]  # 日期區間（例如 115/08/17 至 115/09/15）取結束日
        media = tds[9]
        urls = [a['href'].strip() for a in media.find_all('a', href=True)]
        urls += URL_RE.findall(media.get_text(' '))
        urls = sorted(dict.fromkeys(u for u in urls if u.startswith('http')), key=url_priority)
        rows.append(Event(
            market=typek,
            code=tds[0].get_text(strip=True),
            name=tds[1].get_text(strip=True),
            date=dt.date(int(y) + 1911, int(mo), int(d)),
            date_text=tds[2].get_text(' ', strip=True),
            time=tds[3].get_text(strip=True),
            summary=tds[5].get_text(' ', strip=True),
            urls=urls,
        ))
    return rows


def fetch_events(year, month, markets, only_codes, manual, cli_keys):
    events = {}
    for mk in markets:
        rows = fetch_market(mk, year, month)
        print(f'{mk}: {len(rows)} 場')
        for ev in rows:
            if not only_codes or ev.code in only_codes:
                events.setdefault(ev.key, ev)
        time.sleep(3)
    for ev in events.values():
        ev.urls = apply_manual_sources(manual, ev.key, ev.urls)
    events = list(events.values())

    # 音檔資料夾內其他月份或未指定公司的檔案不提示
    in_scope = {k for k in manual if f'_{year}{month:02d}' in k and (not only_codes or k.split('_')[0] in only_codes)}
    missing = sorted((in_scope | cli_keys) - {ev.key for ev in events})
    if missing:
        print(f'⚠️ 這些手動指定的場次不在本月清單（代號或日期有誤，不會生效）：{missing}')
    held = [ev for ev in events if ev.date <= TODAY]
    print(f'共 {len(events)} 場，已召開 {len(held)} 場，已召開且有影音連結 {sum(1 for ev in held if ev.urls)} 場')
    return events


# ===== 下載音檔 =====

GDRIVE_ID_RE = re.compile(r'drive\.google\.com/(?:file/d/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]+)')


def ffmpeg_exe():
    """優先使用系統的 ffmpeg，沒有安裝時使用 imageio-ffmpeg 附帶的執行檔。"""
    found = shutil.which('ffmpeg')
    if found:
        return found
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def resolve_url(url):
    """把網頁連結轉成 yt-dlp 可直接下載的媒體網址。"""
    if url.startswith('http://irconference.twse.com.tw'):
        return 'https://' + url[len('http://'):]
    if 'webpro.twse.com.tw' in url:
        html = http().get(url, timeout=60).text
        m = re.search(r'https://webprovod\.twse\.com\.tw/[^"\\\s]+?playlist\.m3u8', html)
        if m:
            return m.group(0)
    return url


def run(cmd, timeout):
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                       timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[-500:])


def download_gdrive(file_id, dest):
    """直接下載 Google 雲端硬碟原始檔。
    經 yt-dlp 下載雲端硬碟上的 mp3 會出現逐字稿只剩 0～300 字的情況，改為直接下載原始檔。"""
    import requests

    r = requests.get('https://drive.usercontent.google.com/download',
                     params={'id': file_id, 'export': 'download', 'confirm': 't'},
                     headers={'User-Agent': UA}, stream=True, timeout=60)
    r.raise_for_status()
    if 'text/html' in r.headers.get('Content-Type', ''):
        raise RuntimeError('Google Drive 回傳網頁而非檔案（可能未設為「知道連結的任何人」或超過下載配額）')
    with open(dest, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)


def download_audio(url, stem, opts):
    """下載影音 (或讀取本地音檔) 並轉成 16kHz 單聲道 mp3，回傳暫存路徑。"""
    for f in WORK.glob(f'{stem}*'):
        if f.is_dir():
            shutil.rmtree(f)
        else:
            f.unlink()
    if is_local(url):
        raw = Path(url)
        if not raw.is_file():
            raise RuntimeError(f'找不到本地音檔：{url}')
    else:
        gdrive = GDRIVE_ID_RE.search(url)
        if gdrive:
            download_gdrive(gdrive.group(1), WORK / f'{stem}_raw.bin')
        else:
            cmd = [sys.executable, '-m', 'yt_dlp', '--no-playlist', '--no-progress', '-f', 'bestaudio/best',
                   '--user-agent', UA, '--ffmpeg-location', ffmpeg_exe(),
                   '-o', str(WORK / f'{stem}_raw.%(ext)s')]
            if opts.cookies:
                cmd += ['--cookies', opts.cookies]
            if opts.cookies_from_browser:
                cmd += ['--cookies-from-browser', opts.cookies_from_browser]
            if 'youtu' in url:
                if shutil.which('node'):
                    cmd += ['--js-runtimes', 'node']  # YouTube 需要 JavaScript 執行環境；Deno 已預設啟用
                if YT_PLAYER_CLIENTS:
                    cmd += ['--extractor-args', f'youtube:player_client={YT_PLAYER_CLIENTS}']
                if YT_SLEEP_SECONDS:
                    cmd += ['--sleep-requests', '2', '--sleep-interval', str(YT_SLEEP_SECONDS)]
            run(cmd + [resolve_url(url)], timeout=3600)
        raw = next((p for p in WORK.glob(f'{stem}_raw.*') if p.suffix != '.part'), None)
        if raw is None:
            raise RuntimeError('yt-dlp 沒有產生檔案')

    out = WORK / f'{stem}.mp3'
    run([ffmpeg_exe(), '-y', '-loglevel', 'error', '-i', str(raw),
         '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', str(out)], timeout=1800)
    if not is_local(url):
        raw.unlink()  # 手動放入的音檔保留，由 npm run clean:reports 依日期清理
    return out


# ===== agy 轉錄 =====

class AgyError(RuntimeError):
    """agy 執行失敗或輸出不是逐字稿；與影音連結無關，不把連結記為已嘗試。"""


# 逐字稿行首時間：[mm:ss]、[h:mm:ss]，容許全形括號或沒有括號
TS_LINE_RE = re.compile(r'^[\[【(（]?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[\]】)）]?\s*[:：\-–]?\s*(.*)$')


def fmt_ts(sec):
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{s:02d}'


def parse_transcript(text, offset, length):
    """解析 agy 輸出的 [mm:ss] 逐字稿，時間加上分段起點；回傳 [(秒, 文字)]。
    第一個時間行之前的開場白捨棄，沒有時間的行沿用前一行的時間。"""
    lines, last, started = [], 0, False
    for raw in text.splitlines():
        raw = raw.strip().strip('*').strip()
        if not raw or raw.startswith('```'):
            continue
        m = TS_LINE_RE.match(raw)
        if m:
            h, mi, sec, body = m.groups()
            # 時間不倒退、不超過分段長度 (模型偶爾標錯)
            last = min(max(int(h or 0) * 3600 + int(mi) * 60 + int(sec), last), int(length))
            started = True
            raw = body.strip()
        if started and raw:
            lines.append((offset + last, raw))
    if not started:
        raise AgyError(f'agy 輸出不是 [mm:ss] 格式的逐字稿：{text.strip()[:150]}')
    return lines


class AgyTranscriber:
    """把音檔切成 chunk_minutes 分鐘的段落，同時交給 agy (雲端 Gemini) 轉寫，再依時間合併。
    單一檔案太長時 agy 容易逾時或漏段，因此分段處理。"""

    def __init__(self, model, concurrency, chunk_minutes):
        from opencc import OpenCC

        self.agy = shutil.which('agy')
        if not self.agy:
            sys.exit('❌ 找不到 agy，請先安裝 Antigravity CLI 並加入 PATH')
        self.model = model
        self.concurrency = concurrency
        self.chunk_seconds = chunk_minutes * 60
        self.cc = OpenCC('s2twp')  # 保證輸出為台灣繁體
        print(f'🤖 轉錄模型: {model} (agy)，每 {chunk_minutes} 分鐘一段，同時處理 {concurrency} 段\n')

    def split(self, audio_path):
        """切成多段 mp3，回傳 [(路徑, 起點秒數, 長度秒數)]。"""
        parts_dir = WORK / f'{audio_path.stem}_parts'
        shutil.rmtree(parts_dir, ignore_errors=True)
        parts_dir.mkdir(parents=True)
        listing = parts_dir / 'parts.csv'
        run([ffmpeg_exe(), '-y', '-loglevel', 'error', '-i', str(audio_path), '-f', 'segment',
             '-segment_time', str(self.chunk_seconds), '-segment_list', str(listing),
             '-segment_list_type', 'csv', '-c', 'copy', str(parts_dir / 'part_%03d.mp3')], timeout=600)
        parts = []
        for line in listing.read_text(encoding='utf-8').splitlines():
            name, start, end = line.rsplit(',', 2)
            parts.append((parts_dir / name, float(start), float(end) - float(start)))
        if not parts:
            raise RuntimeError('音檔切段失敗 (ffmpeg 沒有產生任何段落)')
        return parts

    def prompt(self, part, out, ev, lang, index, total, length):
        language = '英文原文，不要翻譯' if lang == 'en' else '台灣繁體中文'
        return (
            f'請聆聽 {part} 這個音檔，它是「{ev.code} {ev.name}」法人說明會錄音的第 {index}/{total} 段，'
            f'長度約 {fmt_ts(length)}。請完整逐字轉寫：\n'
            f'- 使用{language}，忠實記錄說話內容，不要摘要、改寫或省略；聽不清楚的地方標註「（聽不清）」。\n'
            '- 內容包含營收、毛利率、展望等財務用語，公司名稱與專有名詞請依上下文判斷。\n'
            '- 約每 30 秒到 1 分鐘換一行，行首標示該行在「這個音檔」中的開始時間，格式為 [mm:ss]，'
            '例如：[03:15] 接下來說明第三季的營收狀況。\n'
            '- 只寫逐字稿本文，不要開場白、結尾說明或 Markdown 標題。\n'
            f'請用寫檔工具把逐字稿寫入 {out}，不要建立或修改其他檔案。'
        )

    def run_agy(self, part, ev, lang, index, total, length):
        """轉寫一段；優先讀 agy 寫入的檔案 (部分 agy 版本非終端機執行時 stdout 為空)，否則用 stdout。"""
        out = part.with_suffix('.txt')
        cmd = [self.agy, '-p', self.prompt(part, out, ev, lang, index, total, length),
               '--model', self.model, '--dangerously-skip-permissions', '--add-dir', str(part.parent)]
        last_error = None
        for attempt in range(AGY_RETRIES + 1):
            out.unlink(missing_ok=True)
            try:
                # stdin 必須關閉，否則 agy 會等待終端機輸入而卡住
                p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                   encoding='utf-8', errors='replace', timeout=AGY_TIMEOUT_SECONDS)
                if p.returncode != 0:
                    raise AgyError(f'agy 結束代碼 {p.returncode}：{(p.stderr or p.stdout).strip()[-300:]}')
                text = out.read_text(encoding='utf-8') if out.exists() else ''
                return parse_transcript(text if text.strip() else p.stdout, 0, length)
            except subprocess.TimeoutExpired:
                last_error = AgyError(f'agy 逾時 (超過 {AGY_TIMEOUT_SECONDS // 60} 分鐘)')
            except AgyError as e:
                last_error = e
            if attempt < AGY_RETRIES:
                time.sleep(10)
        raise AgyError(f'第 {index}/{total} 段：{last_error}')

    def transcribe(self, audio_path, ev, url):
        lang = 'en' if re.search(r'_en\b', url) else 'zh'
        parts = self.split(audio_path)
        try:
            with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
                futures = [pool.submit(self.run_agy, part, ev, lang, i + 1, len(parts), length)
                           for i, (part, _, length) in enumerate(parts)]
                try:
                    results = [f.result() for f in futures]
                except BaseException:
                    for f in futures:
                        f.cancel()  # 有一段失敗就不再開始其餘段落，省下 agy 額度
                    raise
        finally:
            shutil.rmtree(parts[0][0].parent, ignore_errors=True)

        lines = []
        for (_, start, _), result in zip(parts, results):
            for sec, text in result:
                lines.append(f'[{fmt_ts(start + sec)}] {self.cc.convert(text) if lang == "zh" else text}')
        duration = parts[-1][1] + parts[-1][2]
        header = [
            f'公司：{ev.code} {ev.name}',
            f'日期：{ev.date_text} {ev.time}',
            f'摘要：{ev.summary}',
            f'來源：{url}',
            f'長度：{fmt_ts(duration)}',
            f'轉錄模型：{self.model}',
            '',
        ]
        return '\n'.join(header + lines) + '\n'


# ===== 主流程 =====

def plan(events, manifest, out_dir, redo_keys, limit):
    """依 manifest 與既有檔案篩選本次要處理的場次。"""
    todo = []
    counts = {'已完成': 0, '補登已完成': 0, '尚未召開或無影音': 0, '等待重試': 0, '放棄': 0}
    for ev in events:
        txt = out_dir / f'{ev.stem}.txt'
        if ev.key in redo_keys:
            manifest.pop(ev.key, None)  # 強制重做：清掉舊紀錄，成功後覆蓋舊逐字稿
        elif manifest.get(ev.key, {}).get('status') == 'done':
            counts['已完成'] += 1
            continue
        elif txt.exists() or txt.with_suffix('.md').exists():
            # 逐字稿或摘要已在但 manifest 沒記到（例如上次存檔前中斷），補登紀錄
            manifest[ev.key] = {'code': ev.code, 'name': ev.name, 'date': str(ev.date),
                                'status': 'done', 'file': f'{out_dir.name}/{txt.name}'}
            counts['補登已完成'] += 1
            continue

        if ev.date > TODAY or not ev.urls:
            counts['尚未召開或無影音'] += 1
            continue  # 下次再試
        blocker = retry_blocker(manifest.get(ev.key, {}), ev.urls)
        if blocker:
            counts['等待重試' if blocker.endswith('後重試') else '放棄'] += 1
            continue
        todo.append(ev)
    print('、'.join(f'{k} {v} 場' for k, v in counts.items()))
    return todo[:limit] if limit else todo, counts['補登已完成']


def process(todo, manifest, manual, out_dir, transcriber, opts):
    def first_live_url(ev):
        """與下方主迴圈相同的連結判斷 (手動指定的來源不算失效)，回傳第一個會嘗試的連結。"""
        dead = set(manifest.get(ev.key, {}).get('dead_urls', [])) - set(manual.get(ev.key, []))
        return next((u for u in ev.urls if u not in dead), None)

    # 一次只轉錄一場；下載走背景執行緒，預先抓後面 download_workers 場，轉錄時不必等下載。
    # 只預先下載每場的第一個連結，失敗改用備援連結時仍在主迴圈當場下載。
    pool = ThreadPoolExecutor(max_workers=opts.download_workers)
    prefetched = {}  # todo 索引 → (url, future)

    def prefetch(i):
        if i < len(todo) and i not in prefetched:
            url = first_live_url(todo[i])
            if url:
                prefetched[i] = (url, pool.submit(download_audio, url, todo[i].stem, opts))

    stats = {'done': 0, 'failed': 0}
    agy_failures = 0  # 連續因 agy 失敗的場次
    try:
        for i, ev in enumerate(todo):
            print(f'🎙️ ({i + 1}/{len(todo)}) {ev.stem}')
            for j in range(i, i + opts.download_workers + 1):
                prefetch(j)
            ahead_url, ahead = prefetched.pop(i, (None, None))

            rec = manifest.setdefault(ev.key, {'code': ev.code, 'name': ev.name, 'date': str(ev.date)})
            own = set(manual.get(ev.key, []))
            rec['dead_urls'] = [u for u in rec.get('dead_urls', []) if u not in own]
            if has_new_urls(rec, ev.urls):
                rec['attempts'] = 0  # 出現新連結，重新計算嘗試次數
            rec['attempts'] = rec.get('attempts', 0) + 1
            rec['last_attempt'] = dt.datetime.now(TZ).isoformat(timespec='seconds')
            rec['urls'] = ev.urls
            errors = []
            succeeded = agy_failed = False
            for url in live_urls(rec, ev.urls):
                try:
                    t0 = time.time()
                    audio = ahead.result() if url == ahead_url else download_audio(url, ev.stem, opts)
                    try:
                        text = transcriber.transcribe(audio, ev, url)
                    finally:
                        audio.unlink(missing_ok=True)
                    body_chars = len(text.partition('\n\n')[2])
                    if body_chars < MIN_TRANSCRIPT_CHARS:
                        length = re.search(r'長度：(\S+)', text).group(1)
                        raise RuntimeError(f'逐字稿過短（{body_chars} 字，音檔長度 {length}），'
                                           '可能是靜音、片頭音樂、抓錯影片或下載不完整')
                    txt = out_dir / f'{ev.stem}.txt'
                    txt.write_text(text, encoding='utf-8')
                    for k in ('error', 'tried_urls', 'dead_urls', 'urls'):
                        rec.pop(k, None)
                    rec.update(status='done', url=url, file=f'{out_dir.name}/{txt.name}',
                               updated=dt.datetime.now(TZ).isoformat(timespec='seconds'))
                    stats['done'] += 1
                    succeeded = True
                    print(f'✅ {ev.stem}（{time.time() - t0:.0f}s）')
                    break
                except AgyError as e:
                    # 不是連結的問題：不記為已嘗試 (下次執行直接重試)，也不改用備援連結浪費 agy 額度
                    agy_failed = True
                    errors.append(f'[agy] {url} → {short_error(str(e))[:300]}')
                    break
                except Exception as e:
                    message = str(e)
                    rec['tried_urls'] = list(dict.fromkeys(rec.get('tried_urls', []) + [url]))
                    # 手動指定的來源不標成失效，修正後重跑就會再試
                    permanent = url not in own and is_permanent_error(url, message)
                    if permanent:
                        rec['dead_urls'] = list(dict.fromkeys(rec.get('dead_urls', []) + [url]))
                    # 每個連結各記一行關鍵錯誤，避免手動來源的錯誤被後面備援連結的訊息蓋掉
                    errors.append(f'[{"永久" if permanent else "暫時"}] {url} → {short_error(message)[:300]}')
            if not succeeded:
                rec.update(status='failed', error='\n'.join(errors) or '無可用連結')
                stats['failed'] += 1
                print(f'❌ {ev.stem}')
                for err in errors or ['無可用連結']:
                    print(f'   {err[:250]}')
            save_manifest(manifest)

            agy_failures = agy_failures + 1 if agy_failed else 0
            if agy_failures >= MAX_CONSECUTIVE_AGY_FAILURES:
                print(f'\n⛔ 連續 {agy_failures} 場 agy 轉寫失敗，可能已達 agy 額度上限，停止執行；'
                      '稍後重跑會從未完成的場次繼續。')
                break
    finally:
        # 中斷時取消尚未開始的下載 (已開始的會跑完，殘留音檔下次下載同場時會先清掉)
        pool.shutdown(wait=False, cancel_futures=True)
    return stats


def show_failed(manual):
    """列出 manifest 中失敗的場次，以及下次執行會不會重試。"""
    failed = {k: v for k, v in load_manifest().items() if v.get('status') == 'failed'}
    if not failed:
        print('沒有失敗的場次')
        return
    for key, rec in sorted(failed.items(), key=lambda kv: kv[1].get('date', '')):
        if 'urls' not in rec and key not in manual:
            action = '下次執行重新判斷'  # 舊版紀錄沒有 urls
        else:
            action = retry_blocker(rec, apply_manual_sources(manual, key, rec.get('urls', []))) or '下次執行會重試'
        print(f'❌ {key} {rec.get("name", "")}  嘗試 {rec.get("attempts", 0)} 次，'
              f'最後 {rec.get("last_attempt", "-")}，{action}')
        for line in rec.get('error', '').splitlines():
            print(f'   {line}')
    print(f'\n共 {len(failed)} 場失敗')


def parse_args():
    parser = argparse.ArgumentParser(
        prog='npm run transcribe:earnings --',
        description='法說會影音 → 逐字稿：抓取公開資訊觀測站法說會影音，交給 agy (雲端 Gemini) 轉成逐字稿存到 ./EarningsCall/<YYYYMM>/',
        epilog='手動補抓的音檔放到 ./EarningsCall/audio/ 並命名為 公司名稱(代號)-YYYYMMDD.副檔名 (可用 npm run rename:audio)，'
               '會優先於觀測站連結使用。',
    )
    parser.add_argument('--month', '-m', help='要抓的月份 YYYYMM，預設當月 (台北時間)')
    parser.add_argument('--markets', default=','.join(MARKETS),
                        help=f'市場，逗號分隔：sii 上市、otc 上櫃、rotc 興櫃、pub 公開發行 (預設: {",".join(MARKETS)})')
    parser.add_argument('--codes', default='', help='只處理特定股票代號，逗號分隔，例如 2330,2317')
    parser.add_argument('--redo', action='append', default=[], metavar='代號_YYYYMMDD',
                        help='強制重做的場次，可重複指定，例如 --redo 2330_20261015')
    parser.add_argument('--url', action='append', default=[], metavar='代號_YYYYMMDD=來源',
                        help='手動指定影音來源 (觀測站連結錯誤或 YouTube 被擋時)，優先於觀測站連結嘗試；'
                             '可為網址、Google Drive 分享連結或本地檔案路徑，可重複指定')
    parser.add_argument('--limit', '-n', type=int, help='本次最多處理幾場 (測試用)')
    parser.add_argument('--model', default=AGY_MODEL, help=f'agy 模型 (預設: {AGY_MODEL})，可用 agy models 查詢')
    parser.add_argument('--concurrency', '-c', type=int, default=AGY_CONCURRENCY,
                        help=f'同時交給 agy 轉寫幾段 (預設: {AGY_CONCURRENCY})，遇到 agy 額度限制可調低為 1')
    parser.add_argument('--chunk-minutes', type=int, default=CHUNK_MINUTES,
                        help=f'每段音檔長度，分鐘 (預設: {CHUNK_MINUTES})')
    parser.add_argument('--download-workers', type=int, default=DOWNLOAD_WORKERS,
                        help=f'轉錄時背景預先下載幾場 (預設: {DOWNLOAD_WORKERS})')
    parser.add_argument('--cookies', help='YouTube 要求登入驗證時使用的 cookies.txt 路徑')
    parser.add_argument('--cookies-from-browser', metavar='BROWSER',
                        help='改從瀏覽器讀取 YouTube cookies，例如 firefox')
    parser.add_argument('--failed', action='store_true', help='只列出失敗的場次與下次是否重試，不執行轉錄')
    parser.add_argument('--no-sync', action='store_true', help='manifest 只存本地，不與雲端 (Colab) 同步')
    args = parser.parse_args()

    if args.month:
        if not re.fullmatch(r'\d{4}(0[1-9]|1[0-2])', args.month):
            parser.error(f'--month 格式須為 YYYYMM：{args.month}')
        args.year, args.mon = int(args.month[:4]), int(args.month[4:])
    else:
        args.year, args.mon = TODAY.year, TODAY.month
    args.markets = [m.strip() for m in args.markets.split(',') if m.strip()]
    args.codes = {c.strip() for c in args.codes.split(',') if c.strip()}
    for flag in ('download_workers', 'concurrency', 'chunk_minutes'):
        if getattr(args, flag) < 1:
            parser.error(f'--{flag.replace("_", "-")} 必須為正整數')
    return args


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    global _prune_month
    args = parse_args()
    manual = manual_sources(args.url)
    connect_cloud(not args.no_sync)

    if args.failed:
        show_failed(manual)
        return

    out_dir = EARNINGS_ROOT / f'{args.year}{args.mon:02d}'
    for d in (out_dir, WORK):
        d.mkdir(parents=True, exist_ok=True)
    print('=====================================================')
    print('  🎙️ 法說會影音 → 逐字稿')
    print('=====================================================')
    print(f'📁 輸出目錄:   {out_dir}')
    print(f'📋 Manifest:   {MANIFEST_PATH}' + (f'（與雲端 {"/".join(CLOUD_EARNINGS_PATH)} 同步）' if _cloud else ''))
    print()

    cli_keys = {arg.partition('=')[0] for arg in args.url}
    events = fetch_events(args.year, args.mon, args.markets, args.codes, manual, cli_keys)

    manifest = load_manifest()
    _prune_month = (args.year, args.mon)
    pruned = prune_manifest(manifest, args.year, args.mon)
    todo, backfilled = plan(events, manifest, out_dir, set(args.redo), args.limit)
    if pruned or backfilled or _cloud:
        save_manifest(manifest)  # 同步時一併把本地獨有的紀錄寫回雲端
    print(f'manifest 清除 {pruned} 筆過期紀錄；本次待處理 {len(todo)} 場\n')
    if not todo:
        return

    t0 = time.time()
    transcriber = AgyTranscriber(args.model, args.concurrency, args.chunk_minutes)
    stats = process(todo, manifest, manual, out_dir, transcriber, args)

    print('\n=====================================================')
    print(f'  🎉 完成！耗時 {(time.time() - t0) / 60:.1f} 分鐘')
    print('=====================================================')
    print(f'✅ 新增逐字稿: {stats["done"]}')
    if stats['failed']:
        print(f'❌ 失敗:       {stats["failed"]} (npm run transcribe:earnings -- --failed 查看原因)')
    if stats['done']:
        print('\n💡 執行 npm run summarize:earnings 可產生摘要。')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\n⏹️ 已中斷；重跑會從未完成的場次繼續。')
