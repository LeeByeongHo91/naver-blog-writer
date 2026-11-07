import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { loadStyleSamples, isVideo } from "./config.js";

const MODEL = "claude-opus-5-5";
const MAX_EDGE = 1568; // 이보다 큰 사진은 줄여서 보낸다 (API가 어차피 이 크기로 줄여서 봄)

const SYSTEM = `당신은 네이버 블로그 글을 대신 써 주는 작가입니다. 사용자가 올린 사진들을 직접 보고, 블로그 주인이 직접 다녀와서 쓴 것처럼 자연스러운 1인칭 글을 씁니다.

글의 구성:
- 제목: 검색에 잘 걸리도록 주제의 핵심 단어를 넣되, 과장된 낚시성 제목은 피합니다.
- 도입: 글을 여는 짧은 인사와 소개.
- 본문: 사용자가 고른 '글 형식'에 따라 짭니다. 어떤 형식이든 받은 사진과 동영상은 빠짐없이 정확히 한 번씩 사용합니다.
- 마무리: 총평이나 전하고 싶은 말.
- 해시태그: 주제와 관련된 것 8~12개.

동영상이 섞여 있으면 사진과 같은 번호 체계로 받고, 사진처럼 글 사이에 배치합니다. 동영상은 한 장면만 보이므로, 그 장면에 보이지 않는 내용은 추측해서 쓰지 않습니다.

사용자가 "읽는 사람에게 강조하고 싶은 점"을 알려 주면 그것이 글 전체의 중심입니다. 제목과 도입에서 그 점을 먼저 꺼내고, 본문에서 그 점이 드러나는 부분을 골라 풀어 가며, 마무리에서 한 번 더 짚어 줍니다. 같은 단어를 기계적으로 반복하지 말고, 사진에 보이는 구체적인 모습으로 그 점을 뒷받침합니다. 사진에서 그 점이 보이지 않는 부분은 억지로 끼워 맞추지 않습니다.

사실 관계가 중요합니다. 가게 이름, 주소, 가격, 영업시간, 메뉴 이름 같은 정보는 사용자가 메모로 알려 줬거나 사진 속에 글자로 분명히 보일 때만 씁니다. 모르는 정보는 지어내지 말고 그냥 언급하지 않습니다. 독자가 그 정보를 믿고 찾아갈 수 있기 때문입니다. 같은 이유로, 실제로 있었는지 알 수 없는 일화나 누군가 했다는 말도 지어내지 않습니다.

결과는 네이버 편집기에 그대로 입력되므로 마크다운 기호(#, *, - 등)는 쓰지 않습니다. 글 안에서 줄을 바꿀 때는 줄바꿈을, 문단 사이를 띄울 때는 빈 줄 하나를 씁니다. 네이버 블로그는 모바일로 많이 보니 한 문단은 짧게 끊어 줍니다.`;

// 글 형식. 글 만들기 화면에서 고른다. freeOrder면 AI가 글 흐름에 맞는 자리에 사진을 놓고(순서가 바뀔 수 있음),
// 아니면 블로그 주인이 정한 사진 순서를 그대로 지킨다.
// 어떤 블로그든 쓸 수 있게 형식에는 분야를 적지 않고, 분야와 독자는 설정의 '블로그 소개'(blogAbout)로 따로 알려 준다.
export const FORMATS = {
  daily: {
    label: "일상 데일리",
    freeOrder: false,
    guide: `글 형식: 일상 데일리
- 블로그 주인의 하루나 공간(가게, 매장, 도장, 학원, 집 등)을 사진과 함께 가볍게 보여 주는 글입니다.
- 사진 순서대로, 각 사진 아래에 그 사진에 실제로 보이는 장면(사람들의 표정과 동작, 그 자리의 분위기, 공간과 물건의 모습)을 구체적으로 묘사하는 글을 붙입니다. 비슷한 사진 여러 장은 한 묶음으로 묶어도 됩니다.
- 읽는 사람이 그 현장을 옆에서 엿보는 느낌이 들도록 편안하게 씁니다.`,
  },
  column: {
    label: "정보 칼럼",
    freeOrder: true,
    guide: `글 형식: 정보 칼럼
- 사진을 설명하는 글이 아니라, 블로그 분야의 주제 하나(정보, 노하우, 고르는 법, 블로그 주인의 생각이나 철학 등)를 깊이 있게 풀어 가는 글입니다. 사진보다 글의 완성도와 내용이 중요합니다.
- 주제는 블로그 주인이 적어 준 주제·강조점·하고 싶은 이야기에서 잡습니다. 아무것도 없으면 사진에서 자연스럽게 이어지는 주제를 하나 정합니다.
- 도입에서 읽는 사람이 공감할 만한 질문이나 고민을 꺼내고, 본문은 소제목 2~4개로 생각과 이유를 단계적으로 풀어 가며, 마무리에서 읽는 사람에게 전하는 메시지로 정리합니다.
- 사진과 동영상은 그 내용을 뒷받침하는 문단 옆에 놓습니다. 받은 번호 순서와 달라도 됩니다. 사진을 하나하나 설명하지 말고 사진 아래에는 짧은 한 줄 설명(caption)만 붙입니다. 사진 없이 글만 있는 부분(photos가 빈 배열)이 있어도 됩니다.
- 분야에 관한 일반적인 이야기는 써도 되지만, 확실하지 않은 수치, 연구 결과, 가격, 일정과 제도 같은 구체적 사실은 블로그 주인이 적어 준 경우에만 씁니다.`,
  },
  vlog: {
    label: "브이로그·후기",
    freeOrder: false,
    guide: `글 형식: 브이로그·후기
- 행사, 대회, 여행, 나들이처럼 어딘가를 다녀온 하루를 시간 순서대로 따라가는 후기입니다.
- 사진 순서가 곧 시간 순서입니다. 출발과 도착, 현장 분위기, 그날의 주요 장면, 결과와 마무리, 돌아오는 길과 소감처럼 그때그때의 장면과 느낌을 이어 가며 씁니다.
- 현장에 함께 있는 듯한 생생한 1인칭으로 쓰고, 사진과 사진 사이를 이어 주는 말로 흐름이 끊기지 않게 합니다.
- 행사·장소 이름, 날짜, 결과(메달, 순위 등)는 블로그 주인이 적어 준 것이나 사진 속 글자로 분명히 보이는 것만 씁니다.`,
  },
};

