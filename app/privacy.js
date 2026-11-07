// 발행 전 개인정보 점검. 글에서 전화번호 같은 정해진 모양은 이 PC에서 찾고, 사람 이름과 사진 속 글자는 AI가 글을 쓸 때 같이 표시해 준다(post.privacyFlags).
// 표시만 하고 글을 바꾸지는 않는다. 설정에 적어 둔 가게 주소·대표 전화처럼 일부러 알리는 내용은 빼고 보여 준다
const PLATE_LETTERS = "가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주아바사자하허호배";
const RULES = [
  { kind: "전화번호", pattern: /(?<![\d-])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?![\d-])/g },
  { kind: "주민등록번호", pattern: /(?<!\d)\d{6}[-\s]?[1-4]\d{6}(?!\d)/g },
  { kind: "이메일", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: "차량 번호", pattern: new RegExp(`(?<![\\d가-힣])\\d{2,3}[${PLATE_LETTERS}]\\s?\\d{4}(?!\\d)`, "g") },
  { kind: "상세 주소", pattern: /\d+동\s?\d+호|\d+(?:-\d+)?번지/g },
];

const squash = (text) => String(text ?? "").replace(/[\s.-]+/g, "");

// 글자만 보고 정해진 모양의 개인정보가 있는지 본다 (이름은 알 수 없다)
export const hasPrivatePattern = (text) => RULES.some(({ pattern }) => String(text ?? "").search(pattern) >= 0);

// 글에서 사람이 읽는 곳 전부 (어디에 있는지 알려 주려고 이름을 붙인다)
function postFields(post) {
  const fields = [["제목", post.title], ...(post.titleOptions ?? []).map((t) => ["제목 후보", t]), ["도입", post.intro]];
  post.sections.forEach((s, i) => fields.push(...[s.caption, s.heading, s.text].map((text) => [`본문 ${i + 1}번째`, text])));
  fields.push(["마무리", post.outro], ["해시태그", post.hashtags.join(" ")]);
  if (post.notice) fields.push(["카카오톡 공지문", post.notice]);
  if (post.instagram) fields.push(["인스타그램 글", post.instagram.caption], ["인스타그램 해시태그", post.instagram.hashtags.join(" ")]);
  if (post.shorts) fields.push(...[post.shorts.title, post.shorts.description, post.shorts.ending, ...post.shorts.captions.map((c) => c.text)].map((text) => ["쇼츠", text]));
  return fields.filter(([, text]) => text);
}

// 블로그 주인이 설정에 적어 둔 내용 (여기 있는 말은 일부러 알리는 것으로 본다)
function ownText(config) {
  return squash([config.footer, config.blogAbout, config.memo, config.fixedHashtags, config.aiRequests, ...(config.styleSamples ?? []), ...(config.repeatPhrases ?? []).map((p) => p.text)].join("\n"));
}

// 돌려주는 값: [{ kind, text, where }]
export function findPrivate(post, config) {
  const own = ownText(config);
  const fields = postFields(post);
  const found = new Map();
  const add = (kind, text, where) => found.set(`${kind}|${text}|${where}`, { kind, text, where });
  for (const [where, value] of fields) {
    for (const { kind, pattern } of RULES) {
      for (const [text] of value.matchAll(pattern)) if (!own.includes(squash(text))) add(kind, text, where);
    }
  }
  for (const { kind, text, photo } of post.privacyFlags ?? []) {
    if (!text?.trim() || own.includes(squash(text))) continue;
    if (photo > 0) add(kind, text, `사진 ${photo}번`);
    // 글에서 지웠으면 더 보여 주지 않는다
    else for (const [where, value] of fields) if (squash(value).includes(squash(text))) add(kind, text, where);
  }
  return [...found.values()];
}

// 기록에 남길 짧은 글 (개인정보 자체는 기록 파일에 남기지 않고 종류와 개수만 적는다)
export function privacySummary(items) {
  const counts = new Map();
  for (const { kind } of items) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${kind} ${count}곳`).join(", ");
}
