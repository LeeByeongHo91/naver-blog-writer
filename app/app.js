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
import { loadConfig, saveConfig, listMedia, listSubfolders, loadUsed, markUsed, isVideo, DATA_DIR, userPaths, loadUsers, currentUser, addUser, switchUser, renameUser, removeUser, recordUsage, usageSummary, monthWon, listPosts, readPost, recentSummaries, savePostData, readPostData, IMAGE_EXTS, VIDEO_EXTS } from "./config.js";
import { readable } from "./media.js";
import { generatePost, generateSocial, explainError, toBlocks, sortFiles, FORMATS, checkApiKey } from "./generate.js";
import { isBlogId, recentPosts, postText } from "./blog.js";
import { VERSION, checkUpdate, updateInfo, applyUpdate, rollbackUpdate } from "./update.js";
import { openEditor, checkEditor, writeDraft, screenshot } from "./naver.js";
import { findFaces, mosaic } from "./faces.js";
import { instagramPhotos, shortsVideo } from "./social.js";
import { report, statsEnabled, setStatsEnabled } from "./stats.js";
import { speak } from "./voice.js";
import { keepLog, writeReport } from "./diagnose.js";
import { learnEdits, loadLearned, forgetLearned } from "./learn.js";
import { checkPhotos } from "./photocheck.js";
import { exportSettings, importSettings } from "./transfer.js";
import { findPrivate, privacySummary } from "./privacy.js";

keepLog();
const here = import.meta.dirname;
// 시험용: BLOGWRITER_PORT 로 다른 포트에 띄운다 (진짜 프로그램이 켜져 있어도 시험할 수 있게)
const PORT = Number(process.env.BLOGWRITER_PORT) || 47813;
const MAX_PHOTOS = 20;
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
// 시험용: BLOGWRITER_DRY_RUN=1 이면 네이버에 입력만 하고 임시저장과 '사용함' 기록은 하지 않는다
const DRY_RUN = process.env.BLOGWRITER_DRY_RUN === "1";
// 시험용: BLOGWRITER_NO_WINDOW=1 이면 프로그램 창을 띄우지 않고, /api/quit 으로 끝낼 수 있다
const NO_WINDOW = process.env.BLOGWRITER_NO_WINDOW === "1";
const AFTER_ROLLBACK = process.argv.includes("--after-rollback");
const AFTER_UPDATE = AFTER_ROLLBACK || process.argv.includes("--after-update");
// 시험용: BLOGWRITER_NO_NAVER=1 이면 네이버 글쓰기 창을 열지 않고 그 단계를 건너뛴다 (인스타·쇼츠 만들기 시험)
const NO_NAVER = process.env.BLOGWRITER_NO_NAVER === "1";

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
  const queued = new Set(loadQueue().flatMap((q) => [...q.photos, q.folder]));
  const item = (file) => ({ path: file, name: path.basename(file), video: isVideo(file), used: used.has(file), queued: queued.has(file) });
  if (config.mode === "subfolder") {
    const folders = sortFiles(listSubfolders(config.photoFolder), config.order).map((f) => ({ path: f, name: path.basename(f), used: used.has(f), queued: queued.has(f) }));
    const current = folders.find((f) => f.path === sub) ?? folders.find((f) => !f.used && !f.queued) ?? folders[0];
    if (!current) return { ok: true, mode: "subfolder", folders, items: [], preselect: [] };
    const files = sortFiles(listMedia(current.path), "name");
    return { ok: true, mode: "subfolder", folders, folder: current.path, folderName: current.name, items: files.map(item), preselect: files.slice(0, config.photosPerPost) };
  }
  const files = sortFiles(listMedia(config.photoFolder), config.order);
  return { ok: true, mode: "batch", items: files.map(item), preselect: files.filter((f) => !used.has(f) && !queued.has(f)).slice(0, config.photosPerPost) };
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
// 흐름: [모자이크를 켰으면 얼굴 찾기] → AI가 글 쓰기(ai) → [미리 보기를 켰으면] 사용자가 읽고 고치기(review)
//   → 네이버에 입력(naver) → [켰으면] 인스타·쇼츠 파일 만들기(social) → 끝(done) / 문제(error)

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
  if (naverCheck.running) return "네이버 화면을 점검하는 중입니다. 끝날 때까지 기다려 주세요.";
  if (batch.running) return "여러 글을 차례대로 만드는 중입니다. 끝날 때까지 기다리거나 '이번 글까지만 하고 멈추기'를 눌러 주세요.";
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

// 미리 보기 중인 글을 파일로 남긴다. 창을 닫거나 PC가 꺼져도 사용료를 다시 내지 않고 이어서 고칠 수 있게 (API 키가 든 config는 남기지 않는다)
function saveDraft() {
  const { config, files, names, ...rest } = pending;
  const file = userPaths(pending.userId).draft;
  try {
    fs.writeFileSync(file + ".tmp", JSON.stringify({ ...rest, post: job.draft.post, checks: job.draft.checks }), "utf8");
    fs.renameSync(file + ".tmp", file);
  } catch (error) {
    console.error("쓰던 글을 저장하지 못했습니다:", error);
  }
}

const clearDraft = (userId) => fs.rmSync(userPaths(userId).draft, { force: true });

// 남아 있는 글이 있으면 글 확인 화면으로 불러온다. 사진을 못 찾아도 글은 보여 준다 (구글 드라이브가 아직 안 켜졌을 수 있어서)
async function restoreDraft(userId = currentUser().id) {
  const file = userPaths(userId).draft;
  if (!fs.existsSync(file)) return;
  try {
    const { post, checks, ...saved } = JSON.parse(fs.readFileSync(file, "utf8"));
    const missing = saved.originals.filter((f) => !fs.existsSync(f));
    const files = [];
    for (const f of saved.originals) files.push(missing.includes(f) ? f : await readable(f));
    pending = { ...saved, config: loadConfig(userId), files, names: new Map(files.map((f, i) => [f, path.basename(saved.originals[i])])) };
    Object.assign(job, { step: "review", logs: [], startedAt: Date.now(), social: saved.social, draft: { post, checks, privacy: findPrivate(post, pending.config), faces: saved.mosaic ? saved.faces : null }, draftId: job.draftId + 1 });
    log("지난번에 확인하던 글을 불러왔습니다. 이어서 고치거나, 필요 없으면 아래 '그만두기'를 눌러 주세요.");
    if (missing.length) log(`[확인 필요] 이 글의 사진을 찾지 못했습니다: ${missing.map((f) => path.basename(f)).join(", ")}\n구글 드라이브가 켜져 있는지 확인해 주세요.`);
  } catch (error) {
    console.error("쓰던 글을 불러오지 못했습니다:", error);
  }
}