// 설정의 '글 끝에 항상 붙일 내용'에서 //로 시작하는 안내 줄을 뺀 실제 내용
export function footerText(footer = "") {
  return footer.split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n").trim();
}

// 설정 '항상 지킬 요청'을 AI에게 줄 문장으로 만든다. 없으면 빈 문자열
function standingRequests(config) {
  const rules = [];
  for (const { from, to } of config.replaceWords ?? []) {
    if (from?.trim() && to?.trim()) rules.push(`'${from.trim()}'이라는 말은 쓰지 않고 항상 '${to.trim()}'(으)로 씁니다.`);
  }
  for (const { text, times } of config.repeatPhrases ?? []) {
    if (text?.trim()) rules.push(`'${text.trim()}'라는 말을 도입·본문·마무리에 걸쳐 모두 ${times || "2~3"}번, 글 흐름에 자연스럽게 녹여서 넣습니다. 같은 문단에 몰아넣거나 억지로 끼워 넣지 않습니다. (제목, 해시태그, 글 끝 고정 부분은 세지 않습니다)`);
  }
  for (const line of (config.aiRequests ?? "").split(/\r?\n/)) {
    if (line.trim()) rules.push(line.trim());
  }
  if (!rules.length) return "";
  return `\n\n블로그 주인이 매번 꼭 지켜 달라고 한 요청입니다. 예시 글이나 다른 안내와 다르면 이 요청을 따릅니다:\n${rules.map((r) => `- ${r}`).join("\n")}`;
}

// 다 쓴 글에 '단어 바꾸기'를 한 번 더 적용하고, '반복할 말'이 몇 번 들어갔는지 센다. 사용자에게 보여 줄 문장 목록을 돌려준다
function applyStandingRequests(post, config) {
  const notes = [];
  const pairs = (config.replaceWords ?? []).filter((p) => p.from?.trim() && p.to?.trim());
  let replaced = 0;
  const fix = (text) => pairs.reduce((t, { from, to }) => {
    const parts = t.split(from.trim());
    replaced += parts.length - 1;
    return parts.join(to.trim());
  }, text);
  if (pairs.length) {
    post.title = fix(post.title);
    if (post.titleOptions) post.titleOptions = post.titleOptions.map(fix);
    if (post.notice) post.notice = fix(post.notice);
    post.intro = fix(post.intro);
    post.outro = fix(post.outro);
    for (const s of post.sections) Object.assign(s, { caption: fix(s.caption), heading: fix(s.heading), text: fix(s.text) });
    post.hashtags = post.hashtags.map(fix);
    if (post.instagram) Object.assign(post.instagram, { caption: fix(post.instagram.caption), hashtags: post.instagram.hashtags.map(fix) });
    if (post.shorts) {
      Object.assign(post.shorts, { title: fix(post.shorts.title), description: fix(post.shorts.description), ending: fix(post.shorts.ending) });
      for (const c of post.shorts.captions) c.text = fix(c.text);
    }
    if (replaced) notes.push(`단어 바꾸기: AI가 놓친 ${replaced}곳을 프로그램이 바꿨습니다.`);
  }
  const body = [post.intro, ...post.sections.flatMap((s) => [s.caption, s.heading, s.text]), post.outro].join("\n");
  const squash = (t) => t.replace(/\s+/g, "");
  for (const { text, times } of config.repeatPhrases ?? []) {
    if (!text?.trim()) continue;
    const count = squash(body).split(squash(text)).length - 1;
    const min = Number(String(times || "2").match(/\d+/)?.[0] ?? 1);
    notes.push(`'${text.trim()}' 본문에 ${count}번 들어감${count < min ? ` (원하는 ${times}번보다 적습니다. 네이버 창에서 직접 넣어 주세요)` : ""}`);
  }
  return notes;
}

