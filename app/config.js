import fs from "node:fs";
import path from "node:path";

// 설정, 로그인 정보, 사용한 사진 기록은 프로그램 폴더가 아니라 이 PC의 사용자 폴더에 둔다
// (프로그램 폴더를 남에게 복사해 줘도 API 키, 로그인 정보, 말투 예시가 딸려 가지 않게)
export const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? process.cwd(), "BlogWriter");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const PROGRAM_DIR = path.join(import.meta.dirname, "..");

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]); // HEIC(아이폰)는 media.js가 JPG로 바꿔 쓴다
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".wmv", ".mkv"]);
export const isVideo = (file) => VIDEO_EXTS.has(path.extname(file).toLowerCase());

export const DEFAULTS = {
  apiKey: "",
  blogId: "",
  photoFolder: "",
  mode: "batch", // batch: 폴더에서 N장씩 / subfolder: 하위 폴더 하나가 글 하나
  photosPerPost: 10,
  order: "name", // name | oldest | newest
  askEachTime: true,
  reviewFirst: true, // AI가 쓴 글을 네이버에 넣기 전에 화면에서 먼저 보고 고친다
  blogAbout: "", // 어떤 블로그이고 누가 읽는지. AI가 글의 관점과 독자를 정할 때 쓴다
  topic: "",
  memo: "",
  tone: "친근하고 발랄한 말투 (~했어요, ~더라고요). 이모지를 적당히 사용",
  length: "사진마다 3~5문장",
  fixedHashtags: "",
  styleSamples: [], // 블로그 주인이 직접 쓴 글(네이버에서 복사한 그대로). 있으면 말투·길이 설정보다 우선
  headerImages: [], // 글 맨 위(제목 바로 아래)에 항상 넣을 이미지의 파일 이름. 파일은 userPaths().header 폴더에 있다
  footer: "", // 글 끝(마무리 글과 해시태그 사이)에 항상 붙일 내용. 주소만 있는 줄은 링크 카드, "지도:" 줄은 네이버 지도
  naverTemplate: "", // 네이버 글쓰기의 '내 템플릿' 이름. 있으면 글 맨 아래(해시태그 앞)에 그 템플릿을 넣는다
  replaceWords: [], // [{ from: "선생님", to: "사범님" }] AI에게 시키고, 다 쓴 글에서도 한 번 더 바꾼다
  repeatPhrases: [], // [{ text: "행궁동 ○○카페", times: "2~3" }] 본문에 이만큼 넣게 하고, 몇 번 들어갔는지 알려 준다
  aiRequests: "", // 그 밖에 매번 AI에게 하는 부탁
};

// ---------- 사용자(블로그) ----------
// 한 PC에서 여러 사람(여러 네이버 블로그)이 쓸 수 있게, 설정·사용한 사진 기록·네이버 로그인·만든 글을 사용자마다 따로 둔다.
// 첫 사용자("main")는 예전 버전과 같은 자리(DATA_DIR 바로 아래)를 그대로 쓰고, 추가한 사용자는 DATA_DIR\users\<id>에 둔다.

function userDir(id) {
  return id === "main" ? DATA_DIR : path.join(DATA_DIR, "users", id);
}

export function userPaths(id = currentUser().id) {
  const dir = userDir(id);
  return {
    config: path.join(dir, "config.json"),
    used: path.join(dir, "used.json"),
    profile: path.join(dir, "browser-profile"), // 네이버 로그인이 남는 Edge 프로필
    posts: path.join(dir, "posts"), // 만든 글 백업
    usage: path.join(dir, "usage.json"), // AI 사용료 기록
    header: path.join(dir, "header-images"), // 글 맨 위에 항상 넣을 이미지 (설정에서 넣은 것을 복사해 둔다)
  };
}

export function loadUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(USERS_PATH)) return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  const users = { current: "main", list: [{ id: "main", name: migrateOldVersion() }] };
  saveUsers(users);
  return users;
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), "utf8");
}

export function currentUser() {
  const users = loadUsers();
  return users.list.find((u) => u.id === users.current) ?? users.list[0];
}

export function addUser(name, copyApiKey) {
  const users = loadUsers();
  const apiKey = copyApiKey ? loadConfig().apiKey : "";
  const id = "u" + Date.now().toString(36);
  users.list.push({ id, name });
  users.current = id;
  saveUsers(users);
  saveConfig({ ...DEFAULTS, apiKey }, id);
  return id;
}

export function switchUser(id) {
  const users = loadUsers();
  if (!users.list.some((u) => u.id === id)) throw new Error("그 사용자를 찾을 수 없습니다.");
  users.current = id;
  saveUsers(users);
}

export function renameUser(id, name) {
  const users = loadUsers();
  const user = users.list.find((u) => u.id === id);
  if (!user) throw new Error("그 사용자를 찾을 수 없습니다.");
  user.name = name;
  saveUsers(users);
}

export function removeUser(id) {
  if (id === "main") throw new Error("첫 번째 사용자는 지울 수 없습니다. 이름과 설정을 바꿔서 쓰세요.");
  const users = loadUsers();
  users.list = users.list.filter((u) => u.id !== id);
  if (users.current === id) users.current = users.list[0].id;
  saveUsers(users);
  fs.rmSync(userDir(id), { recursive: true, force: true });
}

