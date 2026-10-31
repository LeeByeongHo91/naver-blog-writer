// 새 버전 확인과 업데이트. GitHub에 새 버전(릴리스)이 올라오면 각자의 프로그램이 그 zip을 받아 프로그램 폴더의 파일을 바꾼다.
// 설정, 네이버 로그인, 말투 예시는 %LOCALAPPDATA%\BlogWriter에 있어서 업데이트해도 그대로다.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "./config.js";

export const REPO = "LeeByeongHo91/naver-blog-writer";
const ASSET = "blog-writer.zip"; // 릴리스에 붙이는 파일 (4_다른 사람에게 줄 파일 만들기로 만든 zip과 같은 내용)
// 시험용: BLOGWRITER_UPDATE_API 로 GitHub 대신 다른 주소에서 최신 버전 정보를 읽는다
const RELEASE_API = process.env.BLOGWRITER_UPDATE_API ?? `https://api.github.com/repos/${REPO}/releases/latest`;
const PROGRAM_DIR = path.join(import.meta.dirname, "..");
const OBSOLETE = ["블로그글생성기.html"]; // 업데이트할 때 지울 예전 파일 (프로그램 폴더 기준)
export const VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8")).version;
const run = promisify(execFile);

// "1.10.0"이 "1.9.2"보다 새 버전인지
function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

let latest = { current: VERSION, available: false };
export const updateInfo = () => latest;

// GitHub의 최신 릴리스를 확인한다. 인터넷이 안 되거나 GitHub이 대답하지 않으면 '새 버전 없음'으로 둔다
export async function checkUpdate() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "blog-writer" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return latest;
    const release = await res.json();
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    const asset = release.assets?.find((a) => a.name === ASSET);
    latest = { current: VERSION, version, notes: release.body ?? "", url: asset?.browser_download_url, available: Boolean(asset) && isNewer(version, VERSION) };
  } catch {}
  return latest;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// 새 버전을 받아 프로그램 폴더에 덮어쓴다. 내용이 같은 파일은 건드리지 않는다
// (지금 실행 중인 .bat 파일을 바꾸면 cmd가 엉뚱한 줄을 읽을 수 있어서 바뀐 파일만 쓴다).
// 프로그램 폴더에만 있는 파일(예전 *말투 폴더 등)은 지우지 않는다. log: 진행 상황을 받는 함수
export async function applyUpdate(log) {
  const info = latest.available ? latest : await checkUpdate();
  if (!info.available) throw new Error("새 버전이 없습니다.");
  const work = path.join(DATA_DIR, "update");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  log(`새 버전 ${info.version}을 내려받는 중...`);
  const res = await fetch(info.url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`새 버전을 내려받지 못했습니다 (${res.status}). 인터넷 연결을 확인해 주세요.`);
  const zip = path.join(work, ASSET);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  log("압축을 푸는 중...");
  const out = path.join(work, "files");
  const quote = (p) => `'${p.replace(/'/g, "''")}'`;
  // Expand-Archive는 PC 보안 설정(스크립트 실행 정책)에 따라 막힐 수 있어서 .NET 압축 풀기를 바로 쓴다
  await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)}, ${quote(out)})`,
  ]).catch((error) => {
    throw new Error(`압축을 풀지 못했습니다. ${String(error.stderr || error.message).trim().split(/\r?\n/)[0]}`);
  });
  const src = path.join(out, "블로그글생성기");
  if (!fs.existsSync(path.join(src, "app", "app.js"))) throw new Error("받은 파일이 올바르지 않습니다. 잠시 뒤 다시 해 주세요.");

  log("프로그램 파일을 바꾸는 중...");
  const packageFile = path.join(PROGRAM_DIR, "app", "package.json");
  const dependencies = () => JSON.stringify(JSON.parse(fs.readFileSync(packageFile, "utf8")).dependencies);
  const before = dependencies();
  let changed = 0;
  for (const file of walk(src)) {
    const dest = path.join(PROGRAM_DIR, path.relative(src, file));
    const data = fs.readFileSync(file);
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(data)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    changed++;
  }
  // 예전 버전에만 있던 파일은 지운다
  for (const name of OBSOLETE) fs.rmSync(path.join(PROGRAM_DIR, name), { force: true });
  if (dependencies() !== before) {
    log("필요한 구성 요소를 새로 까는 중... (1~2분 걸릴 수 있습니다)");
    await run("cmd.exe", ["/c", "npm", "install", "--no-fund", "--no-audit"], { cwd: path.join(PROGRAM_DIR, "app"), timeout: 600000 });
  }
  fs.rmSync(work, { recursive: true, force: true });
  log(`${info.version} 버전으로 바꿨습니다 (파일 ${changed}개). 프로그램을 다시 시작합니다. 창이 잠깐 닫혔다가 다시 열립니다.`);
  return info.version;
}
