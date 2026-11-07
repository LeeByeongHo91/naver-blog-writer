// 블로그 글 생성기의 익명 사용 통계를 받는 곳 (Google Apps Script 웹 앱, 구글 시트에 붙여서 씀).
// 프로그램은 하루 한 번 켤 때와 글을 하나 만들 때 ?id=무작위번호&v=버전&e=open|post 만 보내고,
// 네이버 글쓰기 화면에서 버튼을 못 찾으면 하루 한 번 e=naver 와 못 찾은 버튼 이름(d)을 보낸다.
// 여기서는 그 값과 받은 시각만 '기록' 시트에 적는다 (보낸 PC의 IP 주소는 Apps Script가 알려 주지 않아서 남지 않는다).
// e=naver 가 오면 이 스크립트 주인의 구글 메일로 알린다 (6시간에 한 번까지).
//
// 처음 한 번: 구글 시트 새로 만들기 → 확장 프로그램 → Apps Script → 이 코드를 붙여넣기 → 위쪽에서 setup 고르고 ▶ 실행(권한 허용)
// → 배포 → 새 배포 → 유형: 웹 앱, 실행 사용자: 나, 액세스 권한: 모든 사용자 → 배포 → 나오는 웹 앱 URL을 저장소 stats-endpoint.txt에 적기.
// 코드를 고친 뒤: 붙여넣기 → setup ▶ 실행(메일 권한 허용) → 배포 → 배포 관리 → 연필 → 버전: 새 버전 → 배포 (웹 앱 URL은 그대로다).

const LOG = "기록";
const SUMMARY = "요약";
const MAIL_GAP_MS = 6 * 60 * 60 * 1000;

function doGet(e) {
  const p = (e && e.parameter) || {};
  const id = String(p.id || "");
  const version = String(p.v || "").slice(0, 20);
  const event = String(p.e || "");
  const detail = String(p.d || "").slice(0, 120);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^(open|post|naver)$/.test(event)) return ContentService.createTextOutput("no");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    logSheet().appendRow([new Date(), id, version, event, detail]);
  } finally {
    lock.releaseLock();
  }
  if (event === "naver") mailOwner(version, detail);
  return ContentService.createTextOutput("ok");
}

// 네이버 화면이 바뀐 것 같다고 알린다. 메일을 못 보내도 기록은 남아 있다
function mailOwner(version, detail) {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty("lastNaverMail") || 0);
  if (Date.now() - last < MAIL_GAP_MS) return;
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "[블로그 글 생성기] 네이버 글쓰기 화면이 바뀐 것 같습니다", `버전 ${version}에서 찾지 못한 것: ${detail}\n\n쓰는 분들은 글을 네이버에 넣지 못하고 있습니다. 설정 14번 '지금 점검하기'로 확인하고 프로그램을 고쳐 주세요.\n같은 내용은 6시간 동안 다시 보내지 않습니다. 기록은 구글 시트 '기록'에 있습니다.`);
    props.setProperty("lastNaverMail", String(Date.now()));
  } catch (error) {
    console.error(error);
  }
}

function logSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(LOG);
  if (!sheet) {
    sheet = book.insertSheet(LOG);
    sheet.appendRow(["시각", "PC 번호(무작위)", "버전", "일 (open=켬, post=글 만듦, naver=네이버 화면 문제)", "찾지 못한 것"]);
    sheet.setFrozenRows(1);
  }
  if (!sheet.getRange("E1").getValue()) sheet.getRange("E1").setValue("찾지 못한 것");
  return sheet;
}

// 한 번만 실행: 기록 시트와, 숫자를 한눈에 보는 요약 시트를 만든다
function setup() {
  logSheet();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(SUMMARY) || book.insertSheet(SUMMARY, 0);
  sheet.clear();
  const pcs = (cond) => `=IFERROR(ROWS(UNIQUE(FILTER(${LOG}!B2:B, ${cond}))), 0)`;
  const rows = [
    ["항목", "값"],
    ["오늘 켠 PC", pcs(`INT(${LOG}!A2:A)=TODAY()`)],
    ["최근 7일 동안 쓴 PC", pcs(`${LOG}!A2:A>=TODAY()-6`)],
    ["최근 30일 동안 쓴 PC", pcs(`${LOG}!A2:A>=TODAY()-29`)],
    ["지금까지 한 번이라도 쓴 PC", pcs(`${LOG}!B2:B<>""`)],
    ["최근 7일 동안 만든 글", `=COUNTIFS(${LOG}!D2:D, "post", ${LOG}!A2:A, ">="&(TODAY()-6))`],
    ["최근 30일 동안 만든 글", `=COUNTIFS(${LOG}!D2:D, "post", ${LOG}!A2:A, ">="&(TODAY()-29))`],
    ["지금까지 만든 글", `=COUNTIF(${LOG}!D2:D, "post")`],
    ["최근 7일 네이버 화면 문제를 알린 PC", pcs(`(${LOG}!D2:D="naver")*(${LOG}!A2:A>=TODAY()-6)`)],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange("D1").setValue("버전별 PC (최근 30일)");
  sheet.getRange("D2").setFormula(`=IFERROR(QUERY(UNIQUE(FILTER({${LOG}!B2:B, ${LOG}!C2:C}, ${LOG}!A2:A>=TODAY()-29)), "select Col2, count(Col1) group by Col2 order by Col2 desc label Col2 '버전', count(Col1) 'PC'", 0), "아직 기록 없음")`);
  sheet.getRange("G1").setValue("날짜별 쓴 PC (최근 30일)");
  sheet.getRange("G2").setFormula(`=IFERROR(QUERY(UNIQUE(FILTER({INT(${LOG}!A2:A), ${LOG}!B2:B}, ${LOG}!A2:A>=TODAY()-29)), "select Col1, count(Col2) group by Col1 order by Col1 desc label Col1 '날짜', count(Col2) 'PC'", 0), "아직 기록 없음")`);
  sheet.getRange("G:G").setNumberFormat("yyyy-mm-dd");
  sheet.getRange("A1:B1").setFontWeight("bold");
  sheet.getRange("D1:G1").setFontWeight("bold");
  sheet.setColumnWidth(1, 200);
}
