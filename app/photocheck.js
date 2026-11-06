// 흔들리거나 초점이 안 맞은 사진과 거의 똑같은 사진을 찾는다. 작은 미리보기 사진으로 이 PC 안에서만 계산한다 (사용료 없음)
import sharp from "sharp";

const SIZE = 256;
// 기준값은 사진 32장을 흐리게 하고 옮겨 보며 쟀다. 선명한 사진은 250 이상(가운데 850), 흐리게 하면 약 170 이하.
// 서로 다른 사진의 지문은 30칸쯤 다르고, 연사처럼 살짝 움직인 사진은 5칸쯤 다르다
const SIMILAR_BITS = 10; // 사진 지문 64칸 중 이 수 이하로 다르면 비슷한 사진
const BLUR_SURE = 180; // 선명함이 이보다 낮으면 흐린 사진
const BLUR_MAYBE = 250; // 이보다 낮아도, 같이 고른 사진들보다 많이 낮으면 흐린 사진
const BLUR_RATIO = 0.3;

const cache = new Map(); // 미리보기 파일 경로(내용이 바뀌면 경로도 바뀐다) → 측정값

// 선명함: 주변 칸과의 밝기 차이(라플라시안)가 얼마나 들쭉날쭉한지. 초점이 나가면 작아진다
async function sharpness(file) {
  const { data } = await sharp(file, { failOn: "none" }).greyscale().resize(SIZE, SIZE, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let squares = 0;
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      const edge = data[i - 1] + data[i + 1] + data[i - SIZE] + data[i + SIZE] - 4 * data[i];
      sum += edge;
      squares += edge * edge;
    }
  }
  const count = (SIZE - 2) ** 2;
  return squares / count - (sum / count) ** 2;
}

// 사진 지문: 8x8로 줄인 뒤 평균보다 밝은지를 64칸에 적는다. 크기나 화질이 다르거나 살짝 움직여도 같은 장면이면 거의 같다
async function fingerprint(file) {
  const { data } = await sharp(file, { failOn: "none" }).greyscale().resize(8, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const mean = data.reduce((total, value) => total + value, 0) / data.length;
  return [...data].map((value) => value > mean);
}

async function measure(thumb) {
  if (!cache.has(thumb)) cache.set(thumb, { sharpness: await sharpness(thumb), print: await fingerprint(thumb) });
  return cache.get(thumb);
}

const distance = (a, b) => a.reduce((count, bit, i) => count + (bit !== b[i]), 0);

// items: [{ path, thumb }]. 돌려주는 값: { 사진 경로: { blurry, similarTo(먼저 나온 비슷한 사진 경로) } } (문제 없는 사진은 빠진다)
export async function checkPhotos(items) {
  const measured = [];
  for (const item of items) {
    try {
      measured.push({ ...item, ...(await measure(item.thumb)) });
    } catch {} // 읽지 못한 사진은 건너뛴다
  }
  const sorted = measured.map((m) => m.sharpness).sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const line = Math.max(BLUR_SURE, Math.min(BLUR_MAYBE, middle * BLUR_RATIO));
  const flags = {};
  measured.forEach((photo, i) => {
    const blurry = photo.sharpness < line;
    const twin = measured.slice(0, i).find((other) => distance(other.print, photo.print) <= SIMILAR_BITS);
    if (blurry || twin) flags[photo.path] = { blurry, similarTo: twin?.path ?? "" };
  });
  return flags;
}