// 요청이 맞는지 확인하고, 문제가 있으면 사용자에게 보여 줄 문장을 돌려준다
function checkRun(config, body) {
  return busy() || checkRequest(config, body);
}

function checkRequest(config, body) {
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
      social: p.social,
      notice: p.notice,
      history: { recent: recentSummaries(p.userId), learned: p.config.learnEdits ? loadLearned(p.userId).slice(-12) : [] },
      onProgress: (chars) => (job.progress = chars),
    });
    p.aiPost = structuredClone(post); // 사용자가 고친 부분을 찾을 때 비교한다
    recordUsage(costWon, revise ? "rewrite" : "new", p.userId);
    p.costWon += costWon;
    log(`${revise ? "다시 쓴 글" : "글 완성"}: "${post.title}" (사용료 약 ${costWon}원${styleSamples ? `, 말투 예시 ${styleSamples}편 참고` : ""})`);
    if (checks.length) log(checks.map((c) => "· " + c).join("\n"));
    if (p.review) {
      Object.assign(job, { step: "review", draft: { post, checks, privacy: findPrivate(post, p.config), faces: p.mosaic ? p.faces : null }, draftId: job.draftId + 1 });
      saveDraft();
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
  // 모자이크를 켰으면 얼굴을 가린 사진을 블로그·인스타·쇼츠에 쓴다
  let files = p.files;
  if (p.mosaic) {
    files = [];
    for (const [i, file] of p.files.entries()) files.push(await mosaic(file, p.faces[i]));
    files.forEach((f, i) => p.names.set(f, path.basename(p.originals[i])));
    const count = p.faces.reduce((t, list) => t + list.length, 0);
    log(count ? `얼굴 ${count}곳을 모자이크한 사진을 씁니다.` : "모자이크할 얼굴이 없어서 원래 사진을 씁니다.");
  }
  const blocks = toBlocks(post, files, p.config.footer, { keepOrder: !FORMATS[p.format].freeOrder });
  // 설정 '글 맨 위에 항상 넣을 이미지'는 제목 바로 아래, 도입 글 앞에 넣는다
  const header = await headerImagesFor(p.config, p.userId);
  if (header.length) blocks.unshift(...header.map((file) => ({ type: "photo", file })), { type: "blank" });
  for (const [i, file] of header.entries()) p.names.set(file, `맨 위 이미지: ${p.config.headerImages[i]}`);
  const backup = backupPost(post.title, blocks, p.userId, p.names);
  const stamp = path.basename(backup, ".txt");
  savePostData(stamp, { post, originals: p.originals, faces: p.mosaic ? p.faces : null, format: p.format }, p.userId);
  clearDraft(p.userId); // 이제부터는 '지난 글'에 남아 있다
  job.step = "naver";
  let failed = [];
  let saved = true;
  if (NO_NAVER) log("(시험) 네이버 입력은 건너뜁니다.");
  else try {
    log("네이버 글쓰기 화면을 엽니다. 입력이 끝날 때까지 그 브라우저 창을 건드리지 말아 주세요.");
    editor = await openEditor(p.config.blogId, userPaths(p.userId).profile, log);
    const context = editor.context;
    context.on("close", () => {
      if (editor?.context === context) editor = null;
      quitIfDone();
    });
    const uses = new Set(blocks.map((b) => b.type));
    if (p.config.naverTemplate?.trim()) uses.add("template");
    const { broken, partly } = await checkEditor(editor.frame, uses);
    if (broken.length) throw new Error(brokenEditor(broken));
    if (partly.length) log(`[확인 필요] 네이버 화면에서 찾지 못한 것이 있습니다: ${partly.join(", ")}. 글은 계속 넣고, 그 부분은 끝에 알려 드립니다.`);
    ({ failed, saved } = await writeDraft(editor, post.title, blocks, { log, save: !DRY_RUN, template: p.config.naverTemplate?.trim() }));
  } catch (error) {
    job.shot = editor ? await screenshot(editor.page, "error").catch(() => "") : "";
    throw new Error(
      `네이버에 입력하는 중 문제가 생겼습니다: ${error.message}\n만든 글은 없어지지 않았습니다. 위쪽 '지난 글' 탭에서 복사해서 직접 붙여넣을 수 있습니다.`,
    );
  }
  if (!DRY_RUN) markUsed(p.usedKeys, p.userId);
  // 글 확인을 건너뛰면 아무도 읽지 않은 글이므로, 찾은 것을 화면에 남겨 발행 전에 보게 한다
  const privacy = p.review ? [] : findPrivate(post, p.config);
  job.result = { title: post.title, costWon: p.costWon, failed, saved, backup, notice: noticeFor(post, p.config.blogId), inQueue: p.inQueue, privacy };
  if (privacy.length) log(`[확인 필요] 개인정보로 보이는 내용이 있습니다: ${privacySummary(privacy)}. 발행 전에 네이버에서 꼭 확인해 주세요.`);
  log(p.inQueue ? "임시저장까지 끝났습니다. 글은 나중에 네이버의 임시저장 글에서 확인해 주세요." : "임시저장까지 끝났습니다. 네이버 창에서 글을 확인하고, 괜찮으면 오른쪽 위 '발행'을 눌러 주세요. 확인이 끝나면 네이버 창을 닫으면 됩니다.");
  if (failed.length) {
    log(`[확인 필요] 자동으로 넣지 못한 것이 있어서, 그 자리에 주소나 [여기에 지도 넣기] 표시만 남겼습니다: ${failed.join(", ")}`);
    log("글쓰기 화면 위쪽의 '장소'(지도) 또는 '링크' 버튼으로 직접 넣어 주세요.");
  }
  report("post");
  if (p.social && post.instagram && post.shorts) {
    job.step = "social";
    // 블로그 글은 이미 들어갔으므로, 여기서 문제가 생겨도 오류로 멈추지 않고 알려만 준다
    try {
      job.result.social = await makeSocial(post, files, { userId: p.userId, config: p.config, stamp, log });
    } catch (error) {
      console.error(error);
      log(`[확인 필요] 인스타·쇼츠 파일을 다 만들지 못했습니다: ${error.message}`);
    }
  }
  job.step = "done";
  pending = null;
}

// 공지문에 블로그 주소를 붙인다 (AI가 주소를 잘못 쓰지 않게 프로그램이 붙인다). 공지문이 없는 글이면 빈 문자열
function noticeFor(post, blogId) {
  return post.notice?.trim() ? `${post.notice.trim()}\n\n👉 https://blog.naver.com/${blogId}` : "";
}