// 블로그 주인이 직접 쓴 글이 있으면 그 글을 본보기로 붙인다
function styleGuide(samples, footer) {
  if (!samples.length) return "";
  const examples = samples.map((s, i) => `<예시 글 ${i + 1}>\n${s}\n</예시 글 ${i + 1}>`).join("\n\n");
  // 글 끝 고정 부분을 설정에 넣어 두었으면 프로그램이 붙이므로, AI가 또 쓰면 두 번 들어간다
  const fixed = footer
    ? "예시 글 끝에 매번 반복되는 고정 부분(상호, 주소, 연락처, 지도, 톡톡·유튜브·인스타그램 안내 등)은 프로그램이 마무리 글 뒤에 따로 붙이므로 이번 글에는 쓰지 않습니다."
    : "예시에서 매번 반복되는 고정 정보(상호, 연락처, 주소, 글 끝 안내 문구)는 블로그 주인의 것이므로 이번 글에도 같은 자리에 씁니다.";
  return `

아래는 블로그 주인이 직접 쓴 글입니다. 이번 글도 같은 사람이 쓴 것처럼 읽혀야 합니다. 말투와 어미, 한 줄을 끊는 길이, 문단 사이 여백, 소제목을 다는 방식(이모지 포함), 사진 아래 한 줄 설명을 붙이는 방식, 글을 여는 인사와 닫는 인사, 해시태그를 고르는 방식을 예시에서 그대로 따릅니다. 사용자가 고른 말투·분량 설정과 예시가 다르면 예시를 따릅니다.

다만 글의 구성(무엇을 중심으로 쓰고 사진을 어떻게 배치할지)은 예시가 아니라 이번 글에 정해진 '글 형식'을 따릅니다. 예시 글이 칼럼처럼 쓰였더라도 이번 글 형식이 데일리나 브이로그면 그 형식대로 짜고, 말투만 예시를 따릅니다.

${fixed} 반면 예시 글의 주제, 일화, 특정 인물 이야기는 그 글에만 해당하므로 이번 글로 가져오지 않습니다.

예시는 화면에서 복사한 것이라 버튼 이름, 메뉴, 재생 시간, 지도나 링크 카드의 글자가 섞여 있습니다. 그런 부분은 글의 일부가 아니니 따라 쓰지 않습니다.

${examples}`;
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "블로그 글 제목" },
    titleOptions: { type: "array", items: { type: "string" }, description: "title과 다른 제목 후보 2개" },
    intro: { type: "string", description: "도입 글" },
    sections: {
      type: "array",
      description: "본문을 이루는 부분들. 글에 나오는 순서대로. 각 부분은 (사진이 있으면) 사진, 한 줄 설명, 소제목, 글 순서로 들어간다.",
      items: {
        type: "object",
        properties: {
          photos: { type: "array", items: { type: "integer" }, description: "이 부분에 들어갈 사진·동영상 번호 (1부터 시작). 없으면 빈 배열" },
          caption: { type: "string", description: "사진 바로 아래에 붙는 한 줄 설명. 필요 없으면 빈 문자열" },
          heading: { type: "string", description: "소제목. 필요 없으면 빈 문자열" },
          text: { type: "string", description: "이 부분의 글" },
        },
        required: ["photos", "caption", "heading", "text"],
        additionalProperties: false,
      },
    },
    outro: { type: "string", description: "마무리 글" },
    hashtags: { type: "array", items: { type: "string" }, description: "# 없이 단어만" },
    privacyFlags: {
      type: "array",
      description: "발행 전에 블로그 주인이 확인해야 할 개인정보. 없으면 빈 배열",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["사람 이름", "학교·반", "상세 주소", "전화번호", "차량 번호", "기타"] },
          text: { type: "string", description: "글에 쓴 그대로의 말, 또는 사진에 보이는 글자" },
          photo: { type: "integer", description: "사진에서 본 것이면 사진 번호, 글에서 찾은 것이면 0" },
        },
        required: ["kind", "text", "photo"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "titleOptions", "intro", "sections", "outro", "hashtags", "privacyFlags"],
  additionalProperties: false,
};

