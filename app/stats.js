// 익명 사용 통계: 몇 대의 PC에서 이 프로그램을 쓰고 있는지 프로그램을 만든 사람이 알 수 있게 한다.
// 보내는 것은 이 PC에 처음 만든 무작위 번호, 프로그램 버전, 일의 종류("open" 하루 한 번 켬 / "post" 글 하나 만듦)뿐이다.
// 이름, 블로그 아이디, API 키, 글, 사진은 보내지 않는다. 설정 > 고급 설정에서 끌 수 있다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { REPO, VERSION } from "./update.js";

const FILE = path.join(DATA_DIR, "stats.json");
// 받을 주소는 GitHub 저장소의 파일에 적어 둔다 (주소가 바뀌어도 새 버전을 내지 않아도 되게). 파일이 없으면 아무것도 보내지 않는다
const ENDPOINT_FILE = `https://raw.githubusercontent.com/${REPO}/main/stats-endpoint.txt`;
// 시험할 때는 보내지 않는다
const OFF = ["BLOGWRITER_DRY_RUN", "BLOGWRITER_NO_WINDOW", "BLOGWRITER_NO_STATS"].some((name) => process.env[name] === "1");

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {}
  if (!saved.id) {
    saved = { enabled: true, ...saved, id: crypto.randomUUID() };
    save(saved);
  }
  return saved;
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

export const statsEnabled = () => load().enabled !== false;

export function setStatsEnabled(enabled) {
  save({ ...load(), enabled: Boolean(enabled) });
}

const today = () => new Date().toLocaleDateString("sv-SE"); // 2026-11-02

async function endpoint(data) {
  if (data.endpointDay === today()) return data.endpoint ?? "";
  try {
    const res = await fetch(ENDPOINT_FILE, { signal: AbortSignal.timeout(5000) });
    const url = res.ok ? (await res.text()).trim() : "";
    data.endpoint = /^https:\/\/script\.google\.com\/\S+$/.test(url) ? url : "";
  } catch {
    return "";
  }
  data.endpointDay = today();
  return data.endpoint;
}

// event: "open"(하루에 한 번만 보낸다) | "post". 인터넷이 안 되거나 실패해도 프로그램에는 아무 영향이 없다
export async function report(event) {
  if (OFF) return;
  try {
    const data = load();
    if (data.enabled === false) return;
    if (event === "open" && data.lastOpen === today()) return;
    const url = await endpoint(data);
    save(data);
    if (!url) return;
    const query = new URLSearchParams({ id: data.id, v: VERSION, e: event });
    const res = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok && event === "open") save({ ...load(), lastOpen: today() });
  } catch {}
}
