// 아이폰 기본 사진(HEIC)은 sharp도 네이버도 바로 못 읽어서 JPG로 바꿔 쓴다.
// 바꾼 파일은 %LOCALAPPDATA%\BlogWriter\converted 에 두고 다시 쓴다. 드라이브의 원본은 건드리지 않는다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import decode from "heic-decode";
import sharp from "sharp";
import { DATA_DIR } from "./config.js";

const CONVERTED_DIR = path.join(DATA_DIR, "converted");
export const isHeic = (file) => /\.(heic|heif)$/i.test(file);

// 그대로 읽을 수 있는 파일 경로를 돌려준다. HEIC면 JPG로 바꾼 파일 경로
export async function readable(file) {
  if (!isHeic(file)) return file;
  const key = crypto.createHash("md5").update(file + fs.statSync(file).mtimeMs).digest("hex");
  const out = path.join(CONVERTED_DIR, `${key}.jpg`);
  if (!fs.existsSync(out)) {
    const image = await decode({ buffer: fs.readFileSync(file) });
    fs.mkdirSync(CONVERTED_DIR, { recursive: true });
    await sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).jpeg({ quality: 90 }).toFile(out);
  }
  return out;
}
