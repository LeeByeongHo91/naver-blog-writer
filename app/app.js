// 프로그램 창: 사진을 골라 순서와 메모를 정하고, 설정하고, 블로그 글 만들기까지 한 화면에서 한다.
// 이 PC에서만 열리는 작은 웹 서버를 띄우고, Edge를 주소창 없는 앱 창으로 열어 보여 준다.
// 실행: node app.js (설정 화면부터 열려면 node app.js settings)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { loadConfig, saveConfig, listMedia, listSubfolders, loadUsed, markUsed, isVideo, DATA_DIR, userPaths, loadUsers, currentUser, addUser, switchUser, renameUser, removeUser } from "./config.js";
import { generatePost, explainError, toBlocks, sortFiles, FORMATS, checkApiKey } from "./generate.js";
import { isBlogId, recentPosts, postText } from "./blog.js";
import { VERSION, checkUpdate, updateInfo, applyUpdate } from "./update.js";
import { openEditor, writeDraft, screenshot } from "./naver.js";

const here = import.meta.dirname;
const PORT = 47813;
const MAX_PHOTOS = 20;
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
// 시험용: BLOGWRITER_DRY_RUN=1 이면 네이버에 입력만 하고 임시저장과 '사용함' 기록은 하지 않는다
const DRY_RUN = process.env.BLOGWRITER_DRY_RUN === "1";
// 시험용: BLOGWRITER_NO_WINDOW=1 이면 프로그램 창을 띄우지 않고, /api/quit 으로 끝낼 수 있다
const NO_WINDOW = process.env.BLOGWRITER_NO_WINDOW === "1";
const AFTER_UPDATE = process.argv.includes("--after-update");

// ---------- 폴더 고르기 (설정 화면) ----------

// 설정 화면 안에서 폴더를 눌러 가며 고를 수 있게, 한 폴더의 하위 폴더 목록을 돌려준다.
// (윈도우 폴더 선택 창은 구글 드라이브를 고를 수 없어서 쓰지 않는다)
function browse(folder) {
  if (!folder) {
    const places = [];
    const drive = guessDriveFolder();
    if (drive) places.push({ name: "구글 드라이브 (내 드라이브)", path: drive });
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (fs.existsSync(`${letter}:\\`)) places.push({ name: `${letter}: 드라이브`, path: `${letter}:\\` });
    }
    return { ok: true, path: "", parent: null, folders: places };
  }
  try {
    const folders = listSubfolders(folder)
      .map((p) => ({ name: path.basename(p), path: p }))
      .filter((f) => !/^[.$]/.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    const parent = path.dirname(folder);
    return { ok: true, path: folder, parent: parent === folder ? "" : parent, folders, media: listMedia(folder).length };
  } catch {
    return { ok: false, message: "이 폴더는 열 수 없습니다." };
  }
}

function folderInfo(folder) {
  if (!folder || !fs.existsSync(folder)) return { ok: false, message: "폴더를 찾을 수 없습니다." };
  return { ok: true, images: listMedia(folder).length, subfolders: listSubfolders(folder).length };
}