// 인스타그램 사진·글과 쇼츠 영상·제목을 '지난 글' 폴더 안 글마다의 폴더(posts\<만든 시각>)에 만든다.
// files: 글에 넣은 순서의 사진·동영상 (모자이크를 켰으면 가린 사진). 다시 만들면 앞의 파일은 지우고 새로 만든다
async function makeSocial(post, files, { userId, config, stamp, log }) {
  const photos = files.map((file, i) => ({ file, n: i + 1 })).filter((x) => !isVideo(x.file));
  if (!photos.length) {
    log("사진 없이 동영상만 있어서 인스타·쇼츠 파일은 만들지 않았습니다.");
    return null;
  }
  const dir = path.join(userPaths(userId).posts, stamp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  log("인스타그램용 사진(세로 4:5)을 만드는 중...");
  const instagram = await instagramPhotos(photos.map((x) => x.file), dir);
  const caption = `${post.instagram.caption.trim()}\n\n${post.instagram.hashtags.map((t) => "#" + t).join(" ")}`;
  fs.writeFileSync(path.join(dir, "인스타_글.txt"), caption, "utf8");
  const { title, description, ending } = post.shorts;
  fs.writeFileSync(path.join(dir, "쇼츠_제목과_설명.txt"), `${title.trim()}\n\n${description.trim()}\n`, "utf8");
  const captionOf = new Map(post.shorts.captions.map((c) => [c.photo, c.text]));
  const music = pickMusic(config, userId);
  if (music) log(`배경 음악: ${path.basename(music)}`);
  const video = await shortsVideo(photos.map((x) => ({ file: x.file, caption: captionOf.get(x.n) ?? "" })), { title, ending, music, narrate: config.shortsVoice }, path.join(dir, "쇼츠.mp4"), log);
  log(`인스타 사진 ${instagram.length}장과 쇼츠 영상(${video.seconds}초)을 만들었습니다. 아래 '인스타·쇼츠'에서 글을 복사하고 파일을 올려 주세요.`);
  return postSocial(stamp, userId);
}

// 글마다의 폴더에 만들어 둔 인스타·쇼츠 파일과 글 (화면에 보여 줄 것). 폴더가 없으면 null
function postSocial(stamp, userId) {
  const dir = postFile(stamp, "", userId);
  if (!dir) return null;
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").trim() : "");
  const [shortsTitle, ...rest] = read("쇼츠_제목과_설명.txt").split(/\r?\n/);
  return {
    stamp,
    version: Math.round(fs.statSync(dir).mtimeMs), // 다시 만들면 바뀐다 (화면이 예전 파일을 보여 주지 않게)
    instagram: fs.readdirSync(dir).filter((n) => /^인스타_\d+\.jpg$/.test(n)).sort(),
    video: fs.existsSync(path.join(dir, "쇼츠.mp4")) ? "쇼츠.mp4" : "",
    caption: read("인스타_글.txt"),
    shortsTitle: shortsTitle ?? "",
    shortsDescription: rest.join("\n").trim(),
  };
}

// ---------- 지난 글로 인스타·쇼츠 다시 만들기 ----------
// 1.5.0부터 만든 글은 글 내용(JSON)과 원래 사진, 모자이크 자리가 남아 있어서 AI 없이 다시 만든다.
// 인스타·쇼츠 글이 없으면(그 전 버전 글, 끄고 만든 글) AI가 블로그 글과 사진을 보고 그것만 쓴다.
// 그 전 버전 글은 txt의 [사진: 이름]으로 사진 폴더에서 같은 이름의 사진을 찾는다.

const remake = { running: false, stamp: "", logs: [], error: "", social: null };

function startRemake(stamp) {
  if (remake.running) return { ok: false, message: "이미 만들고 있습니다. 끝날 때까지 기다려 주세요." };
  if (job.running || batch.running) return { ok: false, message: "글을 만드는 중입니다. 끝난 뒤에 해 주세요." };
  if (!readPost(`${stamp}.txt`)) return { ok: false, message: "글을 찾을 수 없습니다." };
  Object.assign(remake, { running: true, stamp, logs: [], error: "", social: null });
  const say = (text) => {
    remake.logs.push(text);
    console.log(text);
  };
  remakeSocial(stamp, say)
    .then((social) => (remake.social = social))
    .catch((error) => {
      console.error(error);
      remake.error = `만들지 못했습니다: ${explainError(error)}`;
    })
    .finally(() => (remake.running = false));
  return { ok: true };
}

async function remakeSocial(stamp, say) {
  const userId = currentUser().id;
  const config = loadConfig(userId);
  const saved = readPostData(stamp, userId);
  let originals, faces, post;
  if (saved) {
    ({ originals, faces, post } = saved);
    const missing = originals.filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`글에 썼던 사진을 찾을 수 없습니다 (옮기거나 지운 것 같습니다): ${missing.map((f) => path.basename(f)).join(", ")}`);
  } else {
    ({ originals, post } = oldPost(stamp, config, userId));
  }
  const files = [];
  for (const file of originals) files.push(await readable(file));
  // 모자이크: 글 확인에서 고른 자리가 남아 있으면 그대로, 없으면 지금 설정이 켜져 있을 때 자동으로 찾는다
  if (!faces && config.mosaic) {
    say("사진에서 얼굴을 찾는 중...");
    faces = await findFaces(files);
  }
  if (faces) {
    for (const [i, file] of files.entries()) files[i] = await mosaic(file, faces[i]);
    say(`얼굴 ${faces.reduce((t, list) => t + list.length, 0)}곳을 모자이크한 사진을 씁니다.`);
  }
  if (!post.instagram || !post.shorts) {
    if (!config.apiKey) throw new Error("설정에 API 키가 없습니다.");
    say("AI가 블로그 글과 사진을 보고 인스타그램 글과 쇼츠 글을 쓰는 중... (30초쯤)");
    const social = await generateSocial(config, files, blogText(post));
    recordUsage(social.costWon, "social", userId);
    say(`인스타·쇼츠 글을 썼습니다 (사용료 약 ${social.costWon}원).`);
    post = { ...post, instagram: social.instagram, shorts: social.shorts };
    // 다음에 다시 만들 때는 AI를 부르지 않게 남겨 둔다
    savePostData(stamp, { ...(saved ?? { originals, faces: faces ?? null }), post }, userId);
  }
  return makeSocial(post, files, { userId, config, stamp, log: say });
}

// AI에게 보여 줄 블로그 글 (JSON으로 남긴 글이면 글 내용, 예전 글이면 txt에서 읽은 글)
function blogText(post) {
  if (post.text) return post.text;
  return [post.title, post.intro, ...post.sections.flatMap((s) => [s.caption, s.heading, s.text]), post.outro].filter((t) => t?.trim()).join("\n\n");
}

