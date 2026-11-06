import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { DATA_DIR } from "./config.js";

const LOGIN_WAIT_MS = 10 * 60 * 1000;

// 네이버 글쓰기 화면을 연다. 로그인이 안 되어 있으면 사용자가 직접 로그인할 때까지 기다린다.
// 로그인 정보는 profileDir(사용자마다 따로)에 남아서 다음부터는 바로 열린다. log: 사용자에게 보여 줄 안내를 받는 함수
export async function openEditor(blogId, profileDir, log = console.log) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "msedge", // 윈도우에 기본으로 깔려 있는 Edge를 쓴다
    chromiumSandbox: true, // Playwright는 기본으로 Edge 보호막(샌드박스)을 끄므로 다시 켠다
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const writeUrl = `https://blog.naver.com/${blogId}/postwrite`;
  await page.goto(writeUrl);

  // 로그인되어 있어도 로그인 주소를 잠깐 거쳐 갈 수 있어서 조금 기다려 본다
  await page.waitForURL((url) => !url.hostname.includes("nid.naver.com"), { timeout: 5000 }).catch(() => {});
  if (page.url().includes("nid.naver.com")) {
    log("열린 브라우저 창에서 네이버에 로그인해 주세요. (처음 한 번만 하면 됩니다) '로그인 상태 유지'를 체크하면 다음부터 다시 묻지 않습니다.");
    await page.waitForURL((url) => !url.hostname.includes("nid.naver.com"), { timeout: LOGIN_WAIT_MS });
    await page.goto(writeUrl);
  }

  const frame = await findEditorFrame(page);
  await dismissPopups(frame);
  return { context, page, frame };
}

// 편집기는 페이지 본문에 있을 수도, iframe 안에 있을 수도 있다
async function findEditorFrame(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator(".se-documentTitle").count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`글쓰기 화면을 열지 못했습니다. 설정의 블로그 아이디가 로그인한 계정과 같은지 확인해 주세요. (현재 주소: ${page.url()})`);
}

async function dismissPopups(frame) {
  // "작성 중인 글이 있습니다" → 취소(새 글로 시작), 도움말 패널 → 닫기
  await frame.page().waitForTimeout(1500);
  for (const selector of [".se-popup-button-cancel", ".se-help-panel-close-button"]) {
    const button = frame.locator(selector).first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }
}

const EMOJI = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u;

// template: 네이버 '내 템플릿' 이름. 있으면 그 템플릿 내용을 글 맨 아래(해시태그 바로 앞)에 넣는다
export async function writeDraft({ page, frame }, title, blocks, { save = true, log = console.log, template = "" } = {}) {
  const keyboard = page.keyboard;
  // 편집기가 입력을 처리할 틈을 준다 (너무 빨리 넣으면 글자가 빠진다)
  const pause = () => page.waitForTimeout(150);
  // 이모지가 섞인 글을 한 번에 넣으면 편집기가 이모지만 남기고 나머지를 지운다. 이모지 앞뒤로 끊어서 넣는다.
  const insert = async (text) => {
    for (const part of text.split(EMOJI).filter(Boolean)) {
      await keyboard.insertText(part);
      await pause();
    }
  };

  // 지도·링크 카드는 네이버 화면이 바뀌면 못 넣을 수 있다. 글 전체를 멈추지 않고 표시만 남긴 뒤 끝에 알려 준다.
  const failed = [];
  // 템플릿은 글 전체를 바꿔 버리므로 빈 글에 먼저 불러와 내용을 잘라 두고, 다 쓴 뒤 맨 아래에 붙인다
  const held = template ? await holdTemplate(page, frame, template, log) : null;
  if (template && !held) failed.push(`템플릿: ${template}`);

  const titleLine = frame.locator(".se-documentTitle .se-text-paragraph").first();
  await titleLine.click();
  if (held) {
    // 템플릿 글 제목이 남아 있으므로 지운다
    await keyboard.press("End");
    await keyboard.press("Shift+Home");
    await keyboard.press("Backspace");
  }
  await pause();
  await insert(title);

  await frame.locator(".se-component.se-text .se-text-paragraph").first().click();
  await page.waitForTimeout(500);
  await centerAlign(frame);
  for (const block of blocks) {
    // 설정 5번 내용 중 템플릿에 이미 있는 것은 두 번 넣지 않는다
    if (held && block.footer && held.has(block)) continue;
    if (held && block.hashtags) {
      if (!(await pasteTemplate(page, frame, held))) failed.push(`템플릿: ${template}`);
    }
    if (block.type === "photo") {
      await insertPhoto(page, frame, block.file);
    } else if (block.type === "video") {
      await insertVideo(page, frame, block.file, title);
    } else if (block.type === "place") {
      if (!(await insertPlace(page, frame, block.query).catch(() => false))) {
        failed.push(`지도: ${block.query}`);
        await insert(`[여기에 지도 넣기: ${block.query}]`);
        await keyboard.press("Enter");
      }
    } else if (block.type === "link") {
      if (!(await insertLink(page, frame, block.url).catch(() => false))) failed.push(`링크 카드: ${block.url}`);
    } else {
      if (block.type === "text") await insert(block.text);
      await keyboard.press("Enter");
    }
    await pause();
  }

  const saved = save ? await saveDraft(page, frame, log) : false;
  return { failed, saved };
}