function guessDriveFolder() {
  for (const letter of "GHIJKLDEF") {
    for (const name of ["내 드라이브", "My Drive"]) {
      const candidate = `${letter}:\\${name}`;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

// ---------- 사진 목록과 미리보기 ----------

// 사진 고르기 화면에 보여 줄 목록. 처음에는 아직 글에 안 쓴 사진을 설정한 장수만큼 미리 골라 둔다.
// 하위 폴더 방식이면 폴더 하나(sub, 없으면 아직 안 쓴 첫 폴더)의 사진을 보여 준다.
function photoList(sub) {
  const config = loadConfig();
  if (!config.photoFolder || !fs.existsSync(config.photoFolder)) {
    return { ok: false, message: "사진 폴더를 찾을 수 없습니다. 구글 드라이브가 켜져 있는지 확인하거나 설정에서 폴더를 다시 골라 주세요." };
  }
  const used = new Set(loadUsed());
  const item = (file) => ({ path: file, name: path.basename(file), video: isVideo(file), used: used.has(file) });
  if (config.mode === "subfolder") {
    const folders = sortFiles(listSubfolders(config.photoFolder), config.order).map((f) => ({ path: f, name: path.basename(f), used: used.has(f) }));
    const current = folders.find((f) => f.path === sub) ?? folders.find((f) => !f.used) ?? folders[0];
    if (!current) return { ok: true, mode: "subfolder", folders, items: [], preselect: [] };
    const files = sortFiles(listMedia(current.path), "name");
    return { ok: true, mode: "subfolder", folders, folder: current.path, folderName: current.name, items: files.map(item), preselect: files.slice(0, config.photosPerPost) };
  }
  const files = sortFiles(listMedia(config.photoFolder), config.order);
  return { ok: true, mode: "batch", items: files.map(item), preselect: files.filter((f) => !used.has(f)).slice(0, config.photosPerPost) };
}

// 사진 폴더 밖의 파일은 보여 주지 않는다
function inPhotoFolder(file) {
  const root = loadConfig().photoFolder;
  if (!file || !root) return false;
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(root) + path.sep) && fs.existsSync(resolved);
}

// 작은 미리보기 사진. 구글 드라이브 사진은 열 때마다 내려받으므로 한 번 만든 것은 저장해 두고 다시 쓴다.
async function thumbnail(file) {
  const key = crypto.createHash("md5").update(file + fs.statSync(file).mtimeMs).digest("hex");
  const out = path.join(THUMB_DIR, `${key}.jpg`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    await sharp(file).rotate().resize(360, 360, { fit: "cover" }).jpeg({ quality: 75 }).toFile(out);
  }
  return out;
}

const VIDEO_TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

// 동영상 미리보기용. 브라우저가 필요한 부분만 달라고 하므로(Range) 그 부분만 보낸다.
function sendVideo(req, res, file) {
  const size = fs.statSync(file).size;
  const type = VIDEO_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!range) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  const start = Number(range[1] || 0);
  const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
  res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// ---------- 글 만들기 ----------

const job = { running: false, step: "", logs: [], progress: 0, startedAt: 0, result: null, error: "" };
let editor = null; // 마지막으로 연 네이버 글쓰기 창 (사용자가 닫을 때까지 열어 둔다)
let windowClosed = false;
let appWindow = null; // 프로그램 창 (업데이트 뒤 다시 시작할 때 닫는다)
let restarting = false;

function log(text) {
  job.logs.push(text);
  console.log(text);
}

function backupPost(title, blocks, userId) {
  const dir = userPaths(userId).posts;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(dir, `${stamp}.txt`);
  const line = (b) => {
    if (b.type === "photo") return `[사진: ${path.basename(b.file)}]`;
    if (b.type === "video") return `[동영상: ${path.basename(b.file)}]`;
    if (b.type === "place") return `[지도: ${b.query}]`;
    if (b.type === "link") return b.url;
    return b.type === "text" ? b.text : "";
  };
  fs.writeFileSync(file, `${title}\n\n${blocks.map(line).join("\n")}\n`, "utf8");
  return file;
}

// 요청이 맞는지 확인하고, 문제가 있으면 사용자에게 보여 줄 문장을 돌려준다
function checkRun(config, body) {
  if (job.running) return "이미 글을 만들고 있습니다. 끝날 때까지 기다려 주세요.";
  if (editor) return "앞에서 연 네이버 글쓰기 창이 아직 열려 있습니다. 그 창에서 글을 확인(발행)한 뒤 창을 닫고 다시 눌러 주세요.";
  if (!config.apiKey || !config.blogId || !config.photoFolder) return "설정이 아직 안 되어 있습니다. '설정' 탭에서 API 키, 블로그 아이디, 사진 폴더를 넣고 저장해 주세요.";
  if (!Array.isArray(body.photos) || !body.photos.length) return "글에 넣을 사진을 한 장 이상 골라 주세요.";
  if (body.photos.length > MAX_PHOTOS) return `사진은 한 번에 ${MAX_PHOTOS}장까지 넣을 수 있습니다.`;
  if (!body.photos.every(inPhotoFolder)) return "고른 사진 중에 찾을 수 없는 파일이 있습니다. '새로고침'을 누른 뒤 다시 골라 주세요.";
  return "";
}

async function runJob(config, body) {
  const userId = currentUser().id; // 글을 만드는 동안에는 사용자를 못 바꾸게 막지만, 기록은 시작할 때의 사용자에게 남긴다
  const photos = body.photos;
  const notes = photos.map((_, i) => String(body.notes?.[i] ?? ""));
  const topic = String(body.topic ?? "").trim() || body.folderName || config.topic;
  const memo = [config.memo, String(body.memo ?? "").trim()].filter(Boolean).join("\n");
  // 하위 폴더 방식은 폴더를, 아니면 사진 하나하나를 '사용함'으로 기록한다
  const usedKeys = config.mode === "subfolder" && body.folder ? [body.folder] : photos;

  Object.assign(job, { running: true, step: "ai", logs: [], progress: 0, startedAt: Date.now(), result: null, error: "" });
  const format = FORMATS[body.format] ? body.format : "daily";
  log(`'${FORMATS[format].label}' 형식으로, 사진·동영상 ${photos.length}개를 보고 AI가 글을 씁니다. 보통 1~3분 걸리고, 사진이 많을수록 오래 걸립니다.`);
  try {
    const { post, costWon, styleSamples, checks } = await generatePost(config, photos, topic, memo, String(body.emphasis ?? "").trim(), {
      notes,
      format,
      onProgress: (chars) => (job.progress = chars),
    });
    log(`글 완성: "${post.title}" (사용료 약 ${costWon}원${styleSamples ? `, 말투 예시 ${styleSamples}편 참고` : ""})`);
    if (checks.length) log(checks.map((c) => "· " + c).join("\n"));
    const blocks = toBlocks(post, photos, config.footer, { keepOrder: !FORMATS[format].freeOrder });
    const backup = backupPost(post.title, blocks, userId);

    job.step = "naver";
    log("네이버 글쓰기 화면을 엽니다. 입력이 끝날 때까지 그 브라우저 창을 건드리지 말아 주세요.");
    let failed;
    try {
      editor = await openEditor(config.blogId, userPaths(userId).profile, log);
      const context = editor.context;
      context.on("close", () => {
        if (editor?.context === context) editor = null;
        quitIfDone();
      });
      failed = await writeDraft(editor, post.title, blocks, { log, save: !DRY_RUN, template: config.naverTemplate?.trim() });
    } catch (error) {
      const shot = editor ? await screenshot(editor.page, "error") : "";
      throw new Error(
        `네이버에 입력하는 중 문제가 생겼습니다: ${error.message}\n만든 글은 없어지지 않았습니다. 이 파일에 저장되어 있으니 복사해서 직접 붙여넣을 수 있습니다:\n${backup}` +
          (shot ? `\n(오류 화면 사진: ${shot})` : ""),
      );
    }
    if (!DRY_RUN) markUsed(usedKeys, userId);
    job.result = { title: post.title, costWon, failed, backup };
    log("임시저장까지 끝났습니다. 네이버 창에서 글을 확인하고, 괜찮으면 오른쪽 위 '발행'을 눌러 주세요. 확인이 끝나면 네이버 창을 닫으면 됩니다.");
    if (failed.length) {
      log(`[확인 필요] 자동으로 넣지 못한 것이 있어서, 그 자리에 주소나 [여기에 지도 넣기] 표시만 남겼습니다: ${failed.join(", ")}`);
      log("글쓰기 화면 위쪽의 '장소'(지도) 또는 '링크' 버튼으로 직접 넣어 주세요.");
    }
    job.step = "done";
  } catch (error) {
    job.error = job.step === "ai" ? `글을 만들지 못했습니다.\n${explainError(error)}` : error.message;
    log(job.error);
    job.step = "error";
  } finally {
    job.running = false;
    quitIfDone();
  }
}

// 프로그램 창도 닫혔고, 글 만들기도 끝났고, 네이버 창도 닫혔으면 프로그램을 끝낸다
function quitIfDone() {
  if (restarting) return;
  if (windowClosed && !job.running && !editor) process.exit(0);
}

// ---------- 사용자(블로그) 바꾸기 ----------

// 사용자 추가·바꾸기·이름 바꾸기·지우기. 글을 만드는 중이거나 네이버 창이 열려 있으면 그 사용자의 일이 끝난 뒤에 하게 한다
function changeUsers({ action, id, name, copyApiKey }) {
  if (action !== "rename" && (job.running || editor)) {
    return { ok: false, message: "글을 만드는 중이거나 네이버 글쓰기 창이 열려 있어서 지금은 사용자를 바꿀 수 없습니다. 네이버 창을 닫은 뒤 다시 해 주세요." };
  }
  name = String(name ?? "").trim();
  if ((action === "add" || action === "rename") && !name) return { ok: false, message: "이름을 적어 주세요." };
  if (action === "add") addUser(name, Boolean(copyApiKey));
  else if (action === "switch") switchUser(id);
  else if (action === "rename") renameUser(id, name);
  else if (action === "remove") removeUser(id);
  else return { ok: false, message: "알 수 없는 요청입니다." };
  if (action !== "rename") Object.assign(job, { step: "", logs: [], result: null, error: "", startedAt: 0 }); // 앞 사용자의 진행 기록은 보여 주지 않는다
  return { ok: true, users: loadUsers() };
}

// ---------- 업데이트 ----------

const update = { running: false, logs: [], error: "", done: false };

function startUpdate() {
  if (update.running) return { ok: false, message: "이미 업데이트하고 있습니다." };
  if (job.running || editor) return { ok: false, message: "글을 만드는 중이거나 네이버 글쓰기 창이 열려 있습니다. 네이버 창을 닫은 뒤 다시 눌러 주세요." };
  Object.assign(update, { running: true, logs: [], error: "", done: false });
  applyUpdate((text) => { update.logs.push(text); console.log(text); })
    .then(() => {
      update.done = true;
      setTimeout(restart, 1500); // 화면이 '다시 시작합니다'를 읽어 갈 시간을 준다
    })
    .catch((error) => {
      update.error = `업데이트하지 못했습니다: ${error.message}
프로그램은 지금 버전 그대로 쓸 수 있습니다.`;
      console.error(error);
    })
    .finally(() => (update.running = false));
  return { ok: true };
}

// 새 코드로 다시 시작한다: 창과 서버를 닫고, 같은 프로그램을 새로 띄운 뒤 이 프로그램은 끝낸다
async function restart() {
  restarting = true;
  server.close();
  await appWindow?.close().catch(() => {});
  const args = [path.join(here, "app.js"), "--after-update"];
  spawn(process.execPath, args, { cwd: here, detached: true, stdio: "ignore" }).unref();
  process.exit(0);
}

// ---------- 웹 서버 ----------

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (data) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  const notFound = () => {
    res.writeHead(404);
    res.end();
  };
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(here, "app.html")));
    } else if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(fs.readFileSync(path.join(here, "icon.ico")));
    } else if (req.method === "GET" && url.pathname === "/api/config") {
      json({ config: loadConfig(), users: loadUsers(), driveGuess: guessDriveFolder(), maxPhotos: MAX_PHOTOS });
    } else if (req.method === "POST" && url.pathname === "/api/config") {
      saveConfig({ ...loadConfig(), ...(await readBody(req)) });
      json({ ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/users") {
      json(changeUsers(await readBody(req)));
    } else if (req.method === "POST" && url.pathname === "/api/check-key") {
      const { apiKey } = await readBody(req);
      json(apiKey?.trim() ? await checkApiKey(apiKey.trim()) : { ok: false, message: "API 키를 넣어 주세요." });
    } else if (req.method === "GET" && url.pathname === "/api/blog") {
      // 블로그 이름과 최근 글 목록 (설정 '블로그 확인', '내 블로그에서 가져오기')
      const id = url.searchParams.get("id");
      if (!isBlogId(id)) return json({ ok: false, message: "블로그 아이디는 영어, 숫자, -, _ 로만 되어 있습니다. 다시 확인해 주세요." });
      json({ ok: true, ...(await recentPosts(id)) });
    } else if (req.method === "GET" && url.pathname === "/api/blog-post") {
      const id = url.searchParams.get("id");
      const logNo = url.searchParams.get("logNo");
      if (!isBlogId(id) || !/^\d+$/.test(logNo ?? "")) return json({ ok: false, message: "글 주소가 올바르지 않습니다." });
      json({ ok: true, text: await postText(id, logNo) });
    } else if (req.method === "GET" && url.pathname === "/api/footer-example") {
      // 프로그램 폴더의 글끝_예시.txt (설정 5번 '예시 불러오기'로 넣는다)
      const file = path.join(here, "..", "글끝_예시.txt");
      json(fs.existsSync(file) ? { ok: true, text: fs.readFileSync(file, "utf8").replace(/^﻿/, "") } : { ok: false });
    } else if (req.method === "GET" && url.pathname === "/api/folder-info") {
      json(folderInfo(url.searchParams.get("path")));
    } else if (req.method === "GET" && url.pathname === "/api/browse") {
      json(browse(url.searchParams.get("path")));
    } else if (req.method === "GET" && url.pathname === "/api/photos") {
      json(photoList(url.searchParams.get("sub")));
    } else if (req.method === "GET" && url.pathname === "/api/thumb") {
      const file = url.searchParams.get("path");
      if (!inPhotoFolder(file) || isVideo(file)) return notFound();
      const thumb = await thumbnail(file);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
      fs.createReadStream(thumb).pipe(res);
    } else if (req.method === "GET" && url.pathname === "/api/video") {
      const file = url.searchParams.get("path");
      if (!inPhotoFolder(file) || !isVideo(file)) return notFound();
      sendVideo(req, res, file);
    } else if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(req);
      const config = loadConfig();
      const problem = checkRun(config, body);
      if (problem) return json({ ok: false, message: problem });
      runJob(config, body);
      json({ ok: true });
    } else if (req.method === "GET" && url.pathname === "/api/update") {
      json({ ...updateInfo(), current: VERSION, ...update });
    } else if (req.method === "POST" && url.pathname === "/api/update/check") {
      json({ ...(await checkUpdate()), current: VERSION });
    } else if (req.method === "POST" && url.pathname === "/api/update") {
      json(startUpdate());
    } else if (NO_WINDOW && req.method === "POST" && url.pathname === "/api/quit") {
      json({ ok: true });
      setTimeout(() => process.exit(0), 100);
    } else if (req.method === "GET" && url.pathname === "/api/job") {
      json({ ...job, elapsed: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0, editorOpen: Boolean(editor) });
    } else {
      notFound();
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, message: error.message }));
  }
});