// '인스타·쇼츠도 같이 만들기'를 켜면 같은 요청에서 인스타그램 글과 쇼츠 자막도 받는다 (따로 부탁하면 사진을 또 보내야 해서 사용료가 두 배가 된다)
const SOCIAL_SCHEMA = {
  instagram: {
    type: "object",
    properties: {
      caption: { type: "string", description: "인스타그램 게시물 본문 (해시태그 빼고)" },
      hashtags: { type: "array", items: { type: "string" }, description: "# 없이 단어만" },
    },
    required: ["caption", "hashtags"],
    additionalProperties: false,
  },
  shorts: {
    type: "object",
    properties: {
      title: { type: "string", description: "유튜브 쇼츠 제목" },
      description: { type: "string", description: "영상 설명" },
      captions: {
        type: "array",
        description: "사진마다 영상 화면에 뜨는 짧은 자막",
        items: {
          type: "object",
          properties: { photo: { type: "integer", description: "사진 번호 (1부터)" }, text: { type: "string" } },
          required: ["photo", "text"],
          additionalProperties: false,
        },
      },
      ending: { type: "string", description: "영상 마지막 화면 문구" },
    },
    required: ["title", "description", "captions", "ending"],
    additionalProperties: false,
  },
};

const NOTICE_SCHEMA = { notice: { type: "string", description: "카카오톡 채널·단체방에 올릴 짧은 공지문" } };

function schemaFor(social, notice) {
  return {
    ...SCHEMA,
    properties: { ...SCHEMA.properties, ...(social && SOCIAL_SCHEMA), ...(notice && NOTICE_SCHEMA) },
    required: [...SCHEMA.required, ...(social ? ["instagram", "shorts"] : []), ...(notice ? ["notice"] : [])],
  };
}

const TITLE_GUIDE = `

제목은 title 말고도 titleOptions에 후보 2개를 더 씁니다. 세 제목은 분위기와 강조점이 서로 달라야 합니다. 후보 하나는 사람들이 네이버에서 검색할 말을 앞에 둔 제목으로 씁니다. 지역명, 가게·도장 이름은 블로그 소개나 메모, 사진 속 글자로 알 수 있을 때만 넣고 지어내지 않습니다.`;

const PRIVACY_GUIDE = `

글을 다 쓴 뒤 privacyFlags에 블로그 주인이 발행 전에 확인해야 할 것을 적습니다. 글을 고치는 것이 아니라 알려 주기만 합니다.
- 글(제목, 본문, 공지문, 인스타그램·쇼츠 글 포함)에 들어간 실제 개인의 이름(아이, 학생, 학부모, 손님. 성 없이 이름만 썼어도 해당), 학교와 학년·반, 집 주소, 개인 전화번호. text는 글에 쓴 그대로 옮기고 photo는 0입니다.
- 사진에 또렷이 읽히는 이름표, 명찰, 띠나 옷에 적힌 이름, 차량 번호판, 전화번호. text는 보이는 글자를, photo는 사진 번호를 씁니다. 동영상 장면도 같습니다.
블로그 주인 본인, 직함만 쓴 호칭(관장님, 사범님, 사장님 등), 가게·도장 이름, 가게 주소와 대표 전화, 널리 알려진 인물과 지명은 적지 않습니다. 해당하는 것이 없으면 빈 배열입니다. 확실하지 않은 글자를 짐작해서 적지 않습니다.`;

const NOTICE_GUIDE = `

이번에는 카카오톡 채널이나 단체방에 올릴 짧은 공지문(notice)도 써 주세요. 받는 사람은 블로그 소개에 적힌 독자(학부모, 단골손님 등)입니다. 인사 한 줄, 이번 글의 핵심 2~3줄, 맺는 말 한 줄로 200자 이내로 씁니다. 이모지는 조금만 쓰고 해시태그와 링크는 넣지 않습니다(블로그 주소는 프로그램이 붙입니다). 사실 관계 규칙은 블로그 글과 똑같이 지키고, 사진 속 아이들이나 손님의 이름은 메모에 있어도 쓰지 않습니다.`;

