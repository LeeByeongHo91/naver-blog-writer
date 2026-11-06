// PC를 바꿀 때 지금 사용자의 설정을 파일 하나로 옮긴다. 말투 예시, 글 끝 내용, 맨 위 이미지, 배경 음악, 고친 내용 기록, 이미 쓴 사진 기록이 들어간다.
// API 키는 넣지 않는다 (파일이 새도 키가 나가지 않게). 네이버 로그인과 지난 글도 옮기지 않는다
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DEFAULTS, loadConfig, saveConfig, userPaths, loadUsed } from "./config.js";
import { loadLearned } from "./learn.js";

const KIND = "blog-writer-settings";
const FILE = path.join(DATA_DIR, "블로그글생성기_설정_옮기기.json");
const SKIP = new Set(["apiKey"]);
const FOLDERS = {
  header: { key: "headerImages", exts: /\.(jpe?g|png|webp|gif|heic|heif)$/i },
  music: { key: "music", exts: /\.(mp3|m4a|aac|wav|ogg)$/i },
};
const safeName = (name) => /^[^\\/:*?"<>|]+$/.test(name) && !name.startsWith(".");

export function exportSettings(id) {
  const config = loadConfig(id);
  const files = {};
  for (const [kind, { key }] of Object.entries(FOLDERS)) {
    files[kind] = {};
    for (const name of config[key] ?? []) {
      const file = path.join(userPaths(id)[kind], name);
      if (fs.existsSync(file)) files[kind][name] = fs.readFileSync(file).toString("base64");
    }
  }
  const settings = Object.fromEntries(Object.keys(DEFAULTS).filter((key) => !SKIP.has(key)).map((key) => [key, config[key]]));
  fs.writeFileSync(FILE, JSON.stringify({ kind: KIND, settings, files, learned: loadLearned(id), used: loadUsed(id) }), "utf8");
  return FILE;
}

// 기본값과 같은 모양의 값만 받는다 (다른 사람이 만든 파일이어도 설정이 망가지지 않게)
const sameShape = (value, sample) => (Array.isArray(sample) ? Array.isArray(value) : typeof value === typeof sample);

// 지금 사용자의 설정을 파일 내용으로 바꾼다. API 키는 지금 것을 그대로 둔다
export function importSettings(text, id) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data?.kind !== KIND) throw new Error("이 프로그램에서 만든 설정 파일이 아닙니다.");
  const config = loadConfig(id);
  for (const [key, value] of Object.entries(data.settings ?? {})) {
    if (!SKIP.has(key) && key in DEFAULTS && sameShape(value, DEFAULTS[key])) config[key] = value;
  }
  for (const [kind, { key, exts }] of Object.entries(FOLDERS)) {
    const dir = userPaths(id)[kind];
    fs.mkdirSync(dir, { recursive: true });
    const names = Object.keys(data.files?.[kind] ?? {}).filter((name) => safeName(name) && exts.test(name));
    for (const name of names) fs.writeFileSync(path.join(dir, name), Buffer.from(String(data.files[kind][name]), "base64"));
    config[key] = (Array.isArray(config[key]) ? config[key] : []).filter((name) => names.includes(name));
  }
  saveConfig(config, id);
  if (Array.isArray(data.learned)) fs.writeFileSync(userPaths(id).learned, JSON.stringify(data.learned.slice(-20)), "utf8");
  if (Array.isArray(data.used)) fs.writeFileSync(userPaths(id).used, JSON.stringify(data.used.filter((p) => typeof p === "string")), "utf8");
  return { photoFolderFound: Boolean(config.photoFolder) && fs.existsSync(config.photoFolder) };
}