// 1.5.0 전에 만든 글: txt에서 제목과 글, 사진 이름을 읽고 사진 폴더(와 그 바로 아래 폴더)에서 같은 이름의 사진을 찾는다
function oldPost(stamp, config, userId) {
  const lines = readPost(`${stamp}.txt`, userId).split(/\r?\n/);
  const names = lines.map((l) => l.match(/^\[사진: (.+)\]$/)?.[1]).filter((n) => n && !n.startsWith("맨 위 이미지:"));
  if (!names.length) throw new Error("이 글에는 사진이 없어서 만들 수 없습니다.");
  const root = config.photoFolder;
  if (!root || !fs.existsSync(root)) throw new Error("사진 폴더를 찾을 수 없습니다. 구글 드라이브가 켜져 있는지 확인해 주세요.");
  const byName = new Map();
  for (const folder of [root, ...listSubfolders(root)]) {
    for (const file of listMedia(folder)) if (!byName.has(path.basename(file))) byName.set(path.basename(file), file);
  }
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`사진 폴더에서 이 글에 썼던 사진을 찾지 못했습니다: ${missing.join(", ")}`);
  const text = lines.filter((l) => !/^\[(사진|동영상|지도): .+\]$/.test(l)).join("\n").trim();
  return { originals: names.map((n) => byName.get(n)), post: { title: lines[0], text } };
}

async function runJob(config, body) {
  const photos = body.photos;
  const format = FORMATS[body.format] ? body.format : "daily";
  const social = Boolean(body.social);
  Object.assign(job, { running: true, step: "ai", logs: [], progress: 0, startedAt: Date.now(), result: null, error: "", shot: "", draft: null, social });
  log(`'${FORMATS[format].label}' 형식으로, 사진·동영상 ${photos.length}개를 보고 AI가 글을 씁니다${social ? " (인스타그램 글과 쇼츠 자막도 같이)" : ""}. 보통 1~3분 걸리고, 사진이 많을수록 오래 걸립니다.`);
  try {
    // 아이폰 사진(HEIC)은 JPG로 바꾼 파일을 AI와 네이버에 쓴다
    const files = [];
    for (const file of photos) files.push(await readable(file));
    if (files.some((f, i) => f !== photos[i])) log("아이폰 사진(HEIC)을 JPG로 바꿔서 씁니다.");
    // 얼굴 위치는 AI가 글을 쓰기 전에 찾아 둔다 (미리 보기에서 사용자가 빼거나 더할 수 있다). AI에게는 원래 사진을 보여 준다
    let faces = files.map(() => []);
    if (body.mosaic) {
      log("사진에서 얼굴을 찾는 중... (이 PC 안에서만 찾습니다)");
      faces = await findFaces(files);
      const count = faces.reduce((t, list) => t + list.length, 0);
      log(`얼굴 ${count}곳을 찾았습니다.${body.review ? " 글이 완성되면 '글 확인'에서 모자이크할 곳을 고칠 수 있습니다." : ""}`);
      if (files.some(isVideo)) log("동영상 속 얼굴은 가리지 못합니다. 동영상은 그대로 들어갑니다.");
    }
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
      social,
      notice: Boolean(body.notice),
      inQueue: Boolean(body.inQueue),
      mosaic: Boolean(body.mosaic),
      faces,
      // 하위 폴더 방식은 폴더를, 아니면 사진 하나하나를 '사용함'으로 기록한다
      usedKeys: config.mode === "subfolder" && body.folder ? [body.folder] : photos,
      costWon: 0,
    };
    clearDraft(pending.userId); // 넣다가 실패한 앞 글이 남아 있어도 새 글을 시작하면 그 글은 그만둔 것이다
  } catch (error) {
    job.running = false;
    return fail(error);
  }
  await write();
}

