// 프로그램 창: 사진을 골라 순서와 메모를 정하고, 설정하고, 블로그 글 만들기까지 한 화면에서 한다.
// 이 PC에서만 열리는 작은 웹 서버를 띄우고, Edge를 주소창 없는 앱 창으로 열어 보여 준다.
// 실행: node app.js (설정 화면부터 열려면 node app.js settings)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { loadConfig, saveConfig, listMedia, listSubfolders, loadUsed, markUsed, isVideo, DATA_DIR, userPaths, loadUsers, currentUser, addUser, switchUser, renameUser, removeUser, recordUsage, usageSummary, listPosts, readPost, IMAGE_EXTS, VIDEO_EXTS } from "./config.js";
import { readable } from "./media.js";
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
    places.push(...pcFolders());
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
  return Boolean(file && root) && isInside(root, file) && fs.existsSync(file);
}

// file이 folder 안에 있는지. 폴더가 드라이브 맨 위(D:\)여도, 대소문자가 달라도 맞게 판단한다
function isInside(folder, file) {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// 작은 미리보기 사진. 구글 드라이브 사진은 열 때마다 내려받으므로 한 번 만든 것은 저장해 두고 다시 쓴다.
async function thumbnail(file) {
  const key = crypto.createHash("md5").update(file + fs.statSync(file).mtimeMs).digest("hex");
  const out = path.join(THUMB_DIR, `${key}.jpg`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    // failOn: "none" — 일부 휴대폰 사진은 파일 안에 군더더기 바이트가 섞여 있다. 사진 앱은 무시하고 보여 주므로 여기서도 무시한다
    await sharp(await readable(file), { failOn: "none" }).rotate().resize(360, 360, { fit: "cover" }).jpeg({ quality: 75 }).toFile(out);
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
// 흐름: AI가 글 쓰기(ai) → [미리 보기를 켰으면] 사용자가 읽고 고치기(review) → 네이버에 입력(naver) → 끝(done) / 문제(error)

const job = { running: false, step: "", logs: [], progress: 0, startedAt: 0, result: null, error: "", shot: "", draft: null, draftId: 0 };
let pending = null; // 미리 보기 중인 글을 네이버에 넣거나 다시 쓸 때 필요한 것들 (사용자, 설정, 사진 등)
let editor = null; // 마지막으로 연 네이버 글쓰기 창 (사용자가 닫을 때까지 열어 둔다)
let windowClosed = false;
let appWindow = null; // 프로그램 창 (업데이트 뒤 다시 시작할 때 닫는다)
let restarting = false;

function log(text) {
  job.logs.push(text);
  console.log(text);
}

// 지금 뭔가 하고 있어서 다른 일(새 글, 사용자 바꾸기, 업데이트)을 하면 안 되면 그 이유를 돌려준다
function busy() {
  if (job.running) return "글을 만드는 중입니다. 끝날 때까지 기다려 주세요.";
  if (job.step === "review") return "앞에서 만든 글을 확인하는 중입니다. 아래 '글 확인'에서 '이대로 네이버에 넣기'나 '그만두기'를 먼저 눌러 주세요.";
  if (editor) return "앞에서 연 네이버 글쓰기 창이 아직 열려 있습니다. 그 창에서 글을 확인(발행)한 뒤 창을 닫고 다시 해 주세요.";
  return "";
}

// 만든 글을 txt로 남긴다 ('지난 글'에서 다시 볼 수 있다). names: 바꾼 사진 경로 → 원래 파일 이름
function backupPost(title, blocks, userId, names) {
  const dir = userPaths(userId).posts;
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const file = path.join(dir, `${stamp}.txt`);
  const name = (f) => names.get(f) ?? path.basename(f);
  const line = (b) => {
    if (b.type === "photo") return `[사진: ${name(b.file)}]`;
    if (b.type === "video") return `[동영상: ${name(b.file)}]`;
    if (b.type === "place") return `[지도: ${b.query}]`;
    if (b.type === "link") return b.url;
    return b.type === "text" ? b.text : "";
  };
  fs.writeFileSync(file, `${title}\n\n${blocks.map(line).join("\n")}\n`, "utf8");
  return file;
}

// 요청이 맞는지 확인하고, 문제가 있으면 사용자에게 보여 줄 문장을 돌려준다
function checkRun(config, body) {
  const why = busy();
  if (why) return why;
  if (!config.apiKey || !config.blogId || !config.photoFolder) return "설정이 아직 안 되어 있습니다. '설정' 탭에서 API 키, 블로그 아이디, 사진 폴더를 넣고 저장해 주세요.";
  if (!Array.isArray(body.photos) || !body.photos.length) return "글에 넣을 사진을 한 장 이상 골라 주세요.";
  if (body.photos.length > MAX_PHOTOS) return `사진은 한 번에 ${MAX_PHOTOS}장까지 넣을 수 있습니다.`;
  if (!body.photos.every(inPhotoFolder)) return "고른 사진 중에 찾을 수 없는 파일이 있습니다. '새로고침'을 누른 뒤 다시 골라 주세요.";
  return "";
}

function fail(error) {
  job.error = job.step === "ai" ? `글을 만들지 못했습니다.\n${explainError(error)}` : error.message;
  log(job.error);
  job.failedStep = job.step;
  job.step = "error";
}

// AI에게 글을 쓰게 한다. revise가 있으면 앞 글을 고쳐 쓴다. 다 쓰면 미리 보기로 가거나 바로 네이버에 넣는다
async function write(revise) {
  const p = pending;
  Object.assign(job, { running: true, step: "ai", progress: 0, error: "", shot: "" });
  try {
    const { post, costWon, styleSamples, checks } = await generatePost(p.config, p.files, p.topic, p.memo, p.emphasis, {
      notes: p.notes,
      format: p.format,
      revise,
      onProgress: (chars) => (job.progress = chars),
    });
    recordUsage(costWon, revise ? "rewrite" : "new", p.userId);
    p.costWon += costWon;
    log(`${revise ? "다시 쓴 글" : "글 완성"}: "${post.title}" (사용료 약 ${costWon}원${styleSamples ? `, 말투 예시 ${styleSamples}편 참고` : ""})`);
    if (checks.length) log(checks.map((c) => "· " + c).join("\n"));
    if (p.review) {
      Object.assign(job, { step: "review", draft: { post, checks }, draftId: job.draftId + 1 });
      log("글이 완성됐습니다. 아래 '글 확인'에서 읽어 보고, 고칠 곳은 고친 뒤 '이대로 네이버에 넣기'를 눌러 주세요.");
      return;
    }
    await toNaver(post);
  } catch (error) {
    fail(error);
  } finally {
    job.running = false;
    quitIfDone();
  }
}

// 다 된 글을 네이버 글쓰기 화면에 넣고 임시저장한다
async function toNaver(post) {
  const p = pending;
  const blocks = toBlocks(post, p.files, p.config.footer, { keepOrder: !FORMATS[p.format].freeOrder });
  const backup = backupPost(post.title, blocks, p.userId, p.names);
  job.step = "naver";
  log("네이버 글쓰기 화면을 엽니다. 입력이 끝날 때까지 그 브라우저 창을 건드리지 말아 주세요.");
  let failed;
  try {
    editor = await openEditor(p.config.blogId, userPaths(p.userId).profile, log);
    const context = editor.context;
    context.on("close", () => {
      if (editor?.context === context) editor = null;
      quitIfDone();
    });
    failed = await writeDraft(editor, post.title, blocks, { log, save: !DRY_RUN, template: p.config.naverTemplate?.trim() });
  } catch (error) {
    job.shot = editor ? await screenshot(editor.page, "error").catch(() => "") : "";
    throw new Error(
      `네이버에 입력하는 중 문제가 생겼습니다: ${error.message}\n만든 글은 없어지지 않았습니다. 위쪽 '지난 글' 탭에서 복사해서 직접 붙여넣을 수 있습니다.`,
    );
  }
  if (!DRY_RUN) markUsed(p.usedKeys, p.userId);
  job.result = { title: post.title, costWon: p.costWon, failed, backup };
  log("임시저장까지 끝났습니다. 네이버 창에서 글을 확인하고, 괜찮으면 오른쪽 위 '발행'을 눌러 주세요. 확인이 끝나면 네이버 창을 닫으면 됩니다.");
  if (failed.length) {
    log(`[확인 필요] 자동으로 넣지 못한 것이 있어서, 그 자리에 주소나 [여기에 지도 넣기] 표시만 남겼습니다: ${failed.join(", ")}`);
    log("글쓰기 화면 위쪽의 '장소'(지도) 또는 '링크' 버튼으로 직접 넣어 주세요.");
  }
  job.step = "done";
  pending = null;
}

async function runJob(config, body) {
  const photos = body.photos;
  const format = FORMATS[body.format] ? body.format : "daily";
  Object.assign(job, { running: true, step: "ai", logs: [], progress: 0, startedAt: Date.now(), result: null, error: "", shot: "", draft: null });
  log(`'${FORMATS[format].label}' 형식으로, 사진·동영상 ${photos.length}개를 보고 AI가 글을 씁니다. 보통 1~3분 걸리고, 사진이 많을수록 오래 걸립니다.`);
  try {
    // 아이폰 사진(HEIC)은 JPG로 바꾼 파일을 AI와 네이버에 쓴다
    const files = [];
    for (const file of photos) files.push(await readable(file));
    if (files.some((f, i) => f !== photos[i])) log("아이폰 사진(HEIC)을 JPG로 바꿔서 씁니다.");
    pending = {
      userId: currentUser().id, // 글을 만드는 동안에는 사용자를 못 바꾸게 막지만, 기록은 시작할 때의 사용자에게 남긴다
      config,
      files,
      originals: photos,
      names: new Map(files.map((f, i) => [f, path.basename(photos[i])])),
      notes: photos.map((_, i) => String(body.notes?.[i] ?? "")),
      topic: String(body.topic ?? "").trim() || body.folderName || config.topic,
      memo: [config.memo, String(body.memo ?? "").trim()].filter(Boolean).join("\n"),
      emphasis: String(body.emphasis ?? "").trim(),
      format,
      review: Boolean(body.review),
      // 하위 폴더 방식은 폴더를, 아니면 사진 하나하나를 '사용함'으로 기록한다
      usedKeys: config.mode === "subfolder" && body.folder ? [body.folder] : photos,
      costWon: 0,
    };
  } catch (error) {
    job.running = false;
    return fail(error);
  }
  await write();
}

// 미리 보기에서 사용자가 고른 것: accept(고친 글로 네이버에 넣기) / rewrite(다시 써 줘) / cancel(그만두기)
function review({ action, post, request }) {
  if (job.step !== "review" || !pending) return { ok: false, message: "확인할 글이 없습니다." };
  if (action === "cancel") {
    Object.assign(job, { step: "", draft: null, logs: [] });
    pending = null;
    return { ok: true };
  }
  const draft = cleanDraft(post, job.draft.post);
  if (action === "accept") {
    Object.assign(job, { running: true, draft: null });
    toNaver(draft)
      .catch(fail)
      .finally(() => {
        job.running = false;
        quitIfDone();
      });
    return { ok: true };
  }
  if (action === "rewrite") {
    log(request?.trim() ? `다시 써 달라고 했습니다: "${request.trim()}"` : "다시 써 달라고 했습니다.");
    write({ post: draft, request: String(request ?? "") });
    return { ok: true };
  }
  return { ok: false, message: "알 수 없는 요청입니다." };
}

// 화면에서 고친 글을 받아 모양을 맞춘다. 사진 자리(photos)는 화면에서 못 바꾸므로 원래 글의 것을 쓴다
function cleanDraft(edited, original) {
  const text = (v) => String(v ?? "");
  return {
    title: text(edited?.title).trim() || original.title,
    intro: text(edited?.intro),
    sections: original.sections.map((s, i) => ({
      photos: s.photos,
      caption: text(edited?.sections?.[i]?.caption ?? s.caption),
      heading: text(edited?.sections?.[i]?.heading ?? s.heading),
      text: text(edited?.sections?.[i]?.text ?? s.text),
    })),
    outro: text(edited?.outro),
    hashtags: Array.isArray(edited?.hashtags) ? edited.hashtags.map((t) => text(t).replace(/^#/, "").trim()).filter(Boolean) : original.hashtags,
  };
}

// 오류가 났을 때 '오류 내용 복사'로 프로그램을 준 사람에게 보낼 글
function errorReport() {
  const stepName = { ai: "AI가 글 쓰기", naver: "네이버에 입력" }[job.failedStep] ?? job.failedStep ?? "";
  return [
    "[블로그 글 생성기 오류]",
    `버전 ${VERSION} · ${new Date().toLocaleString("ko-KR")}`,
    `단계: ${stepName}`,
    `오류: ${job.error}`,
    job.shot ? `오류 화면 사진: ${job.shot}` : null,
    "",
    "진행 기록:",
    ...job.logs.slice(-12).map((l) => "- " + l.replace(/\n/g, " ")),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// 프로그램 창도 닫혔고, 글 만들기도 끝났고, 네이버 창도 닫혔으면 프로그램을 끝낸다
function quitIfDone() {
  if (restarting) return;
  if (windowClosed && !job.running && !editor) process.exit(0);
}

// 프로그램 창에 끌어다 놓거나 'PC에서 사진 추가'로 고른 사진을 사진 폴더에 복사한다 (하위 폴더 방식이면 지금 보고 있는 하위 폴더에).
// 같은 이름이 있으면 "이름 (1).jpg"처럼 바꿔서 덮어쓰지 않는다
async function upload(req, name, sub) {
  const config = loadConfig();
  const root = config.photoFolder;
  if (!root || !fs.existsSync(root)) return { ok: false, message: "사진 폴더를 찾을 수 없습니다. 설정에서 사진 폴더를 먼저 골라 주세요." };
  const folder = config.mode === "subfolder" && sub && isInside(root, sub) && fs.existsSync(sub) ? sub : root;
  const base = path.basename(String(name ?? "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const ext = path.extname(base).toLowerCase();
  if (!base || !(IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext))) return { ok: false, message: `${base || "파일"}: 사진이나 동영상 파일만 넣을 수 있습니다.` };
  let target = path.join(folder, base);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(folder, `${path.basename(base, ext)} (${n})${ext}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    req.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    req.on("error", reject);
  });
  return { ok: true, path: target };
}

// 폴더 고르기 첫 화면에 보여 줄 이 PC의 사진 폴더와 바탕 화면 (있는 것만)
function pcFolders() {
  const home = os.homedir();
  const candidates = [
    ["📷 내 PC 사진 폴더", [path.join(home, "Pictures"), path.join(home, "OneDrive", "사진"), path.join(home, "OneDrive", "Pictures")]],
    ["🖥 바탕 화면", [path.join(home, "OneDrive", "바탕 화면"), path.join(home, "OneDrive", "Desktop"), path.join(home, "Desktop")]],
  ];
  return candidates.map(([label, paths]) => ({ name: label, path: paths.find((p) => fs.existsSync(p)) })).filter((f) => f.path);
}

// ---------- 사용자(블로그) 바꾸기 ----------

// 사용자 추가·바꾸기·이름 바꾸기·지우기. 글을 만드는 중이거나 네이버 창이 열려 있으면 그 사용자의 일이 끝난 뒤에 하게 한다
function changeUsers({ action, id, name, copyApiKey }) {
  if (action !== "rename" && busy()) return { ok: false, message: busy() };
  name = String(name ?? "").trim();
  if ((action === "add" || action === "rename") && !name) return { ok: false, message: "이름을 적어 주세요." };
  if (action === "add") addUser(name, Boolean(copyApiKey));
  else if (action === "switch") switchUser(id);
  else if (action === "rename") renameUser(id, name);
  else if (action === "remove") removeUser(id);
  else return { ok: false, message: "알 수 없는 요청입니다." };
  if (action !== "rename") Object.assign(job, { step: "", logs: [], result: null, error: "", startedAt: 0, draft: null }); // 앞 사용자의 진행 기록은 보여 주지 않는다
  return { ok: true, users: loadUsers() };
}

// ---------- 업데이트 ----------

const update = { running: false, logs: [], error: "", done: false };

function startUpdate() {
  if (update.running) return { ok: false, message: "이미 업데이트하고 있습니다." };
  if (busy()) return { ok: false, message: busy() };
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
    } else if (req.method === "GET" && url.pathname === "/api/image") {
      // 작은 미리보기를 못 만들 때 화면이 대신 원본 사진을 보여 준다 (브라우저가 읽을 수 있는 형식만)
      const file = url.searchParams.get("path");
      const type = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[path.extname(file ?? "").toLowerCase()];
      if (!type || !inPhotoFolder(file)) return notFound();
      res.writeHead(200, { "Content-Type": type });
      fs.createReadStream(file).pipe(res);
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
    } else if (req.method === "POST" && url.pathname === "/api/review") {
      json(review(await readBody(req)));
    } else if (req.method === "GET" && url.pathname === "/api/report") {
      json({ ok: true, text: errorReport() });
    } else if (req.method === "POST" && url.pathname === "/api/open") {
      // 탐색기로 보여 준다: 지난 글 폴더, 오류 화면 사진
      const { what } = await readBody(req);
      if (what === "posts") {
        fs.mkdirSync(userPaths().posts, { recursive: true });
        exec(`explorer "${userPaths().posts}"`);
      } else if (what === "shot" && job.shot && fs.existsSync(job.shot)) {
        exec(`explorer /select,"${job.shot}"`);
      }
      json({ ok: true });
    } else if (req.method === "GET" && url.pathname === "/api/usage") {
      json(usageSummary());
    } else if (req.method === "GET" && url.pathname === "/api/posts") {
      json(listPosts());
    } else if (req.method === "GET" && url.pathname === "/api/post") {
      const text = readPost(url.searchParams.get("name"));
      json(text === null ? { ok: false, message: "글을 찾을 수 없습니다." } : { ok: true, text });
    } else if (req.method === "POST" && url.pathname === "/api/upload") {
      json(await upload(req, url.searchParams.get("name"), url.searchParams.get("sub")));
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
      json({
        ...job,
        elapsed: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
        editorOpen: Boolean(editor),
        review: Boolean(pending?.review),
        photos: (pending?.originals ?? []).map((p) => ({ path: p, name: path.basename(p), video: isVideo(p) })),
      });
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
