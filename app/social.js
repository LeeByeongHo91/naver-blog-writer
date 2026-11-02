// 인스타그램용 사진(4:5)과 유튜브 쇼츠·인스타 릴스용 세로 영상(9:16 슬라이드)을 이 PC에서 만든다. AI 사용료는 들지 않는다.
// 영상은 ffmpeg(npm ffmpeg-static)로 만든다. 자막 글자는 윈도우 기본 글꼴(맑은 고딕)로 그린다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const FONT_DIR = path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
const FONT_FILE = ["malgunbd.ttf", "malgun.ttf"].map((n) => path.join(FONT_DIR, n)).find((f) => fs.existsSync(f));

const W = 1080, H = 1920; // 쇼츠 화면
const FPS = 30;
const FADE = 0.4; // 사진이 바뀔 때 겹치는 시간(초)

// 사진 한 장을 지정한 크기에 맞춘다. 비율이 비슷하면 꽉 채우고(조금 잘림), 많이 다르면 흐리게 늘린 같은 사진 위에 전체를 올린다
async function fitFrame(file, width, height, box = { width, height }) {
  const image = sharp(file, { failOn: "none" }).rotate();
  const meta = await sharp(await image.clone().toBuffer()).metadata();
  const ratio = meta.width / meta.height / (width / height);
  if (ratio > 0.82 && ratio < 1.22) return image.resize(width, height, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
  const back = await image.clone().resize(Math.round(width / 4), Math.round(height / 4), { fit: "cover" }).blur(12).modulate({ brightness: 0.7 }).resize(width, height).toBuffer();
  const front = await image.clone().resize(box.width, box.height, { fit: "inside" }).toBuffer({ resolveWithObject: true });
  return sharp(back)
    .composite([{ input: front.data, left: Math.round((width - front.info.width) / 2), top: Math.round((height - front.info.height) / 2.2) }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

// 인스타그램 게시물용 사진 (세로 4:5, 1080x1350). 만든 파일 경로 목록을 돌려준다
export async function instagramPhotos(files, dir) {
  const out = [];
  for (const [i, file] of files.entries()) {
    const target = path.join(dir, `인스타_${String(i + 1).padStart(2, "0")}.jpg`);
    fs.writeFileSync(target, await fitFrame(file, 1080, 1350));
    out.push(target);
  }
  return out;
}

// 화면에 올릴 글자 (흰 글자 + 반투명 검은 상자). 글자가 없으면 null
const escapeMarkup = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 영상 글자에는 이모지를 쓰지 않는다 (맑은 고딕에 없어서 네모로 나온다)
const plain = (t) => String(t ?? "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();

async function textLayer(text, size, centerY) {
  text = plain(text);
  if (!text) return null;
  // 한글은 글자 사이에서도 줄이 바뀌어서("얼굴/들") 글자 사이를 붙여 두고 띄어쓰기에서만 줄을 바꾼다 (U+2060은 보이지 않는 글자)
  const joined = text.replace(/(?<=\S)(?=\S)/gu, "⁠");
  const label = await sharp({
    text: { text: `<span foreground="white">${escapeMarkup(joined)}</span>`, font: `Malgun Gothic Bold ${size}`, fontfile: FONT_FILE, width: W - 200, align: "centre", wrap: "word-char", rgba: true, dpi: 72 },
  }).png().toBuffer({ resolveWithObject: true });
  const padX = 36, padY = 22;
  const bw = label.info.width + padX * 2, bh = label.info.height + padY * 2;
  const left = Math.round((W - bw) / 2), top = Math.round(centerY - bh / 2);
  const back = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}"><rect width="${bw}" height="${bh}" rx="26" fill="black" fill-opacity="0.55"/></svg>`);
  return [
    { input: back, left, top },
    { input: label.data, left: left + padX, top: top + padY },
  ];
}

// 사진 위에 얹을 투명한 글자 판 (제목은 위쪽, 자막은 아래쪽. 맨 아래는 유튜브 버튼에 가려서 비운다)
async function overlay({ title, caption, center }) {
  const parts = [
    ...((await textLayer(title, 72, 330)) ?? []),
    ...((await textLayer(caption, center ? 66 : 58, center ? H / 2 : 1380)) ?? []),
  ];
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
}

// ffmpeg 프로그램 위치. 설치 때 내려받기가 막혔으면 한 번 더 내려받아 본다
async function ffmpegPath() {
  let file = require("ffmpeg-static");
  if (file && fs.existsSync(file)) return file;
  const installer = path.join(path.dirname(require.resolve("ffmpeg-static")), "install.js");
  await run(process.execPath, [installer], { cwd: path.dirname(installer), timeout: 300000 }).catch(() => {});
  file = require("ffmpeg-static");
  if (file && fs.existsSync(file)) return file;
  throw new Error("영상 만드는 도구(ffmpeg)가 설치되지 않았습니다. 인터넷이 연결된 상태에서 '1_설치'를 다시 실행해 주세요.");
}

// 사진 슬라이드 영상 (세로 1080x1920, 30fps, 소리 없음). 사진마다 천천히 다가가는 움직임과 자막을 넣는다.
// slides: [{ file, caption }], title: 첫 화면 위쪽 제목, ending: 마지막 화면 문구. log: 진행 상황
export async function shortsVideo(slides, { title, ending }, target, log = () => {}) {
  if (!slides.length) throw new Error("영상에 넣을 사진이 없습니다.");
  const ffmpeg = await ffmpegPath();
  // 사진이 많으면 한 장을 짧게 보여 줘서 영상이 40초를 넘지 않게 한다
  const each = slides.length <= 6 ? 3 : slides.length <= 10 ? 2.6 : Math.max(1.8, 38 / slides.length);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "blogwriter-shorts-"));
  try {
    const parts = slides.map((s, i) => ({ ...s, title: i === 0 ? title : "", seconds: each }));
    if (plain(ending)) parts.push({ file: slides.at(-1).file, caption: ending, center: true, end: true, seconds: 2.2 });
    log(`쇼츠 영상 화면 ${parts.length}개를 그리는 중...`);
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const [i, part] of parts.entries()) {
      // 움직일 여유를 두고 두 배 크기로 그린다 (작게 그리면 움직임이 떨려 보인다)
      let frame = await fitFrame(part.file, W * 2, H * 2, { width: W * 2, height: Math.round(H * 1.5) });
      if (part.end) frame = await sharp(frame).blur(30).modulate({ brightness: 0.6 }).jpeg({ quality: 90 }).toBuffer();
      fs.writeFileSync(path.join(work, `p${i}.jpg`), frame);
      fs.writeFileSync(path.join(work, `t${i}.png`), await overlay(part));
      args.push("-loop", "1", "-framerate", String(FPS), "-t", String(part.seconds), "-i", `p${i}.jpg`, "-i", `t${i}.png`);
    }
    const total = parts.reduce((t, p) => t + p.seconds, 0) - FADE * (parts.length - 1);
    args.push("-f", "lavfi", "-t", total.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");
    const filters = [];
    for (const [i, part] of parts.entries()) {
      const frames = Math.round(part.seconds * FPS);
      const zoom = part.end ? "1" : `1+0.08*on/${frames}`;
      filters.push(
        `[${i * 2}:v]zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}[z${i}]`,
        `[z${i}][${i * 2 + 1}:v]overlay=0:0,format=yuv420p,setsar=1[s${i}]`,
      );
    }
    let last = "s0", offset = 0;
    for (let i = 1; i < parts.length; i++) {
      offset += parts[i - 1].seconds - FADE;
      filters.push(`[${last}][s${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}[x${i}]`);
      last = `x${i}`;
    }
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", `[${last}]`, "-map", `${parts.length * 2}:a`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-r", String(FPS), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", "out.mp4",
    );
    log(`쇼츠 영상(${Math.round(total)}초)을 만드는 중... 30초~1분쯤 걸립니다.`);
    await run(ffmpeg, args, { cwd: work, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }).catch((error) => {
      throw new Error(`영상을 만들지 못했습니다. ${String(error.stderr || error.message).trim().split(/\r?\n/).slice(-2).join(" ")}`);
    });
    fs.copyFileSync(path.join(work, "out.mp4"), target);
    return { seconds: Math.round(total) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