// 본문을 가운데 정렬로 바꾼다. 꾸밈용이라 실패해도 글 입력은 계속한다.
async function centerAlign(frame) {
  try {
    await frame.locator("button.se-align-left-toolbar-button").first().click({ timeout: 3000 });
    await frame.locator("button.se-toolbar-option-align-center-button").first().click({ timeout: 3000 });
  } catch {}
}

async function insertPhoto(page, frame, file) {
  const images = frame.locator(".se-component.se-image");
  const before = await images.count();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    frame.locator("button.se-image-toolbar-button").first().click(),
  ]);
  await chooser.setFiles(file);
  await images.nth(before).waitFor({ timeout: 120_000 });
  // 업로드가 끝나 실제 주소로 바뀔 때까지 기다린다
  await frame.waitForFunction(
    (index) => {
      const img = document.querySelectorAll(".se-component.se-image img")[index];
      return img && /^https?:/.test(img.src) && img.complete;
    },
    before,
    { timeout: 120_000 },
  );
}

async function insertVideo(page, frame, file, title) {
  const videos = frame.locator(".se-component.se-video");
  const before = await videos.count();
  await frame.locator("button.se-video-toolbar-button").first().click();
  const uploader = frame.locator(".se-popup-video-upload");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    uploader.locator("button.nvu_local").first().click(),
  ]);
  await chooser.setFiles(file);
  // 긴 동영상은 올리는 데 오래 걸린다
  await uploader.locator(".nvu_state", { hasText: "업로드 완료" }).first().waitFor({ timeout: 30 * 60_000 });
  // 동영상 제목은 필수(최대 40자)라서 글 제목을 넣어 둔다
  await uploader.locator("#nvu_inp_box_title").fill(title.slice(0, 40));
  await uploader.getByRole("button", { name: "완료", exact: true }).click();
  await videos.nth(before).waitFor({ timeout: 120_000 });
}

