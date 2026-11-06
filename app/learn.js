// 글 확인에서 블로그 주인이 AI 글을 고친 부분을 기억해 두고, 다음 글을 쓸 때 AI에게 보여 준다.
// 고치기 전과 뒤의 문장만 사용자 폴더(learned.json)에 남긴다. AI를 따로 부르지 않아서 사용료는 거의 늘지 않는다
import crypto from "node:crypto";
import fs from "node:fs";
import { userPaths } from "./config.js";

const KEEP = 20; // 기억해 둘 개수 (오래된 것부터 지운다)
const PER_POST = 6; // 글 하나에서 배울 최대 개수
const MAX_TEXT = 160;

const sentences = (text) => String(text ?? "").split(/(?<=[.!?…~\n])\s*/).map((s) => s.trim()).filter(Boolean);
const squash = (text) => text.replace(/\s+/g, "");

// 양쪽에 똑같이 있는 문장을 빼고 달라진 문장만 남긴다
function changed(before, after) {
  const a = sentences(before);
  const b = sentences(after);
  const inA = new Set(a);
  const inB = new Set(b);
  return { before: a.filter((s) => !inB.has(s)).join(" ").slice(0, MAX_TEXT), after: b.filter((s) => !inA.has(s)).join(" ").slice(0, MAX_TEXT) };
}

export function loadLearned(id) {
  const file = userPaths(id).learned;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

const saveLearned = (list, id) => fs.writeFileSync(userPaths(id).learned, JSON.stringify(list), "utf8");

// ai: AI가 쓴 그대로의 글, final: 사용자가 고친 글. 배운 개수를 돌려준다
export function learnEdits(ai, final, id) {
  const pairs = [[ai.intro, final.intro], [ai.outro, final.outro]];
  ai.sections.forEach((section, i) => {
    for (const key of ["heading", "caption", "text"]) pairs.push([section[key], final.sections[i]?.[key]]);
  });
  // 제목 후보에서 고른 것은 고친 것이 아니다
  if (!ai.titleOptions?.includes(final.title)) pairs.unshift([ai.title, final.title]);
  const edits = pairs
    .map(([before, after]) => changed(before, after))
    .filter(({ before, after }) => squash(before) !== squash(after) && (before.length > 1 || after.length > 1))
    .slice(0, PER_POST);
  if (!edits.length) return 0;
  const list = [...loadLearned(id), ...edits.map((e) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), ...e }))];
  saveLearned(list.slice(-KEEP), id);
  return edits.length;
}

// 설정에서 지운다. itemId가 없으면 전부
export function forgetLearned(itemId, id) {
  saveLearned(itemId ? loadLearned(id).filter((e) => e.id !== itemId) : [], id);
  return loadLearned(id);
}
