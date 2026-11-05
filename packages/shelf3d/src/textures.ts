/** 贴图工具：书脊贴图 + 侧板三级分类层标签 + 时间刻度尺 + 木纹 Canvas 生成。 */
import * as THREE from "three";

const textureCache = new Map<string, THREE.Texture>();

/** 程序化木纹贴图（书架构件共用，避免"纸片感"）。 */
export function makeWoodTexture(tint: "frame" | "board" = "frame"): THREE.CanvasTexture {
  const key = `wood-${tint}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const base = tint === "frame" ? "#8a6c4e" : "#a3835f";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);
  // 沿 v 方向的木纹条
  let seed = tint === "frame" ? 7 : 13;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 26; i++) {
    const y = rand() * S;
    const alpha = 0.05 + rand() * 0.1;
    const w = 1 + rand() * 2.5;
    ctx.strokeStyle = rand() > 0.5 ? `rgba(60,42,26,${alpha})` : `rgba(240,225,200,${alpha * 0.8})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(0, y);
    let x = 0;
    let yy = y;
    while (x < S) {
      x += 18 + rand() * 26;
      yy += (rand() - 0.5) * 5;
      ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  // 少量节疤
  for (let i = 0; i < 3; i++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, 6 + rand() * 8);
    grad.addColorStop(0, "rgba(70,50,30,0.35)");
    grad.addColorStop(1, "rgba(70,50,30,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - 16, cy - 16, 32, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

export function loadSpineTexture(url: string): THREE.Texture {
  let tex = textureCache.get(url);
  if (tex) return tex;
  tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(url, tex);
  return tex;
}

/** 由包 id 派生一个稳定的占位色（书脊贴图加载前的兜底/失败色）。 */
export function placeholderColor(id: number): string {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 32%, 42%)`;
}

/** 架侧板标签：二级分类名（顶部横排）+ 每层的三级分类名（竖排，对齐层带）。 */
export function makeSidePanelTexture(
  rackLabel: string,
  floors: { label: string }[],
  floorH: number,
  totalH: number,
  baseH: number,
): THREE.CanvasTexture {
  const W = 96; // u：侧板深度方向
  const H = 512; // v：侧板高度方向
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#7a5f45";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 0; i < 5; i++) ctx.fillRect(0, 40 + i * 100, W, 2);

  const worldToPy = (yWorld: number) => H - (yWorld / totalH) * H;

  // 顶部：二级分类名（横排小字）
  ctx.fillStyle = "#caa96f";
  ctx.font = "bold 13px 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(W / 2, 14);
  ctx.fillText(truncate(rackLabel, 6), 0, 0);
  ctx.restore();

  // 每层：三级分类名竖排（对齐层带中部）+ 层分隔刻度线
  floors.forEach((floor, i) => {
    const yTop = baseH + i * floorH;
    const yMid = yTop + floorH / 2;
    ctx.fillStyle = "#e9ddbd";
    ctx.fillRect(2, worldToPy(yTop) - 1.5, W - 4, 3);
    const label = truncate(floor.label, Math.max(2, Math.floor(floorH / 0.16)));
    ctx.fillStyle = "#f6efdd";
    ctx.font = "bold 15px 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    const chars = label.split("");
    const startY = worldToPy(yMid) - ((chars.length - 1) * 18) / 2;
    chars.forEach((ch, ci) => {
      ctx.fillText(ch, W / 2, startY + ci * 18);
    });
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 时间刻度尺（贴在每层前沿）：分段边界刻度线 + 段标签（横排居中）。 */
export function makeTimeRulerTexture(segments: { label: string }[]): THREE.CanvasTexture {
  const W = 2048; // u：沿时间轴
  const H = 72; // v：尺条高度
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#8a6d4e";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(0, H - 6, W, 2);

  const n = Math.max(segments.length, 1);
  const span = W / n;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  segments.forEach((seg, i) => {
    const x0 = i * span;
    // 段边界刻度
    ctx.fillStyle = "#3f3122";
    ctx.fillRect(Math.round(x0), 0, 2, H);
    // 段标签（横排，过长缩小字号）
    const label = seg.label;
    let font = 30;
    ctx.font = `bold ${font}px 'Microsoft YaHei', sans-serif`;
    while (ctx.measureText(label).width > span - 8 && font > 12) {
      font -= 2;
      ctx.font = `bold ${font}px 'Microsoft YaHei', sans-serif`;
    }
    ctx.fillStyle = "#f3e9d2";
    ctx.fillText(label, x0 + span / 2, H / 2 - 2);
  });
  // 末端刻度
  ctx.fillStyle = "#3f3122";
  ctx.fillRect(W - 2, 0, 2, H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 二级分类组牌贴图（横版，面向 +x 观察方向）。 */
export function makeGroupSignTexture(label: string, count: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#5c4632";
  ctx.fillRect(0, 0, 512, 112);
  ctx.strokeStyle = "#caa96f";
  ctx.lineWidth = 5;
  ctx.strokeRect(7, 7, 498, 98);
  ctx.fillStyle = "#f5ead2";
  ctx.font = "bold 44px 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(truncate(label, 10), 256, 48);
  ctx.font = "24px 'Microsoft YaHei', sans-serif";
  ctx.fillStyle = "#d8c9a3";
  ctx.fillText(`${count} 包`, 256, 88);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}