// Edge를 주소창 없는 앱 창으로 연다. 사용자가 이 창을 닫으면 프로그램도 끝낸다.
async function openWindow(address) {
  try {
    const context = await chromium.launchPersistentContext(path.join(DATA_DIR, "app-window"), {
      channel: "msedge",
      chromiumSandbox: true, // Playwright는 기본으로 Edge 보호막(샌드박스)을 끄므로 다시 켠다
      headless: false,
      viewport: null,
      args: [`--app=${address}`, "--window-size=1280,960"],
      ignoreDefaultArgs: ["--enable-automation"], // '자동화 소프트웨어가 제어 중' 안내 줄을 없앤다
    });
    appWindow = context;
    context.on("close", () => {
      windowClosed = true;
      quitIfDone();
    });
  } catch {
    // 앱 창을 못 띄우면 기본 브라우저로 연다 (이때는 검은 창을 닫아야 끝난다)
    exec(`start "" "${address}"`);
  }
}

const address = `http://127.0.0.1:${PORT}/${process.argv[2] === "settings" ? "#settings" : ""}`;

// 프로그램이 이미 켜져 있으면 새로 띄우지 않고 창만 하나 더 연다.
// 업데이트 직후에는 앞 프로그램이 아직 끝나는 중일 수 있어서 잠깐씩 기다렸다가 다시 해 본다
let listenTries = 0;
server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  if (AFTER_UPDATE && ++listenTries < 20) return setTimeout(() => server.listen(PORT, "127.0.0.1"), 500);
  console.log("프로그램이 이미 켜져 있어서 창만 다시 엽니다.");
  exec(`start "" "${address}"`, () => process.exit(0));
});

// 다른 PC에서 접속하지 못하게 이 PC(127.0.0.1)에서만 받는다
server.listen(PORT, "127.0.0.1", () => {
  console.log("블로그 글 생성기 창을 엽니다. 이 검은 창은 프로그램 창을 닫으면 저절로 닫힙니다.");
  if (!NO_WINDOW) openWindow(address);
  checkUpdate(); // 새 버전이 있으면 화면 위쪽에 알려 준다
});