// ---------- 네이버 '내 템플릿' ----------
// 템플릿을 불러오면 쓰던 글이 통째로 바뀌므로(네이버가 "작성 중인 내용을 임시저장하고 불러오시겠습니까?"를 묻는다),
// 아직 빈 글일 때 불러와서 본문을 잘라 클립보드에 들고 있다가, 글을 다 쓴 뒤 맨 아래에 붙여넣는다.
// 사용자가 클립보드에 넣어 둔 글자는 미리 읽어 두었다가 다 붙인 뒤 되돌려 놓는다.
// 반환: 템플릿 안의 링크·지도·글줄 목록과 has(block) (설정 5번과 겹치는지). 못 불러오면 null
async function holdTemplate(page, frame, name, log) {
  const panelButton = frame.locator("button.se-template-toolbar-button").first();
  const panel = frame.locator(".se-sidebar-container-template");
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" }).catch(() => {});
    const savedClipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);

    await panelButton.click({ timeout: 5000 });
    await panel.locator("button.se-tab-button[value=my]").click({ timeout: 10_000 });
    const mine = panel.locator(".se-tab-content-my-template"); // 추천 템플릿과 섞이지 않게 내 템플릿 칸만 본다
    const item = mine.locator(".se-doc-template-item").filter({ has: frame.locator(".se-doc-template-title", { hasText: name.trim() }) }).first();
    await item.waitFor({ timeout: 10_000 }).catch(() => {});
    if (!(await item.count())) {
      const names = await mine.locator(".se-doc-template-title").allInnerTexts();
      log(`[확인 필요] 네이버 '내 템플릿'에서 "${name}"을 찾지 못해 템플릿 없이 씁니다. (있는 템플릿: ${names.join(", ") || "없음"})`);
      await panelButton.click().catch(() => {});
      return null;
    }
    // 빈 글이어도 확인 창이 뜰 수 있어서 '확인'을 누른다
    const accept = (dialog) => dialog.accept().catch(() => {});
    page.on("dialog", accept);
    const emptyCount = await frame.locator(".se-component").count();
    await item.locator("a.se-doc-template").click();
    // 빈 글의 제목 칸에도 '제목' 안내 글자가 있어서, 덩어리 수가 바뀌는 것으로 불러온 것을 확인한다
    await frame.waitForFunction((n) => document.querySelectorAll(".se-component").length !== n, emptyCount, { timeout: 15_000 });
    await page.waitForTimeout(2000);
    page.off("dialog", accept);
    await panelButton.click().catch(() => {}); // 템플릿 창 닫기

    // 템플릿 안에 무엇이 있는지 읽어 둔다 (설정 5번과 겹치는지 보려고)
    const inside = await frame.evaluate(() => ({
      links: [...document.querySelectorAll(".se-component.se-oglink a[href], .se-component.se-oembed a[href]")].map((a) => a.href),
      cards: [...document.querySelectorAll(".se-component.se-oglink, .se-component.se-oembed")].map((c) => c.innerText),
      places: [...document.querySelectorAll(".se-component.se-placesMap")].map((c) => c.innerText),
      lines: [...document.querySelectorAll(".se-component.se-text .se-text-paragraph")].map((p) => p.innerText.trim()).filter(Boolean),
      count: document.querySelectorAll(".se-component").length,
    }));

    // 본문 전체를 잘라 낸다
    await frame.locator(".se-component:not(.se-documentTitle) .se-text-paragraph").first().click();
    await page.keyboard.press("Control+A");
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+X");
    await page.waitForTimeout(1000);
    const left = await frame.locator(".se-component:not(.se-documentTitle)").count();
    if (left > 1 || (await frame.locator(".se-component:not(.se-documentTitle):not(.se-text)").count())) {
      log(`[확인 필요] 템플릿 "${name}"을 글 끝으로 옮기지 못해 템플릿 없이 씁니다.`);
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      return null;
    }

    const bare = (url) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/?#].*$|\/+$/, "").toLowerCase();
    const urlKey = (url) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
    const squash = (text) => text.replace(/\s+/g, "");
    return {
      name,
      count: inside.count,
      savedClipboard,
      has(block) {
        if (block.type === "link") {
          // 같은 주소이거나, 같은 사이트(유튜브·톡톡·인스타 등)의 카드가 템플릿에 이미 있으면 겹친다고 본다
          return inside.links.some((href) => urlKey(href) === urlKey(block.url)) || inside.links.some((href) => bare(href) === bare(block.url)) || inside.cards.some((c) => c.toLowerCase().includes(bare(block.url)));
        }
        if (block.type === "place") return inside.places.some((p) => squash(p).includes(squash(block.query.split(/[,，]/)[0])));
        if (block.type === "text") return inside.lines.some((l) => squash(l) === squash(block.text));
        return false;
      },
    };
  } catch (error) {
    log(`[확인 필요] 템플릿 "${name}"을 불러오다 문제가 생겨 템플릿 없이 씁니다: ${error.message.split("\n")[0]}`);
    await panelButton.click().catch(() => {});
    return null;
  }
}

