// 업데이트 파일 서명 (프로그램을 만든 사람의 PC에서만 쓴다. 나눠 주는 zip에는 들어가지 않는다)
//   node tools/sign.mjs <blog-writer.zip>   → 옆에 blog-writer.zip.sig 를 만든다
//   node tools/sign.mjs --new-key           → 처음 한 번: 서명 열쇠를 만들고, 프로그램에 넣을 공개 열쇠를 보여 준다
// 서명 열쇠(비밀)는 %USERPROFILE%\.blogwriter-release\release-key.pem 에 둔다 (GitHub·OneDrive 밖).
// 이 열쇠가 없으면 새 버전을 낼 수 없으니 USB 등에 따로 백업해 둔다. 남에게 주거나 GitHub에 올리면 안 된다.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_DIR = path.join(os.homedir(), ".blogwriter-release");
const KEY_FILE = path.join(KEY_DIR, "release-key.pem");
const arg = process.argv[2];

if (arg === "--new-key") {
  if (fs.existsSync(KEY_FILE)) throw new Error(`이미 열쇠가 있습니다: ${KEY_FILE} (덮어쓰면 기존 설치본이 업데이트를 못 받습니다)`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log("서명 열쇠를 만들었습니다:", KEY_FILE);
  console.log("app/update.js 의 PUBLIC_KEY 에 넣을 공개 열쇠:\n" + publicKey.export({ type: "spki", format: "pem" }));
} else if (arg) {
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const signature = crypto.sign(null, fs.readFileSync(arg), key).toString("base64");
  fs.writeFileSync(arg + ".sig", signature + "\n");
  console.log("서명했습니다:", arg + ".sig");
} else {
  console.log("사용법: node tools/sign.mjs <zip 파일> | --new-key");
}
