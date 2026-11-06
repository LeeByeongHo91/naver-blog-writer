// 문제가 생겼을 때 원인을 찾을 수 있게 진행 기록을 파일로 남기고, 프로그램을 준 사람에게 보낼 보고서를 만든다.
// 기록과 보고서에는 API 키와 윈도우 사용자 이름을 남기지 않는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { DATA_DIR } from "./config.js";

const LOG_FILE = path.join(DATA_DIR, "app.log");
const REPORT_FILE = path.join(DATA_DIR, "블로그글생성기_문제보고.txt");
const MAX_LOG = 1024 * 1024;
const REPORT_LINES = 200;

const hide = (text) => text.replace(/sk-ant-[\w-]+/g, "(API 키)").replaceAll(os.homedir(), "%USERPROFILE%");

// console.log와 console.error로 나가는 내용을 파일에도 남긴다. 파일이 커지면 뒤쪽 절반만 남긴다
export function keepLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG) {
    fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE).subarray(-MAX_LOG / 2));
  }
  for (const level of ["log", "error"]) {
    const print = console[level];
    console[level] = (...args) => {
      print(...args);
      try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString("ko-KR")}] ${hide(util.format(...args))}\n`, "utf8");
      } catch {}
    };
  }
  process.on("uncaughtExceptionMonitor", (error) => console.error("프로그램이 멈췄습니다:", error));
}

function apiKeyState(config) {
  if (config.apiKey) return config.apiKeySealed ? "있음 (잠김)" : "있음 (잠그지 못함)";
  return config.apiKeySealed ? "잠긴 키를 풀지 못함 (이 PC에서 다시 넣어야 합니다)" : "없음";
}

function freeSpace() {
  try {
    const { bavail, bsize } = fs.statfsSync(DATA_DIR);
    return `${Math.round((bavail * bsize) / 1024 ** 3)}GB`;
  } catch {
    return "알 수 없음";
  }
}

// 프로그램에 꼭 필요한 구성 요소가 깔려 있는지 (없으면 '1_설치'를 다시 해야 한다)
function missingParts() {
  const here = import.meta.dirname;
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  const missing = Object.keys(dependencies).filter((name) => !fs.existsSync(path.join(here, "node_modules", name)));
  if (!fs.existsSync(path.join(here, "node_modules", "ffmpeg-static", "ffmpeg.exe"))) missing.push("ffmpeg.exe");
  const edge = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean).map((dir) => path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe"));
  if (!edge.some((file) => fs.existsSync(file))) missing.push("Microsoft Edge");
  return missing;
}

// 보고서를 파일로 만들고 그 경로를 돌려준다. jobError, updateError: 지금 화면에 떠 있는 오류 (없으면 빈 문자열)
export function writeReport({ version, config, users, latest, jobError, updateError }) {
  const missing = missingParts();
  const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").trimEnd().split(/\r?\n/).slice(-REPORT_LINES) : ["(기록 없음)"];
  const text = [
    "[블로그 글 생성기 문제 보고]",
    `만든 시각: ${new Date().toLocaleString("ko-KR")}`,
    `프로그램 버전: ${version} (GitHub 최신: ${latest.version ?? "확인 못 함"})`,
    `윈도우: ${os.version()} ${os.release()} · Node ${process.version}`,
    `메모리: ${Math.round(os.freemem() / 1024 ** 3)}GB 남음 / ${Math.round(os.totalmem() / 1024 ** 3)}GB · 디스크 여유: ${freeSpace()}`,
    `프로그램 폴더: ${path.join(import.meta.dirname, "..")}`,
    `빠진 구성 요소: ${missing.length ? missing.join(", ") : "없음"}`,
    "",
    "[설정]",
    `사용자 수: ${users}`,
    `API 키: ${apiKeyState(config)}`,
    `블로그 아이디: ${config.blogId ? "넣음" : "없음"}`,
    `사진 폴더: ${!config.photoFolder ? "없음" : fs.existsSync(config.photoFolder) ? "찾음" : "찾을 수 없음"}`,
    `인스타·쇼츠: ${config.social ? "켬" : "끔"} · 모자이크: ${config.mosaic ? "켬" : "끔"} · AI 목소리: ${config.shortsVoice ? "켬" : "끔"}`,
    ...(jobError ? ["", "[글 만들기 오류]", jobError] : []),
    ...(updateError ? ["", "[업데이트 오류]", updateError] : []),
    "",
    `[최근 기록 ${log.length}줄]`,
    ...log,
  ].join("\n");
  fs.writeFileSync(REPORT_FILE, hide(text) + "\n", "utf8");
  return REPORT_FILE;
}
