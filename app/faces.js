// 사진 속 얼굴 찾기와 모자이크. 얼굴 찾기는 이 PC에서만 한다 (OpenCV + YuNet 얼굴 인식 모델, 인터넷에 사진을 보내지 않음).
// 얼굴 위치는 사진 크기에 대한 비율(0~1)로 다룬다: { x, y, w, h }
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { DATA_DIR, isVideo } from "./config.js";

const MODEL = path.join(import.meta.dirname, "face_detection_yunet_2023mar.onnx"); // OpenCV Zoo, MIT 라이선스
const DETECT_EDGE = 960; // 이 크기로 줄여서 찾는다 (뒤쪽의 작은 얼굴도 찾을 만큼)
const MOSAIC_DIR = path.join(DATA_DIR, "mosaic");

let cvReady = null;
// OpenCV는 처음 쓸 때 한 번만 불러온다 (1~2초 걸린다)
function opencv() {
  cvReady ??= (async () => {
    let cv;
    try {
      cv = createRequire(import.meta.url)("@techstark/opencv-js");
    } catch {
      cvReady = null;
      throw new Error("얼굴 찾기 도구가 설치되지 않았습니다. 인터넷이 연결된 상태에서 '1_설치'를 다시 실행해 주세요.");
    }
    if (cv instanceof Promise) cv = await cv;
    else if (!cv.Mat) await new Promise((resolve) => (cv.onRuntimeInitialized = resolve));
    cv.FS_createDataFile("/", "yunet.onnx", fs.readFileSync(MODEL), true, false, false);
    return cv;
  })();
  return cvReady;
}

// 사진 한 장에서 얼굴을 찾는다. 사진은 휴대폰 회전 정보대로 돌린 모양 기준
async function detect(cv, file) {
  const { data, info } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize(DETECT_EDGE, DETECT_EDGE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const src = new cv.Mat(info.height, info.width, cv.CV_8UC3);
  const out = new cv.Mat();
  const detector = new cv.FaceDetectorYN("yunet.onnx", "", new cv.Size(info.width, info.height), 0.6, 0.3, 5000);
  try {
    // 모델은 BGR 순서를 받는다
    for (let i = 0; i < data.length; i += 3) {
      src.data[i] = data[i + 2];
      src.data[i + 1] = data[i + 1];
      src.data[i + 2] = data[i];
    }
    detector.detect(src, out);
    const faces = [];
    for (let r = 0; r < out.rows; r++) {
      const [x, y, w, h] = [0, 1, 2, 3].map((c) => out.floatAt(r, c));
      faces.push(clampBox({ x: x / info.width, y: y / info.height, w: w / info.width, h: h / info.height }));
    }
    return faces;
  } finally {
    src.delete();
    out.delete();
    detector.delete();
  }
}

const clamp = (v) => Math.min(1, Math.max(0, v));
function clampBox({ x, y, w, h }) {
  const x1 = clamp(x), y1 = clamp(y);
  return { x: x1, y: y1, w: clamp(x + w) - x1, h: clamp(y + h) - y1 };
}

// 파일마다 찾은 얼굴 목록 (동영상과 못 읽은 사진은 빈 목록)
export async function findFaces(files) {
  const cv = await opencv();
  const all = [];
  for (const file of files) {
    if (isVideo(file)) all.push([]);
    else all.push(await detect(cv, file).catch(() => []));
  }
  return all;
}

// 얼굴 자리를 모자이크한 JPG를 만들어 그 경로를 돌려준다. 가릴 얼굴이 없으면 원래 파일 그대로.
// 휴대폰 사진 속 촬영 위치(GPS) 같은 정보도 새 파일에는 남지 않는다
export async function mosaic(file, boxes) {
  if (isVideo(file) || !boxes?.length) return file;
  const key = crypto.createHash("md5").update(file + fs.statSync(file).mtimeMs + JSON.stringify(boxes)).digest("hex");
  const out = path.join(MOSAIC_DIR, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  const { data, info } = await sharp(file, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  const patches = [];
  for (const box of boxes) {
    // 머리카락과 턱선까지 가리게 조금 넓힌다
    const grow = 0.15;
    const b = clampBox({ x: box.x - box.w * grow, y: box.y - box.h * grow, w: box.w * (1 + grow * 2), h: box.h * (1 + grow * 2) });
    const left = Math.floor(b.x * info.width), top = Math.floor(b.y * info.height);
    const width = Math.max(1, Math.min(info.width - left, Math.ceil(b.w * info.width)));
    const height = Math.max(1, Math.min(info.height - top, Math.ceil(b.h * info.height)));
    // 얼굴 너비를 8칸 정도로 나눈 굵은 모자이크 (작은 얼굴도 한 칸이 6픽셀 이상)
    const cell = Math.max(6, Math.round(width / 8));
    const small = await sharp(data).extract({ left, top, width, height })
      .resize(Math.max(1, Math.round(width / cell)), Math.max(1, Math.round(height / cell)), { fit: "fill" })
      .toBuffer();
    const input = await sharp(small).resize(width, height, { fit: "fill", kernel: "nearest" }).toBuffer();
    patches.push({ input, left, top });
  }
  fs.mkdirSync(MOSAIC_DIR, { recursive: true });
  await sharp(data).composite(patches).jpeg({ quality: 92 }).toFile(out);
  return out;
}
