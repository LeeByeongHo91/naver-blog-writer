// API 키를 설정 파일에 그대로 적지 않고 윈도우 암호화(DPAPI)로 잠근다. 이 PC의 같은 윈도우 사용자만 풀 수 있어서
// 설정 파일이 밖으로 새도 키를 읽을 수 없다. PowerShell을 띄우는 데 1초쯤 걸리므로 한 번 잠그거나 푼 값은 기억해 둔다.
import { execFileSync } from "node:child_process";

const textOf = new Map(); // 잠근 글 → 키 (풀지 못했으면 null)
const sealedOf = new Map(); // 키 → 잠근 글
let cannotSeal = false; // PC 보안 설정으로 PowerShell이 막혀 있으면 몇 번이고 다시 해 보지 않는다

// 키가 명령 줄에 보이지 않게 표준 입력으로 넘긴다
function dpapi(method, base64) {
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()), $null, 'CurrentUser'))`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    input: base64,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

function remember(text, sealed) {
  textOf.set(sealed, text);
  sealedOf.set(text, sealed);
  return sealed;
}

// 잠근 글을 돌려준다. 잠그지 못하면 null
export function seal(text) {
  if (sealedOf.has(text)) return sealedOf.get(text);
  if (cannotSeal) return null;
  try {
    return remember(text, dpapi("Protect", Buffer.from(text, "utf8").toString("base64")));
  } catch (error) {
    console.error("API 키를 잠그지 못해서 그대로 저장합니다:", error.message.split("\n")[0]);
    cannotSeal = true;
    return null;
  }
}

// 키를 돌려준다. 풀지 못하면(다른 PC나 다른 윈도우 사용자의 설정 파일이면) null
export function unseal(sealed) {
  if (textOf.has(sealed)) return textOf.get(sealed);
  try {
    const text = Buffer.from(dpapi("Unprotect", sealed), "base64").toString("utf8");
    remember(text, sealed);
    return text;
  } catch (error) {
    console.error("잠근 API 키를 풀지 못했습니다:", error.message.split("\n")[0]);
    textOf.set(sealed, null);
    return null;
  }
}