// 최근에 쓴 글과 블로그 주인이 고친 기록을 AI에게 알려 준다. history: { recent, learned }
function historyGuide({ recent = [], learned = [] } = {}) {
  let guide = "";
  if (recent.length) {
    const lines = recent.map((p) => `- 제목: ${p.title}${p.opening ? ` / 여는 말: ${p.opening}` : ""}${p.closing ? ` / 맺는 말: ${p.closing}` : ""}`);
    guide += `\n\n블로그 주인이 최근에 올린 글입니다. 읽는 사람이 같은 글을 또 읽는 느낌이 들지 않게, 제목과 글을 여는 방식, 맺는 표현을 이 글들과 다르게 씁니다. 다만 말투는 그대로이고, 블로그 주인이 매번 쓰는 고정 인사나 예시 글의 인사는 유지합니다:\n${lines.join("\n")}`;
  }
  if (learned.length) {
    const lines = learned.map((e) => `- "${e.before}" → ${e.after ? `"${e.after}"` : "(지움)"}`);
    guide += `\n\n블로그 주인이 지난 글에서 AI 글을 직접 고친 기록입니다. 왜 고쳤을지 생각해서 이번 글은 처음부터 그 방향으로 씁니다. 그 글에만 해당하는 사실이나 이름은 가져오지 않습니다:\n${lines.join("\n")}`;
  }
  return guide;
}

const SOCIAL_GUIDE = `

이번에는 블로그 글과 함께 같은 사진으로 올릴 인스타그램 게시물 글과 유튜브 쇼츠(사진을 넘기는 세로 영상) 글도 써 주세요. 말투는 블로그 글과 같은 사람(예시 글이 있으면 그 말투)이고, 사실 관계 규칙도 똑같이 지킵니다.
- instagram.caption: 블로그 글을 줄인 것이 아니라 인스타그램에 맞게 짧고 가볍게 씁니다. 첫 줄은 눈길을 끄는 한 문장, 전체 3~6줄, 이모지는 조금. 해시태그는 넣지 않습니다.
- instagram.hashtags: 15~25개. 분야, 지역(알 때만), 분위기, 사진에 보이는 것을 섞습니다.
- shorts.title: 40자 이내. 영상을 눌러 보고 싶게 만드는 한 줄.
- shorts.description: 영상 설명 2~3줄과 끝에 해시태그 3~5개(#Shorts 포함).
- shorts.captions: 동영상을 뺀 사진 번호마다 하나씩, 사진 번호 순서대로. 화면에 크게 뜨는 자막이라 18자 이내로 짧게, 이모지 없이. 그 사진에 보이는 장면과 맞아야 하고, 첫 사진 자막은 다음 장면이 궁금해지는 한 줄로 씁니다.
- shorts.ending: 영상 마지막 화면 문구 20자 이내, 이모지 없이 (예: 더 많은 이야기는 블로그에서).`;

// 쇼츠에 AI 목소리를 켰으면 자막을 소리 내 읽으므로, 짧은 표어 대신 말하듯 자연스러운 한 문장으로 쓰게 한다
const VOICE_GUIDE = `
- 이 영상은 AI 목소리가 shorts.captions와 shorts.ending을 그대로 소리 내 읽습니다. 그래서 자막은 18자 제한 대신, 블로그 주인이 직접 말하듯 자연스러운 한 문장(35자 이내, "~했어요"처럼 끝맺음)으로 씁니다. 읽기 어려운 기호, 영어 약자, 괄호는 쓰지 않고 숫자는 읽는 그대로 써도 됩니다.`;
const socialGuide = (config) => SOCIAL_GUIDE + (config.shortsVoice ? VOICE_GUIDE : "");

export function sortFiles(files, order) {
  if (order === "name") return files.sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  const time = new Map(files.map((f) => [f, fs.statSync(f).mtimeMs]));
  return files.sort((a, b) => (order === "oldest" ? time.get(a) - time.get(b) : time.get(b) - time.get(a)));
}

// AI는 동영상을 직접 볼 수 없어서, Edge로 열어 앞부분 한 장면을 사진으로 뽑아 보여 준다.
// 못 뽑은 동영상(Edge가 못 여는 형식 등)은 결과에서 빠지고, 그 동영상은 파일 이름만 알려 주게 된다.
async function videoFrames(files) {
  const frames = new Map();
  if (!files.length) return frames;
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    for (const file of files) {
      try {
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(async () => {
          const video = document.querySelector("video");
          video.controls = false;
          video.muted = true;
          video.pause();
          if (video.readyState < 1) await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
          const seeked = new Promise((resolve) => (video.onseeked = resolve));
          video.currentTime = Math.min(2, (video.duration || 0) / 2);
          await seeked;
        });
        frames.set(file, await page.locator("video").screenshot({ type: "jpeg", quality: 85 }));
      } catch {}
    }
  } catch {
  } finally {
    await browser?.close();
  }
  return frames;
}

