// 쇼츠 영상의 AI 목소리: 윈도우에 기본으로 들어 있는 한국어 음성(Microsoft Heami)으로 글을 읽어 wav로 만든다.
// 이 PC 안에서만 만들고 사용료가 들지 않는다. 실제 읽기는 tts.ps1(윈도우 System.Speech)이 한다.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "tts.ps1");

// texts의 글마다 dir 안에 n0.wav, n1.wav ... 를 만들고 파일 이름을 돌려준다 (빈 글은 null)
export async function speak(texts, dir) {
  const jobs = texts.map((text, i) => (text?.trim() ? { text: text.trim(), out: path.join(dir, `n${i}.wav`) } : null));
  const list = jobs.filter(Boolean);
  if (!list.length) return jobs;
  const file = path.join(dir, "tts.json");
  fs.writeFileSync(file, JSON.stringify(list), "utf8");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Jobs", file], { timeout: 180000 }).catch((error) => {
    if (/NO_KOREAN_VOICE/.test(`${error.stdout}${error.stderr}`)) {
      throw new Error("이 PC에 한국어 음성이 없습니다. 윈도우 설정 → 시간 및 언어 → 음성 → 음성 추가에서 '한국어'를 추가해 주세요.");
    }
    throw new Error(`AI 목소리를 만들지 못했습니다. ${String(error.stderr || error.message).trim().split(/\r?\n/)[0]}`);
  });
  return jobs.map((job) => (job && fs.existsSync(job.out) ? path.basename(job.out) : null));
}

// wav 파일의 길이(초)
export function wavSeconds(file) {
  const data = fs.readFileSync(file);
  let byteRate = 0;
  for (let at = 12; at + 8 <= data.length; ) {
    const id = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    if (id === "fmt ") byteRate = data.readUInt32LE(at + 16);
    if (id === "data") return byteRate ? size / byteRate : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}