// 미리 보기에서 사용자가 고른 것: accept(고친 글로 네이버에 넣기) / rewrite(다시 써 줘) / cancel(그만두기) / save(고치는 중 자동 저장)
function review({ action, post, request, faces }) {
  if (job.step !== "review" || !pending) return { ok: false, message: "확인할 글이 없습니다." };
  if (action === "cancel") {
    clearDraft(pending.userId);
    Object.assign(job, { step: "", draft: null, logs: [] });
    pending = null;
    return { ok: true };
  }
  const draft = cleanDraft(post, job.draft.post);
  if (pending.mosaic && Array.isArray(faces)) pending.faces = cleanFaces(faces, pending.files.length);
  if (action === "save") {
    const privacy = findPrivate(draft, pending.config);
    Object.assign(job.draft, { post: draft, privacy, faces: pending.mosaic ? pending.faces : null });
    saveDraft();
    return { ok: true, privacy };
  }
  if (action === "accept") {
    rememberEdits(draft);
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

// 사용자가 고친 부분을 다음 글에 반영할 수 있게 남긴다. 실패해도 글 넣기는 막지 않는다
function rememberEdits(draft) {
  if (!pending.aiPost || !pending.config.learnEdits) return;
  try {
    const count = learnEdits(pending.aiPost, draft, pending.userId);
    if (count) log(`고친 내용 ${count}곳을 기억해 두었습니다. 다음 글에 반영합니다.`);
  } catch (error) {
    console.error("고친 내용을 기억하지 못했습니다:", error);
  }
}

// 화면에서 고친 글을 받아 모양을 맞춘다. 사진 자리(photos)는 화면에서 못 바꾸므로 원래 글의 것을 쓴다
function cleanDraft(edited, original) {
  const text = (v) => String(v ?? "");
  return {
    title: text(edited?.title).trim() || original.title,
    titleOptions: original.titleOptions ?? [],
    privacyFlags: original.privacyFlags ?? [],
    intro: text(edited?.intro),
    sections: original.sections.map((s, i) => ({
      photos: s.photos,
      caption: text(edited?.sections?.[i]?.caption ?? s.caption),
      heading: text(edited?.sections?.[i]?.heading ?? s.heading),
      text: text(edited?.sections?.[i]?.text ?? s.text),
    })),
    outro: text(edited?.outro),
    hashtags: Array.isArray(edited?.hashtags) ? tags(edited.hashtags) : original.hashtags,
    ...(original.notice !== undefined && { notice: text(edited?.notice ?? original.notice) }),
    ...(original.instagram && {
      instagram: {
        caption: text(edited?.instagram?.caption ?? original.instagram.caption),
        hashtags: Array.isArray(edited?.instagram?.hashtags) ? tags(edited.instagram.hashtags) : original.instagram.hashtags,
      },
    }),
    ...(original.shorts && {
      shorts: {
        title: text(edited?.shorts?.title ?? original.shorts.title),
        description: text(edited?.shorts?.description ?? original.shorts.description),
        ending: text(edited?.shorts?.ending ?? original.shorts.ending),
        captions: original.shorts.captions.map((c) => ({ photo: c.photo, text: text(edited?.shorts?.captions?.find((e) => e?.photo === c.photo)?.text ?? c.text) })),
      },
    }),
  };
}
const tags = (list) => list.map((t) => String(t ?? "").replace(/^#/, "").trim()).filter(Boolean);

// 화면에서 고친 모자이크 자리 (사진마다 { x, y, w, h } 비율 목록). 이상한 값은 버린다
function cleanFaces(list, count) {
  const ok = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  return Array.from({ length: count }, (_, i) =>
    (Array.isArray(list[i]) ? list[i] : [])
      .map((b) => ({ x: Number(b?.x), y: Number(b?.y), w: Number(b?.w), h: Number(b?.h) }))
      .filter((b) => [b.x, b.y, b.w, b.h].every(ok) && b.w > 0.003 && b.h > 0.003 && b.x + b.w <= 1.001 && b.y + b.h <= 1.001),
  );
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
  if (windowClosed && !job.running && !batch.running && !naverCheck.running && !editor) process.exit(0);
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

// ---------- 설정에서 넣는 파일: 글 맨 위 이미지, 쇼츠 배경 음악 ----------
// 고른 파일을 사용자 폴더(header-images, music)에 복사해 두고, 설정에는 파일 이름 목록만 적는다.

const USER_FILES = {
  header: {
    key: "headerImages",
    exts: new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]),
    wrong: "사진 파일(JPG, PNG, GIF, WEBP, HEIC)만 넣을 수 있습니다.",
    dir: (id) => userPaths(id).header,
  },
  music: {
    key: "music",
    exts: new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg"]),
    wrong: "음악 파일(MP3, M4A, WAV, OGG)만 넣을 수 있습니다.",
    dir: (id) => userPaths(id).music,
  },
};

function userFile(kind, name, userId) {
  if (!USER_FILES[kind] || !/^[^\\/:*?"<>|]+$/.test(name ?? "") || name.startsWith(".")) return null;
  const file = path.join(USER_FILES[kind].dir(userId), name);
  return fs.existsSync(file) ? file : null;
}

async function addUserFile(req, kind, name) {
  const type = USER_FILES[kind];
  if (!type) return { ok: false, message: "알 수 없는 요청입니다." };
  const base = path.basename(String(name ?? "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const ext = path.extname(base).toLowerCase();
  if (!type.exts.has(ext)) return { ok: false, message: type.wrong };
  const dir = type.dir();
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, base);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${path.basename(base, ext)} (${n})${ext}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    req.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  const config = loadConfig();
  saveConfig({ ...config, [type.key]: [...(config[type.key] ?? []), path.basename(target)] });
  return { ok: true, list: loadConfig()[type.key] };
}

// 빼기(remove), 순서 바꾸기(up, down)
function changeUserFile(kind, { action, name }) {
  const type = USER_FILES[kind];
  if (!type) return { ok: false, message: "알 수 없는 요청입니다." };
  const config = loadConfig();
  const list = [...(config[type.key] ?? [])];
  const i = list.indexOf(name);
  if (i < 0) return { ok: false, message: "그 파일을 찾을 수 없습니다." };
  if (action === "remove") {
    list.splice(i, 1);
    const file = userFile(kind, name);
    if (file) fs.rmSync(file, { force: true });
  } else if (action === "up" || action === "down") {
    const j = action === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
  }
  saveConfig({ ...config, [type.key]: list });
  return { ok: true, list };
}

// 프로그램에 들어 있는 무료 음악 (CC0, app/music/catalog.json)
const BUILTIN_MUSIC = path.join(here, "music");
function musicCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BUILTIN_MUSIC, "catalog.json"), "utf8"));
  } catch {
    return [];
  }
}
const builtinMusicFile = (id) => {
  const item = musicCatalog().find((m) => m.id === id);
  const file = item && path.join(BUILTIN_MUSIC, item.file);
  return file && fs.existsSync(file) ? file : null;
};

// 쇼츠에 깔 배경 음악 하나 (직접 넣은 곡과 고른 무료 음악 중 아무거나. 없으면 null)
function pickMusic(config, userId) {
  const files = [
    ...(config.music ?? []).map((name) => userFile("music", name, userId)),
    ...(config.musicBuiltIn ?? []).map(builtinMusicFile),
  ].filter(Boolean);
  return files.length ? files[Math.floor(Math.random() * files.length)] : null;
}

// 글에 넣을 맨 위 이미지 파일들 (없어진 파일은 건너뛴다. HEIC는 JPG로 바꾼 파일)
async function headerImagesFor(config, userId) {
  const files = [];
  for (const name of config.headerImages ?? []) {
    const file = path.join(userPaths(userId).header, name);
    if (fs.existsSync(file)) files.push(await readable(file));
  }
  return files;
}

// 글마다의 인스타·쇼츠 폴더(posts\<만든 시각>) 안 파일. name이 빈 문자열이면 폴더. 없거나 이상한 이름이면 null
function postFile(stamp, name, userId) {
  if (!/^\d{4}(-\d{2}){5}$/.test(stamp ?? "")) return null;
  if (name && (!/^[^\\/:*?"<>|]+$/.test(name) || name.startsWith("."))) return null;
  const file = path.join(userPaths(userId).posts, stamp, name ?? "");
  return fs.existsSync(file) ? file : null;
}

// ---------- 여러 글 차례대로 만들기 ----------
// 대기열에 넣은 글을 하나씩 AI로 쓰고 네이버에 임시저장한다. 글 확인 없이 바로 넣고, 저장이 확인되면 네이버 창을 닫고 다음 글로 간다.
// 문제가 생기면 멈추고 남은 글은 대기열에 그대로 둔다 (다시 시작하면 거기부터 한다)

const batch = { running: false, stopping: false, total: 0, done: [], problem: "" };

function loadQueue(userId) {
  const file = userPaths(userId).queue;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}
const saveQueue = (list, userId) => fs.writeFileSync(userPaths(userId).queue, JSON.stringify(list), "utf8");

function changeQueue({ action, item, id }) {
  if (action === "start") return startQueue();
  if (action === "stop") {
    batch.stopping = true;
    return { ok: true };
  }
  if (action === "remove") {
    if (batch.running) return { ok: false, message: "만드는 중에는 뺄 수 없습니다. 멈춘 뒤에 빼 주세요." };
    saveQueue(loadQueue().filter((q) => q.id !== id));
    return { ok: true };
  }
  if (action === "add") {
    const problem = checkRequest(loadConfig(), item ?? {});
    if (problem) return { ok: false, message: problem };
    const { photos, notes, format, topic, emphasis, memo, folder, folderName, social, mosaic, notice } = item;
    const label = String(topic ?? "").trim() || folderName || `사진 ${photos.length}장`;
    saveQueue([...loadQueue(), { id: crypto.randomUUID(), label, photos, notes, format, topic, emphasis, memo, folder, folderName, social, mosaic, notice }]);
    return { ok: true };
  }
  return { ok: false, message: "알 수 없는 요청입니다." };
}

function startQueue() {
  if (busy()) return { ok: false, message: busy() };
  const userId = currentUser().id;
  const total = loadQueue(userId).length;
  if (!total) return { ok: false, message: "대기열이 비어 있습니다." };
  Object.assign(batch, { running: true, stopping: false, total, done: [], problem: "" });
  runQueue(userId)
    .catch((error) => {
      console.error(error);
      batch.problem = error.message;
    })
    .finally(() => {
      batch.running = false;
      quitIfDone();
    });
  return { ok: true };
}

async function runQueue(userId) {
  // 사용료를 쓰기 전에 네이버 로그인과 화면부터 확인한다
  if (!NO_NAVER) {
    Object.assign(job, { running: true, step: "naver", logs: [], result: null, error: "", shot: "", draft: null, startedAt: Date.now() });
    log("네이버 글쓰기 화면을 먼저 점검합니다.");
    const ok = await testNaver(userId, log);
    Object.assign(job, { running: false, step: "" });
    if (!ok) return void (batch.problem = `${naverCheck.message}\n사용료는 들지 않았고, 대기열은 그대로 있습니다.`);
  }
  for (;;) {
    const [item] = loadQueue(userId);
    if (!item || batch.stopping) return;
    const config = loadConfig(userId);
    const problem = checkRequest(config, item);
    if (problem) return void (batch.problem = `"${item.label}": ${problem}`);
    await runJob(config, { ...item, review: false, inQueue: true });
    if (job.step !== "done") return void (batch.problem = `"${item.label}"에서 멈췄습니다. 남은 글은 대기열에 그대로 있습니다.\n${job.error}`);
    saveQueue(loadQueue(userId).filter((q) => q.id !== item.id), userId);
    const { title, failed, saved, costWon, privacy } = job.result;
    batch.done.push({ title, failed, costWon, privacy });
    // 저장이 확인되지 않았는데 창을 닫으면 글이 네이버에 남지 않는다
    if (!saved && !DRY_RUN) return void (batch.problem = `"${title}"이 임시저장됐는지 확인하지 못해서 멈췄습니다. 네이버 창 오른쪽 위 '저장'을 누르고 창을 닫은 뒤, 남은 글을 다시 시작해 주세요.`);
    await editor?.context.close().catch(() => {});
    editor = null;
  }
}

// ---------- 네이버 화면 점검 ----------
// 글쓰기 화면을 열어 프로그램이 눌러야 할 버튼이 다 있는지만 본다. 아무것도 입력하거나 저장하지 않는다

const naverCheck = { running: false, ok: null, message: "", logs: [] };

const brokenEditor = (names) => `네이버 글쓰기 화면이 바뀐 것 같습니다. 찾지 못한 것: ${names.join(", ")}\n네이버에는 아무것도 넣지 않았습니다. 프로그램을 고쳐야 하니 '문제 보고 파일 만들기'로 만든 파일을 프로그램을 준 사람에게 보내 주세요.`;

// 점검이 끝나면 결과를 naverCheck에 남기고, 글을 넣을 수 있으면 true를 돌려준다
async function testNaver(userId, say) {
  Object.assign(naverCheck, { running: true, ok: null, message: "", logs: [] });
  let opened;
  try {
    opened = await openEditor(loadConfig(userId).blogId, userPaths(userId).profile, say);
    const { broken, partly } = await checkEditor(opened.frame);
    naverCheck.ok = !broken.length;
    naverCheck.message = broken.length ? brokenEditor(broken) : partly.length ? `글은 넣을 수 있지만 찾지 못한 버튼이 있습니다: ${partly.join(", ")}\n이 기능을 쓰는 글은 그 부분만 직접 넣어야 합니다.` : "네이버 글쓰기 화면에 필요한 버튼이 모두 있습니다.";
  } catch (error) {
    console.error(error);
    naverCheck.ok = false;
    naverCheck.message = `네이버 글쓰기 화면을 열지 못했습니다: ${error.message.split("\n")[0]}`;
  } finally {
    await opened?.context.close().catch(() => {});
    naverCheck.running = false;
  }
  console.log(naverCheck.message);
  return naverCheck.ok;
}

function startNaverCheck() {
  if (busy()) return { ok: false, message: busy() };
  const { id } = currentUser();
  if (!loadConfig(id).blogId) return { ok: false, message: "블로그 아이디를 먼저 넣어 주세요." };
  testNaver(id, (text) => {
    naverCheck.logs.push(text);
    console.log(text);
  }).finally(quitIfDone);
  return { ok: true };
}

// ---------- 글 쉬는 날 알림 ----------

// 마지막 글을 만든 지 정해 둔 날짜가 지났으면 며칠인지 돌려준다 (아직 글이 없거나 끈 사용자는 null)
function restedDays() {
  const { restDays } = loadConfig();
  const match = listPosts()[0]?.name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match || !(restDays > 0)) return null;
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(match[1], match[2] - 1, match[3])) / 86_400_000);
  return days >= restDays ? days : null;
}

// ---------- 사용자(블로그) 바꾸기 ----------

// 사용자 추가·바꾸기·이름 바꾸기·지우기. 글을 만드는 중이거나 네이버 창이 열려 있으면 그 사용자의 일이 끝난 뒤에 하게 한다
async function changeUsers({ action, id, name, copyApiKey }) {
  if (action !== "rename" && busy()) return { ok: false, message: busy() };
  name = String(name ?? "").trim();
  if ((action === "add" || action === "rename") && !name) return { ok: false, message: "이름을 적어 주세요." };
  if (action === "add") addUser(name, Boolean(copyApiKey));
  else if (action === "switch") switchUser(id);
  else if (action === "rename") renameUser(id, name);
  else if (action === "remove") removeUser(id);
  else return { ok: false, message: "알 수 없는 요청입니다." };
  if (action !== "rename") Object.assign(job, { step: "", logs: [], result: null, error: "", startedAt: 0, draft: null }); // 앞 사용자의 진행 기록은 보여 주지 않는다
  if (action !== "rename") await restoreDraft();
  return { ok: true, users: loadUsers() };
}

// ---------- 업데이트 ----------

const update = { running: false, logs: [], error: "", done: false };
if (AFTER_ROLLBACK) update.error = "새 버전이 제대로 시작되지 않아서 이전 버전으로 되돌렸습니다. 프로그램은 그대로 쓸 수 있습니다.\n설정 맨 아래 '문제 보고 파일 만들기'로 만든 파일을 프로그램을 준 사람에게 보내 주세요.";

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
${error.notRestored ? "원래대로 되돌리지 못한 파일이 있습니다. 설정 맨 아래 '문제 보고 파일 만들기'로 만든 파일을 프로그램을 준 사람에게 보내 주세요." : "프로그램은 지금 버전 그대로 쓸 수 있습니다."}`;
      console.error(error);
    })
    .finally(() => (update.running = false));
  return { ok: true };
}

// 새 코드로 다시 시작한다: 창과 서버를 닫고, 같은 프로그램을 새로 띄운다.
// 이 프로그램은 아직 옛 코드로 돌고 있으므로, 새 버전이 뜨는 것을 본 뒤에 끝내고 뜨지 않으면 옛 파일로 되돌려 다시 띄운다
async function restart() {
  restarting = true;
  server.close();
  await appWindow?.close().catch(() => {});
  const child = launch("--after-update");
  if (!(await started(child, updateInfo().version))) {
    child.kill();
    const reason = fs.readFileSync(START_ERRORS, "utf8").trim();
    console.error(`새 버전 ${updateInfo().version}이 시작되지 않아서 되돌립니다.\n${reason}`);
    await rollbackUpdate().catch((error) => console.error(error));
    launch("--after-rollback");
  }
  process.exit(0);
}

const START_ERRORS = path.join(DATA_DIR, "start-errors.log");

function launch(flag) {
  const errors = fs.openSync(START_ERRORS, "w");
  const child = spawn(process.execPath, [path.join(here, "app.js"), flag], { cwd: here, detached: true, stdio: ["ignore", "ignore", errors] });
  fs.closeSync(errors);
  child.unref();
  return child;
}

// 새로 띄운 프로그램이 그 버전으로 대답하는지 1분까지 기다린다
async function started(child, version) {
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 120 && !exited; i++) {
    const info = await fetch(`http://127.0.0.1:${PORT}/api/update`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    if (info?.current === version) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ---------- 웹 서버 ----------

function readText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

// 이 프로그램 화면에서 온 요청만 받는다. 같은 PC에서 연 다른 웹사이트가 이 서버로 요청을 보내
// 설정을 바꾸거나(사이트 간 요청 위조) 주소를 바꿔치기해서 API 키를 읽어 가는 것(DNS 리바인딩)을 막는다
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function fromThisApp(req) {
  if (!OWN_HOSTS.has(String(req.headers.host ?? "").toLowerCase())) return false;
  // 브라우저는 다른 사이트에서 보낸 요청에 그 사이트 주소(Origin)를 붙인다. 붙어 있으면 이 프로그램 주소여야 한다
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.toLowerCase().replace(/^http:\/\//, ""))) return false;
  // Origin이 없는 요청(주소창, 사진 불러오기 등)도 다른 사이트에서 보낸 것이면 브라우저가 Sec-Fetch-Site로 알려 준다.
  // 보기만 하는 GET은 다른 사이트가 결과를 읽을 수 없어서 괜찮고, 무언가를 바꾸는 POST만 막는다
  const site = req.headers["sec-fetch-site"];
  if (req.method !== "GET" && site && !["same-origin", "none"].includes(site)) return false;
  return true;
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
  if (!fromThisApp(req)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(here, "app.html")));
    } else if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(fs.readFileSync(path.join(here, "icon.ico")));
    } else if (req.method === "GET" && url.pathname === "/api/config") {
      json({ config: loadConfig(), users: loadUsers(), driveGuess: guessDriveFolder(), maxPhotos: MAX_PHOTOS, musicCatalog: musicCatalog() });
    } else if (req.method === "POST" && url.pathname === "/api/config") {
      saveConfig({ ...loadConfig(), ...(await readBody(req)) });
      json({ ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/users") {
      json(await changeUsers(await readBody(req)));
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
    } else if (req.method === "GET" && url.pathname === "/api/job-photo") {
      // 글 확인의 모자이크 고르기 화면에 보여 줄, 지금 만드는 글의 사진 (휴대폰 회전 정보대로 돌린 모양)
      const file = pending?.files[Number(url.searchParams.get("i"))];
      if (!file || isVideo(file)) return notFound();
      const view = await sharp(file, { failOn: "none" }).rotate().resize(900, 900, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(view);
    } else if (req.method === "GET" && url.pathname === "/api/post-file") {
      // 인스타·쇼츠 파일 (posts\<만든 시각>\ 안의 것만)
      const file = postFile(url.searchParams.get("post"), url.searchParams.get("name"));
      if (!file) return notFound();
      if (file.endsWith(".mp4")) return sendVideo(req, res, file);
      res.writeHead(200, { "Content-Type": file.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8" });
      fs.createReadStream(file).pipe(res);
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
    } else if (req.method === "POST" && url.pathname === "/api/photo-check") {
      // 흐린 사진과 거의 같은 사진 찾기
      const items = [];
      for (const file of (await readBody(req)).paths ?? []) {
        if (!inPhotoFolder(file) || isVideo(file)) continue;
        const thumb = await thumbnail(file).catch(() => "");
        if (thumb) items.push({ path: file, thumb });
      }
      json({ ok: true, count: items.length, flags: await checkPhotos(items) });
    } else if (req.method === "GET" && url.pathname === "/api/queue") {
      json({ items: loadQueue(), batch });
    } else if (req.method === "POST" && url.pathname === "/api/queue") {
      json(changeQueue(await readBody(req)));
    } else if (req.method === "GET" && url.pathname === "/api/naver-check") {
      json(naverCheck);
    } else if (req.method === "POST" && url.pathname === "/api/naver-check") {
      json(startNaverCheck());
    } else if (req.method === "GET" && url.pathname === "/api/learned") {
      json(loadLearned());
    } else if (req.method === "POST" && url.pathname === "/api/learned") {
      json(forgetLearned((await readBody(req)).id));
    } else if (req.method === "POST" && url.pathname === "/api/settings-export") {
      const file = exportSettings();
      if (!NO_WINDOW) exec(`explorer /select,"${file}"`);
      json({ ok: true, file });
    } else if (req.method === "POST" && url.pathname === "/api/settings-import") {
      if (busy()) return json({ ok: false, message: busy() });
      json({ ok: true, ...importSettings(await readText(req)) });
    } else if (req.method === "POST" && url.pathname === "/api/problem-report") {
      // 프로그램을 준 사람에게 보낼 파일을 만들고 탐색기로 보여 준다
      const file = writeReport({ version: VERSION, config: loadConfig(), users: loadUsers().list.length, latest: updateInfo(), jobError: job.error && errorReport(), updateError: update.error, naverCheck: naverCheck.ok === false ? naverCheck.message : "" });
      if (!NO_WINDOW) exec(`explorer /select,"${file}"`);
      json({ ok: true, file });
    } else if (req.method === "POST" && url.pathname === "/api/open") {
      // 탐색기로 보여 준다: 지난 글 폴더, 오류 화면 사진
      const { what, post } = await readBody(req);
      const postDir = postFile(post, "");
      if (what === "posts") {
        fs.mkdirSync(userPaths().posts, { recursive: true });
        exec(`explorer "${userPaths().posts}"`);
      } else if (what === "shot" && job.shot && fs.existsSync(job.shot)) {
        exec(`explorer /select,"${job.shot}"`);
      } else if (what === "post-folder" && postDir) {
        exec(`explorer "${postDir}"`);
      } else if (what === "instagram" || what === "youtube") {
        // 평소 쓰는 브라우저로 연다 (거기에 인스타그램·유튜브 로그인이 되어 있다)
        exec(`start "" "${what === "instagram" ? "https://www.instagram.com/" : "https://studio.youtube.com/"}"`);
      }
      json({ ok: true });
    } else if (req.method === "GET" && url.pathname === "/api/stats") {
      json({ enabled: statsEnabled() });
    } else if (req.method === "POST" && url.pathname === "/api/stats") {
      setStatsEnabled((await readBody(req)).enabled);
      json({ ok: true, enabled: statsEnabled() });
    } else if (req.method === "GET" && url.pathname === "/api/usage") {
      const { warnWon } = loadConfig();
      const spent = monthWon();
      json({ ...usageSummary(), warn: warnWon > 0 && spent >= warnWon ? { spent, limit: warnWon } : null, rested: restedDays() });
    } else if (req.method === "GET" && url.pathname === "/api/posts") {
      json(listPosts());
    } else if (req.method === "GET" && url.pathname === "/api/post") {
      const text = readPost(url.searchParams.get("name"));
      json(text === null ? { ok: false, message: "글을 찾을 수 없습니다." } : { ok: true, text });
    } else if (req.method === "POST" && url.pathname === "/api/user-file") {
      // 설정에서 넣는 파일 (kind=header: 글 맨 위 이미지, kind=music: 쇼츠 배경 음악)
      json(await addUserFile(req, url.searchParams.get("kind"), url.searchParams.get("name")));
    } else if (req.method === "POST" && url.pathname === "/api/user-file/change") {
      json(changeUserFile(url.searchParams.get("kind"), await readBody(req)));
    } else if (req.method === "GET" && url.pathname === "/api/voice-preview") {
      // 설정에서 AI 목소리 들어 보기 (한 번 만든 것을 다시 쓴다)
      const file = path.join(DATA_DIR, "voice-preview.wav");
      if (!fs.existsSync(file)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blogwriter-voice-"));
        try {
          const [made] = await speak(["안녕하세요. 쇼츠 영상의 자막을 이런 목소리로 읽어 드려요."], dir);
          fs.copyFileSync(path.join(dir, made), file);
        } catch (error) {
          return json({ ok: false, message: error.message });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    } else if (req.method === "GET" && url.pathname === "/api/music-file") {
      // 설정에서 미리 들어 보기
      const file = url.searchParams.get("builtin") ? builtinMusicFile(url.searchParams.get("builtin")) : userFile("music", url.searchParams.get("name"));
      if (!file) return notFound();
      const type = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg" }[path.extname(file).toLowerCase()];
      res.writeHead(200, { "Content-Type": type, "Content-Length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    } else if (req.method === "GET" && url.pathname === "/api/post-social") {
      const stamp = url.searchParams.get("post");
      const saved = readPostData(stamp);
      json({ social: postSocial(stamp), needsAi: !(saved?.post?.instagram && saved?.post?.shorts), notice: saved ? noticeFor(saved.post, loadConfig().blogId) : "" });
    } else if (req.method === "POST" && url.pathname === "/api/remake") {
      json(startRemake((await readBody(req)).post));
    } else if (req.method === "GET" && url.pathname === "/api/remake") {
      json(remake);
    } else if (req.method === "GET" && url.pathname === "/api/header-thumb") {
      const file = userFile("header", url.searchParams.get("name"));
      if (!file) return notFound();
      // 배너는 잘리지 않게 전체를 줄여서 보여 준다 (사진 고르기의 정사각형 미리보기와 다르게)
      const preview = await sharp(await readable(file), { failOn: "none" }).rotate().resize(400, 300, { fit: "inside" }).png().toBuffer();
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(preview);
    } else if (req.method === "POST" && url.pathname === "/api/upload") {
      json(await upload(req, url.searchParams.get("name"), url.searchParams.get("sub")));
    } else if (req.method === "GET" && url.pathname === "/api/update") {
      json({ ...updateInfo(), current: VERSION, ...update });
    } else if (req.method === "POST" && url.pathname === "/api/update/check") {
      json({ ...(await checkUpdate()), current: VERSION });
    } else if (req.method === "POST" && url.pathname === "/api/update") {
      json(startUpdate());
    } else if (NO_WINDOW && req.method === "POST" && url.pathname === "/api/test-shot") {
      // 시험용: 열려 있는 네이버 글쓰기 창을 사진으로 남긴다
      json({ ok: Boolean(editor), file: editor ? await screenshot(editor.page, "test") : "" });
    } else if (NO_WINDOW && req.method === "POST" && url.pathname === "/api/quit") {
      json({ ok: true });
      setTimeout(() => process.exit(0), 100);
    } else if (req.method === "GET" && url.pathname === "/api/job") {
      json({
        ...job,
        elapsed: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
        editorOpen: Boolean(editor),
        batch,
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
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`블로그 글 생성기 ${VERSION} 창을 엽니다. 이 검은 창은 프로그램 창을 닫으면 저절로 닫힙니다.`);
  for (const user of loadUsers().list) loadConfig(user.id); // 예전 버전이 그대로 적어 둔 API 키를 잠근다
  await restoreDraft();
  if (!NO_WINDOW) openWindow(address);
  checkUpdate(); // 새 버전이 있으면 화면 위쪽에 알려 준다
  report("open"); // 익명 사용 통계 (하루 한 번, 설정에서 끌 수 있다)
});