// 잘라 둔 템플릿을 글 맨 아래에 붙이고, 클립보드를 원래대로 돌려놓는다.
// 못 붙였으면 클립보드에 템플릿을 그대로 남겨 둔다 (사용자가 Ctrl+V로 직접 붙일 수 있게)
async function pasteTemplate(page, frame, held) {
  try {
    await backToEnd(page, frame);
    const before = await frame.locator(".se-component").count();
    await page.keyboard.press("Control+V");
    await frame.waitForFunction((n) => document.querySelectorAll(".se-component").length > n, before, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await backToEnd(page, frame);
    await page.keyboard.press("Enter");
    if (held.savedClipboard !== null) await page.evaluate((t) => navigator.clipboard.writeText(t), held.savedClipboard).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// 사진·글이 아닌 덩어리(지도, 링크 카드 등). 넣은 뒤 이 개수가 늘었는지로 성공을 확인한다
const blocksAdded = (frame, before, timeout) =>
  frame.locator(".se-component:not(.se-text)").nth(before).waitFor({ state: "attached", timeout });
const countBlocks = (frame) => frame.locator(".se-component:not(.se-text)").count();

// 못 넣었을 때 그 순간의 화면과 편집기 HTML을 남겨 둔다 (네이버 화면이 바뀐 경우 고칠 때 필요)
async function saveDebug(page, frame, name) {
  await screenshot(page, `debug-${name}`);
  fs.writeFileSync(path.join(DATA_DIR, `debug-${name}.html`), await frame.content().catch(() => ""), "utf8");
}

// 글은 항상 맨 끝에 이어 쓰므로, 다른 곳을 건드린 뒤에는 마지막 줄 끝으로 돌아간다
async function backToEnd(page, frame) {
  const last = frame.locator(".se-text-paragraph").last();
  // 지도 같은 덩어리가 선택된 채면 투명한 선택 상자가 클릭을 가로채서, 그때는 강제로 누른다
  await last.click({ timeout: 5000 }).catch(() => last.click({ force: true, timeout: 5000 })).catch(() => {});
  await page.keyboard.press("End");
}

async function closePlacePopup(page, popup) {
  for (let i = 0; i < 3 && (await popup.isVisible().catch(() => false)); i++) {
    await popup.locator(".se-popup-close-button").click({ timeout: 3000 }).catch(() => page.keyboard.press("Escape"));
    await page.waitForTimeout(700);
  }
}

// 네이버 지도 장소: 툴바 '장소' → 검색 → 결과 '추가' → '확인'
// 같은 이름 가게가 여러 곳 나오므로(같은 상호가 한 도시에 여러 곳인 경우가 흔하다) 이름과 주소를 같이 받아,
// 적어 준 낱말(이름, 동네, 도로명, 번지)이 가장 많이 들어맞는 결과를 고른다.
// "이름, 주소" 처럼 쉼표로 나눠 적어도 되고, 쉼표 없이 이어 적어도 된다.
async function insertPlace(page, frame, query) {
  const [name, hint = ""] = query.split(/[,，]/).map((s) => s.trim());
  const words = `${name} ${hint}`.split(/\s+/).filter(Boolean);
  const squash = (text) => text.replace(/\s+/g, "");
  const score = (text) => words.filter((w) => squash(text).includes(w)).length;
  const popup = frame.locator(".se-popup-placesMap");
  const input = popup.locator("input.react-autosuggest__input");
  const items = popup.locator(".se-place-map-search-result-item");
  const search = async (text) => {
    await input.click({ timeout: 10_000 });
    await input.fill("");
    await input.pressSequentially(text, { delay: 30 }); // fill로 한 번에 넣으면 검색창이 글자를 못 알아본다
    await page.waitForTimeout(700);
    // 검색 버튼이 가끔 한 번에 안 먹어서, 결과가 나올 때까지 몇 번 다시 누른다
    for (let i = 0; i < 4 && !(await items.count()); i++) {
      if (i % 2) await input.press("Enter");
      else await popup.locator(".se-place-search-button").click({ timeout: 5000 });
      await items.first().waitFor({ timeout: 5000 }).catch(() => {});
    }
    return items.count();
  };
  const before = await countBlocks(frame);
  try {
    await frame.locator("button.se-map-toolbar-button").first().click({ timeout: 5000 });
    // 이름과 주소를 다 넣고 찾으면 대개 딱 한 곳이 나온다. 없으면 이름만으로 다시 찾는다.
    if (!(await search(words.join(" "))) && hint) await search(name);
    const texts = await items.allInnerTexts();
    if (!texts.length) throw new Error("검색 결과 없음");
    let best = 0;
    texts.forEach((text, i) => { if (score(text) > score(texts[best])) best = i; });
    // 주소를 적어 줬는데 주소가 하나도 안 맞으면, 엉뚱한 곳을 넣느니 넣지 않는다
    if (hint && !hint.split(/\s+/).some((w) => squash(texts[best]).includes(w))) throw new Error("주소가 맞는 장소가 없음");
    await items.nth(best).hover(); // '추가' 버튼은 마우스를 올려야 보인다
    await items.nth(best).locator(".se-place-add-button").click({ timeout: 5000 });
    await popup.locator(".se-popup-button-confirm").click({ timeout: 10_000 });
    await blocksAdded(frame, before, 20_000);
    return true;
  } catch {
    await saveDebug(page, frame, "place");
    await closePlacePopup(page, popup);
    await backToEnd(page, frame);
    return false;
  }
}

// 링크 카드(유튜브, 톡톡, 인스타그램 등): 주소를 붙여넣으면 편집기가 카드로 바꿔 준다.
// 툴바 '링크' 버튼은 자동으로 누르면 창이 안 열려서 붙여넣기를 쓴다. 클립보드는 건드리지 않는다.
async function insertLink(page, frame, url) {
  const before = await countBlocks(frame);
  // 실제 입력을 받는 곳은 편집기 안쪽의 또 다른 iframe이다
  await frame.evaluate((text) => {
    let doc = document;
    let el = doc.activeElement;
    while (el?.tagName === "IFRAME" && el.contentDocument) {
      doc = el.contentDocument;
      el = doc.activeElement;
    }
    const data = new DataTransfer();
    data.setData("text/plain", text);
    (el ?? doc.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, url);
  // 편집기는 주소 끝의 /를 빼고 보여 주기도 해서, 앞의 https://와 끝의 /를 뺀 부분으로 그 줄을 찾는다
  const bare = url.replace(/^https?:\/\//i, "").replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = frame.locator(".se-component.se-text .se-text-paragraph", { hasText: new RegExp(bare, "i") }).last();
  try {
    await blocksAdded(frame, before, 15_000);
  } catch {
    // 카드는 못 만들었어도 주소 글자는 남긴다
    await saveDebug(page, frame, "link");
    if (!(await line.count())) await page.keyboard.insertText(url);
    await page.keyboard.press("Enter");
    return false;
  }
  // 카드 위에 붙여넣은 주소 글자가 한 줄 남으므로 지운다 (글자 위를 누르면 링크 창이 떠서 줄 오른쪽 끝을 누른다).
  // 편집기가 카드를 만든 뒤 주소 글자를 늦게 링크로 바꾸면서 지운 줄이 되살아날 때가 있어, 남아 있는지 보고 다시 지운다.
  await page.waitForTimeout(800);
  // 링크로 바뀐 줄은 Shift+Home으로 잡히지 않아서, 줄 끝에서 그 줄 글자 수만큼 지운다
  for (let i = 0; i < 3 && (await line.count()); i++) {
    const length = [...(await line.innerText()).replace(/\n/g, "")].length;
    const box = await line.boundingBox();
    if (box) await line.click({ position: { x: box.width - 2, y: box.height / 2 } });
    await page.keyboard.press("End");
    for (let k = 0; k < length; k++) await page.keyboard.press("Backspace");
    await page.waitForTimeout(800);
  }
  await backToEnd(page, frame);
  return true;
}

async function saveDraft(page, frame, log) {
  // '저장' 옆 숫자(임시저장 글 개수)가 늘어나면 저장된 것
  const count = frame.locator("button[class*='save_count_btn']").first();
  const before = await count.innerText();
  await frame.locator("button[class*='save_btn']").first().click();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await count.innerText()) !== before) return true;
    await page.waitForTimeout(500);
  }
  log("[주의] 임시저장이 됐는지 확인하지 못했습니다. 브라우저 창 오른쪽 위 '저장'을 직접 한 번 눌러 주세요.");
  return false;
}

export async function screenshot(page, name) {
  const file = path.join(DATA_DIR, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}