// 미리 보기에서 '다시 써 줘'를 눌렀을 때 붙이는 안내. 앞 글을 보여 주고 요청대로 고치게 한다
function revision({ post, request }) {
  const ask = request?.trim()
    ? `블로그 주인이 이렇게 고쳐 달라고 했습니다: "${request.trim()}"\n요청한 부분을 고치고, 요청하지 않은 부분은 되도록 그대로 둡니다.`
    : "블로그 주인이 마음에 들지 않는다며 다시 써 달라고 했습니다. 같은 사진과 같은 요청으로, 앞 글과 표현과 흐름이 다르게 새로 씁니다.";
  return `\n\n앞서 이 자료로 아래 글을 썼습니다. ${ask} 결과는 처음과 같은 형식으로 글 전체를 다시 줍니다.\n<앞 글>\n${JSON.stringify(post)}\n</앞 글>`;
}

// notes: 사진마다 블로그 주인이 적은 메모 (photos와 같은 순서). format: FORMATS의 이름.
// onProgress(글자 수): AI가 쓰는 동안 몇 글자째인지 알려 준다. revise: { post, request } 앞 글을 고쳐 쓸 때.
// social: 인스타그램 글과 쇼츠 자막도 같이 받는다 (post.instagram, post.shorts). notice: 공지문도 받는다 (post.notice)
// history: 최근 글과 블로그 주인이 고친 기록 (historyGuide)
export async function generatePost(config, photos, topic, memo, emphasis = "", { notes = [], format = "daily", onProgress, revise, social = false, notice = false, history } = {}) {
  const style = FORMATS[format] ?? FORMATS.daily;
  const frames = await videoFrames(photos.filter(isVideo));
  const content = [];
  for (const [i, file] of photos.entries()) {
    if (isVideo(file) && !frames.has(file)) {
      content.push({ type: "text", text: `${i + 1}번 (동영상 "${path.basename(file)}". 내용은 보여 드릴 수 없습니다)` });
    } else {
      // failOn: "none" — 휴대폰 사진에 흔한 작은 손상(군더더기 바이트)은 무시하고 읽는다
      const jpeg = await sharp(isVideo(file) ? frames.get(file) : file, { failOn: "none" })
        .rotate()
        .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      content.push({ type: "text", text: isVideo(file) ? `${i + 1}번 (동영상. 아래는 그 가운데 한 장면):` : `${i + 1}번 (사진):` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } });
    }
    if (notes[i]?.trim()) content.push({ type: "text", text: `${i + 1}번에 대한 블로그 주인의 메모: ${notes[i].trim()}` });
  }

  const samples = loadStyleSamples(config);
  const about = config.blogAbout?.trim();
  content.push({
    type: "text",
    text: `위 자료 ${photos.length}개로 네이버 블로그 글을 써 주세요.
${about ? `\n블로그 소개 (블로그 주인이 적은 것. 글의 관점과 읽는 사람은 이 소개를 따릅니다): ${about}\n` : ""}
${style.guide}

${
      style.freeOrder
        ? "사진 번호는 블로그 주인이 고른 순서이지만, 이 형식에서는 글의 흐름에 맞는 자리에 놓아도 됩니다. 받은 사진과 동영상은 모두 한 번씩 씁니다."
        : "사진 순서는 블로그 주인이 이야기 흐름을 생각해서 직접 정한 것입니다. 1번부터 받은 순서 그대로 배치하고, 순서를 바꾸거나 건너뛰지 않습니다. 글의 흐름도 이 순서를 따라가도록 짭니다."
    }${
      notes.some((n) => n?.trim())
        ? ` 메모가 붙은 사진은 ${style.freeOrder ? "메모 내용과 맞는 문단 옆에 놓고, 메모의 내용과 느낌을 글에 살립니다" : "그 부분을 메모의 내용과 느낌을 살려서 씁니다"}. 메모는 블로그 주인이 직접 알려 준 사실이므로 글에 써도 되지만, 메모에 없는 일을 지어 붙이지는 않습니다.`
        : ""
    }

주제: ${topic || "(정해지지 않음. 사진을 보고 알맞은 주제를 정해 주세요)"}
읽는 사람에게 강조하고 싶은 점: ${emphasis || "(없음)"}
꼭 들어가야 할 내용: ${memo || "(없음)"}
${samples.length ? "말투와 분량: 블로그 주인이 직접 쓴 예시 글을 따릅니다" : `말투: ${config.tone}\n분량: ${config.length}`}${
      footerText(config.footer)
        ? `\n\n마무리 글 뒤에는 아래 내용이 그대로 자동으로 붙습니다. 같은 내용을 마무리 글에 다시 쓰지 마세요:\n<글 끝 고정 부분>\n${footerText(config.footer)}\n</글 끝 고정 부분>`
        : ""
    }${
      config.naverTemplate?.trim()
        ? "\n\n글 맨 아래에는 블로그 주인이 네이버에 저장해 둔 고정 템플릿(가게·도장 소개, 시간표, 지도, 톡톡·유튜브·인스타그램 안내 등)이 자동으로 붙습니다. 그런 고정 안내는 마무리 글에 쓰지 마세요."
        : ""
    }${TITLE_GUIDE}${PRIVACY_GUIDE}${social ? socialGuide(config) : ""}${notice ? NOTICE_GUIDE : ""}${historyGuide(history)}${standingRequests(config)}${revise ? revision(revise) : ""}`,
  });

  const client = new Anthropic({ apiKey: config.apiKey });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM + styleGuide(samples, footerText(config.footer) || config.naverTemplate?.trim()),
    messages: [{ role: "user", content }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: schemaFor(social, notice) } },
    // 안전 필터가 실수로 거절하면 다른 모델로 자동 재시도
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (onProgress) stream.on("text", (_delta, snapshot) => onProgress(snapshot.length));
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("AI가 이 사진이나 주제로는 글쓰기를 거절했습니다. 사진이나 주제를 바꿔서 다시 해 보세요.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("글이 너무 길어져서 중간에 끊겼습니다. 설정에서 사진 수를 줄이거나 글 길이를 '짧게'로 바꿔 보세요.");
  }
  const post = JSON.parse(message.content.find((b) => b.type === "text")?.text ?? "");

  const checks = applyStandingRequests(post, config);
  const fixed = config.fixedHashtags.split(/[\s,#]+/).filter(Boolean);
  const tags = (list) => [...new Set([...fixed, ...list.map((t) => t.replace(/^#/, "").replace(/\s+/g, ""))])].filter(Boolean);
  post.hashtags = tags(post.hashtags);
  if (post.instagram) post.instagram.hashtags = tags(post.instagram.hashtags);
  const usd = (message.usage.input_tokens * 4 + message.usage.output_tokens * 20) / 1e6;
  return { post, costWon: Math.round(usd * 1400), styleSamples: samples.length, checks };
}

// '지난 글'에서 인스타·쇼츠를 만들 때, 인스타그램 글과 쇼츠 글이 없는 글(예전 글, 인스타·쇼츠를 끄고 만든 글)은
// 이미 쓴 블로그 글과 사진을 보여 주고 그것만 쓰게 한다. 사진은 작게 줄여 보내서 사용료가 블로그 글 하나보다 훨씬 적다
export async function generateSocial(config, photos, blogText) {
  const content = [];
  for (const [i, file] of photos.entries()) {
    if (isVideo(file)) continue;
    const jpeg = await sharp(file, { failOn: "none" }).rotate().resize(800, 800, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    content.push({ type: "text", text: `${i + 1}번 (사진):` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } });
  }
  const about = config.blogAbout?.trim();
  content.push({
    type: "text",
    text: `위 사진들로 블로그 주인이 아래 네이버 블로그 글을 올렸습니다.${about ? `\n블로그 소개: ${about}` : ""}
<블로그 글>
${blogText}
</블로그 글>
${socialGuide(config).replace("이번에는 블로그 글과 함께 같은 사진으로", "같은 사진으로").replace("블로그 글과 같은 사람(예시 글이 있으면 그 말투)", "위 블로그 글과 같은 사람의 말투")}${standingRequests(config)}`,
  });
  const client = new Anthropic({ apiKey: config.apiKey });
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: SOCIAL_SCHEMA, required: ["instagram", "shorts"], additionalProperties: false } } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (message.stop_reason === "refusal") throw new Error("AI가 이 사진으로는 글쓰기를 거절했습니다.");
  const social = JSON.parse(message.content.find((b) => b.type === "text")?.text ?? "");
  // 단어 바꾸기와 고정 해시태그는 블로그 글과 똑같이 적용한다
  const post = { title: "", intro: "", sections: [], outro: "", hashtags: [], ...social };
  applyStandingRequests(post, config);
  const fixed = config.fixedHashtags.split(/[\s,#]+/).filter(Boolean);
  post.instagram.hashtags = [...new Set([...fixed, ...post.instagram.hashtags.map((t) => t.replace(/^#/, "").replace(/\s+/g, ""))])].filter(Boolean);
  const usd = (message.usage.input_tokens * 4 + message.usage.output_tokens * 20) / 1e6;
  return { instagram: post.instagram, shorts: post.shorts, costWon: Math.round(usd * 1400) };
}

// 설정 '연결 확인': 키가 맞는지, 크레딧이 남았는지 아주 짧은 요청(1글자짜리 답)으로 확인한다. 사용료는 1원도 안 된다
export async function checkApiKey(apiKey) {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: explainError(error) };
  }
}

export function explainError(error) {
  if (error instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. '설정' 화면에서 키를 다시 확인해 주세요.";
  if (error instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 사용할 수 없습니다. 키 권한을 확인해 주세요.";
  // 직접 정한 월 한도에 닿으면 400, 계정 등급의 월 한도에 닿으면 429로 온다
  if (error instanceof Anthropic.BadRequestError && /specified (workspace )?API usage limits/i.test(error.message)) {
    return "Claude Console에서 정해 둔 월 사용 한도에 닿아서 AI가 멈췄습니다. platform.claude.com 의 Billing에서 Spend limits 금액을 올리거나, 다음 달에 다시 해 주세요.";
  }
  if (error instanceof Anthropic.RateLimitError && /enforced_spend_limit_reached|monthly API usage threshold/i.test(error.message)) {
    return "이 계정의 월 사용 한도에 닿아서 AI가 멈췄습니다. 다음 달 1일(한국 시각 오전 9시)에 다시 쓸 수 있습니다.";
  }
  if (error instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 1분쯤 뒤에 다시 실행해 주세요.";
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
    return "API 키는 맞지만 충전된 돈(크레딧)이 없습니다. platform.claude.com 의 Billing(결제) 메뉴에서 충전한 뒤 다시 해 주세요.";
  }
  if (error instanceof Anthropic.BadRequestError) return `요청에 문제가 있습니다. 크레딧이 남아 있는지(platform.claude.com의 Billing) 확인해 주세요.\n자세한 내용: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "인터넷 연결을 확인하고 다시 실행해 주세요.";
  if (error instanceof Anthropic.APIError) return `AI 서버 오류입니다(${error.status}). 잠시 뒤 다시 실행해 주세요.\n자세한 내용: ${error.message}`;
  return error.message;
}

// 글 안의 빈 줄은 문단 사이 여백으로 살린다 (여러 개가 이어지면 하나로)
function lines(text) {
  const out = [];
  for (const line of text.trim().split(/\r?\n/).map((s) => s.trim())) {
    if (line) out.push({ type: "text", text: line });
    else if (out.at(-1)?.type === "text") out.push({ type: "blank" });
  }
  return out;
}

const URL_LINE = /^(https?:\/\/\S+|(www\.)?([\w-]+\.)+[a-z]{2,}\/\S*)$/i;

// 설정의 '글 끝에 항상 붙일 내용'. 주소만 있는 줄은 링크 카드로, "지도:"로 시작하는 줄은 네이버 지도 장소로 넣는다
function footerBlocks(footer) {
  return lines(footer).map((block) => {
    if (block.type !== "text") return block;
    const place = block.text.match(/^지도\s*[:：]\s*(.+)$/);
    if (place) return { type: "place", query: place[1].trim() };
    if (URL_LINE.test(block.text)) return { type: "link", url: /^https?:/i.test(block.text) ? block.text : "https://" + block.text };
    return block;
  });
}

// 글을 사진 자리와 줄 단위로 나눈 순서 목록으로 바꾼다 (네이버 입력과 백업 파일이 같이 씀)
// keepOrder: 블로그 주인이 정한 사진 순서를 지킨다 (칼럼 형식처럼 AI가 자리를 정하는 경우는 false)
export function toBlocks(post, photos, footer = "", { keepOrder = true } = {}) {
  const media = (file) => ({ type: isVideo(file) ? "video" : "photo", file });
  const used = new Set();
  const blocks = [...lines(post.intro), { type: "blank" }];
  for (const section of post.sections) {
    for (const n of section.photos) {
      if (!photos[n - 1] || used.has(n)) continue;
      // 순서를 지켜야 하면, AI가 앞 번호를 건너뛰었을 때 그 사진을 먼저 넣는다
      for (let k = keepOrder ? 1 : n; k <= n; k++) {
        if (used.has(k)) continue;
        used.add(k);
        blocks.push(media(photos[k - 1]));
      }
    }
    if (section.caption?.trim()) blocks.push({ type: "text", text: section.caption.trim() }, { type: "blank" });
    if (section.heading.trim()) blocks.push({ type: "text", text: section.heading.trim() });
    blocks.push(...lines(section.text), { type: "blank" });
  }
  // AI가 빠뜨린 사진이 있으면 끝에 붙여서 없어지지 않게 한다
  photos.forEach((file, i) => { if (!used.has(i + 1)) blocks.push(media(file)); });
  blocks.push(...lines(post.outro), { type: "blank" });
  // footer: 설정 5번에서 온 것 (네이버 템플릿에 같은 게 있으면 건너뛴다)
  if (footerText(footer)) blocks.push(...footerBlocks(footerText(footer)).map((b) => ({ ...b, footer: true })), { type: "blank" });
  // hashtags: 네이버 템플릿을 쓰면 템플릿을 이 앞에 넣는다 (해시태그는 언제나 맨 끝)
  blocks.push({ type: "text", text: post.hashtags.map((t) => "#" + t).join(" "), hashtags: true });
  return blocks;
}