// 사용자 기능이 생기기 전 버전에서 넘어올 때 한 번만 한다. 예전 설정은 첫 사용자의 것이 된다.
// 예전에는 API 키(Claude_API_키.txt)와 말투 예시(*말투 폴더)를 프로그램 폴더에서 읽었는데,
// 그러면 폴더를 남에게 줄 때 같이 넘어가므로 이 PC의 설정 안으로 옮겨 담는다. 돌려주는 값은 첫 사용자의 이름.
function migrateOldVersion() {
  const file = userPaths("main").config;
  if (!fs.existsSync(file)) return "내 블로그";
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const keyFile = path.join(PROGRAM_DIR, "Claude_API_키.txt");
  if (!config.apiKey && fs.existsSync(keyFile)) config.apiKey = fs.readFileSync(keyFile, "utf8").replace(/^﻿/, "").trim();
  if (!config.styleSamples) config.styleSamples = readStyleFolders();
  // 예전 버전은 글 형식 안내에 태권도장·학부모님이 박혀 있었다. 그 버전을 쓰던 곳은 태권도장 블로그뿐이라 그대로 옮겨 적는다
  if (config.blogAbout === undefined) config.blogAbout = "태권도장 관장이 운영하는 도장 블로그입니다. 읽는 사람은 주로 도장에 다니는(또는 다닐) 아이의 학부모님입니다.";
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return config.blogId || "내 블로그";
}

// 프로그램 폴더에서 이름이 "말투"로 끝나는 폴더 안의 txt (예전 버전에서 말투 예시를 두던 곳)
function readStyleFolders() {
  const samples = [];
  for (const dir of fs.readdirSync(PROGRAM_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.endsWith("말투")) continue;
    const folder = path.join(PROGRAM_DIR, dir.name);
    for (const name of fs.readdirSync(folder).filter((n) => n.toLowerCase().endsWith(".txt")).sort()) {
      const text = fs.readFileSync(path.join(folder, name), "utf8").replace(/^﻿/, "").trim();
      if (text) samples.push(text);
    }
  }
  return samples;
}

// ---------- 지금 사용자의 설정과 기록 ----------

export function loadConfig(id) {
  const file = userPaths(id).config;
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return { ...DEFAULTS, ...saved };
}

export function saveConfig(config, id) {
  const file = userPaths(id).config;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

export function loadUsed(id) {
  const file = userPaths(id).used;
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function markUsed(paths, id) {
  const used = new Set(loadUsed(id));
  for (const p of paths) used.add(p);
  fs.writeFileSync(userPaths(id).used, JSON.stringify([...used], null, 2), "utf8");
}

// AI를 한 번 쓸 때마다 남긴다. kind: "new"(새 글) | "rewrite"(다시 쓰기)
export function recordUsage(won, kind, id) {
  const file = userPaths(id).usage;
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  list.push({ at: new Date().toISOString(), won, kind });
  fs.writeFileSync(file, JSON.stringify(list), "utf8");
}

// 이번 달과 지난달에 만든 글 수와 사용료 (실제 청구 금액은 platform.claude.com의 Billing이 정확하다)
export function usageSummary(id) {
  const file = userPaths(id).usage;
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const now = new Date();
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const sum = (key) => {
    const items = list.filter((u) => monthKey(new Date(u.at)) === key);
    return { posts: items.filter((u) => u.kind === "new").length, won: items.reduce((t, u) => t + u.won, 0) };
  };
  return {
    thisMonth: sum(monthKey(now)),
    lastMonth: sum(monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1))),
    total: { posts: list.filter((u) => u.kind === "new").length, won: list.reduce((t, u) => t + u.won, 0) },
  };
}

// 지난 글 목록 (새 글부터). 파일 첫 줄이 제목, 파일 이름이 만든 시각
export function listPosts(id) {
  const dir = userPaths(id).posts;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^[\w-]+\.txt$/.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
      const title = fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)[0].trim();
      return { name, title: title || "(제목 없음)", date: m ? `${m[1]}.${Number(m[2])}.${Number(m[3])} ${m[4]}:${m[5]}` : "" };
    });
}

export function readPost(name, id) {
  if (!/^[\w-]+\.txt$/.test(name ?? "")) return null;
  const file = path.join(userPaths(id).posts, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function listImages(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(folder, e.name));
}

// 글에 넣을 수 있는 파일(사진 + 동영상)
export function listMedia(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() && (IMAGE_EXTS.has(path.extname(e.name).toLowerCase()) || isVideo(e.name)))
    .map((e) => path.join(folder, e.name));
}

// 설정 '내 글 예시'에 넣어 둔 블로그 주인의 글을 AI에게 보여 줄 모양으로 다듬는다
export function loadStyleSamples(config) {
  return (config.styleSamples ?? []).map(cleanSample).filter(Boolean);
}

// 네이버 화면에서 복사한 글은 줄마다 빈 줄이 하나씩 끼어 있다. 빈 줄 1개는 줄바꿈, 2개 이상은 문단 사이 여백으로 되돌린다.
function cleanSample(raw) {
  let text = String(raw ?? "").replace(/^﻿/, "");
  const marker = text.indexOf("이웃본문 기타 기능"); // 이 줄 위는 블로그 메뉴와 작성자 정보
  if (marker >= 0) text = text.slice(marker + "이웃본문 기타 기능".length);
  const out = [];
  let blanks = 0;
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) { blanks++; continue; }
    if (out.length && blanks >= 2) out.push("");
    out.push(line);
    blanks = 0;
  }
  return out.join("\n");
}

export function listSubfolders(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(folder, e.name));
}
