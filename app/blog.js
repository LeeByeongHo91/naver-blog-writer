// 네이버 블로그에서 블로그 이름, 최근 글 목록, 글 본문을 읽는다. 로그인 없이 누구나 볼 수 있는 공개 글만 읽힌다.
// 설정 '내 글 예시'를 복사·붙여넣기 대신 버튼으로 채우는 데 쓴다.
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0" };

export const isBlogId = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(id ?? "");

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`네이버에서 읽지 못했습니다 (${res.status}).`);
  return res.text();
}

const cdata = (text = "") => text.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
const tag = (xml, name) => cdata(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]);

// 블로그 RSS. 없는 아이디, 글이 없는 블로그, RSS를 꺼 둔 블로그는 이름도 글도 비어서 온다
export async function recentPosts(blogId) {
  const xml = await get(`https://rss.blog.naver.com/${blogId}.xml`);
  const posts = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const date = new Date(tag(item, "pubDate"));
      return {
        logNo: tag(item, "guid").match(/(\d+)\s*$/)?.[1],
        title: tag(item, "title"),
        category: tag(item, "category"),
        date: isNaN(date) ? "" : `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`,
      };
    })
    .filter((p) => p.logNo);
  return { name: tag(xml.split("<item>")[0], "title"), posts };
}

function decode(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
    if (code[0] === "#") return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return named[code.toLowerCase()] ?? all;
  });
}

// 글 본문을 네이버 화면에서 복사한 것과 같은 모양(줄마다 빈 줄 하나, 빈 문단은 빈 줄이 하나 더)으로 돌려준다.
// 그래야 config.js의 cleanSample이 붙여넣은 글과 똑같이 다듬는다
export async function postText(blogId, logNo) {
  const html = await get(`https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`);
  const start = html.indexOf("se-main-container");
  if (start < 0) throw new Error("이 글은 예전 편집기로 쓴 글이거나 비공개라서 가져올 수 없습니다. 다른 글을 골라 주세요.");
  const lines = [...html.slice(start).matchAll(/<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g)].map(([, inner]) =>
    decode(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      .replace(/[​﻿]/g, "")
      .trim(),
  );
  const text = lines.join("\n\n").trim();
  if (!text) throw new Error("이 글에서 글자를 찾지 못했습니다. 사진만 있는 글일 수 있습니다.");
  return text;
}
