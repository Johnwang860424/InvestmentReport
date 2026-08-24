import { execSync } from 'child_process';
import * as path from 'path';

export class CaptchaService {
  /**
   * 透過 agy CLI 進行圖片驗證碼視覺辨識
   * @param imagePath 驗證碼圖片檔案路徑
   * @param expectedDigits 預期數字長度 (預設 5)
   */
  public static recognize(imagePath: string, expectedDigits: number = 5): string | null {
    console.log(`🤖 [Captcha] 正在透過 agy CLI 辨識圖片: ${path.basename(imagePath)}...`);
    try {
      const absPath = path.resolve(imagePath);
      const prompt = `請讀取 ${absPath} 這張圖片中的驗證碼，只輸出${expectedDigits}位數字結果，不要輸出任何其他說明文字或標點符號`;
      const cmd = `agy --dangerously-skip-permissions -p "${prompt}"`;

      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 60000,
        shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
      });
      const code = this.extractCode(output, expectedDigits);

      if (code) {
        console.log(`✅ [Captcha] 辨識成功: ${code}`);
        return code;
      }

      console.warn(`⚠️ [Captcha] 未能從輸出中提取${expectedDigits}位數字，原始輸出: ${output.trim()}`);
      return null;
    } catch (err: any) {
      console.error(`❌ [Captcha] agy CLI 辨識失敗:`, err.message);
      return null;
    }
  }

  /**
   * 從 CLI 輸出中擷取驗證碼。
   * 只接受剛好 expectedDigits 位的數字，並取最後一個符合者
   * (模型若加了說明文字，答案通常在句尾，前面的數字多半是年份等雜訊)。
   */
  private static extractCode(output: string, expectedDigits: number): string | null {
    const exact = [...output.matchAll(new RegExp(`(?<!\\d)\\d{${expectedDigits}}(?!\\d)`, 'g'))];
    if (exact.length > 0) {
      return exact[exact.length - 1][0];
    }
    return null;
  }
}
