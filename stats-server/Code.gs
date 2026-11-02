// 블로그 글 생성기의 익명 사용 통계를 받는 곳 (Google Apps Script 웹 앱, 구글 시트에 붙여서 씀).
// 프로그램은 하루 한 번 켤 때와 글을 하나 만들 때 ?id=무작위번호&v=버전&e=open|post 만 보낸다.
// 여기서는 그 세 가지와 받은 시각만 '기록' 시트에 적는다 (보낸 PC의 IP 주소는 Apps Script가 알려 주지 않아서 남지 않는다).
//
// 처음 한 번: 구글 시트 새로 만들기 → 확장 프로그램 → Apps Script → 이 코드를 붙여넣기 → 위쪽에서 setup 고르고 ▶ 실행(권한 허용)
// → 배포 → 새 배포 → 유형: 웹 앱, 실행 사용자: 나, 액세스 권한: 모든 사용자 → 배포 → 나오는 웹 앱 URL을 저장소 stats-endpoint.txt에 적기.

const LOG = "기록";
const SUMMARY = "요약";

function doGet(e) {
  const p = (e && e.parameter) || {};
  const id = String(p.id || "");
  const version = String(p.v || "").slice(0, 20);
  const event = String(p.e || "");
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^(open|post)$/.test(event)) return ContentService.createTextOutput("no");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    logSheet().appendRow([new Date(), id, version, event]);
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput("ok");
}

function logSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(LOG);
  if (!sheet) {
    sheet = book.insertSheet(LOG);
    sheet.appendRow(["시각", "PC 번호(무작위)", "버전", "일 (open=켬, post=글 만듦)"]);
    sheet.setFrozenRows(1);
  }
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
