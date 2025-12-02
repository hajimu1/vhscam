// VHSConverter.jsx
import React, { useState, useRef, useEffect, useCallback } from "react";
import * as Gifuct from "gifuct-js";

/* -------------------------------- utilities -------------------------------- */
const loadScript = (src, id) =>
  new Promise((resolve, reject) => {
    if (document.getElementById(id)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.id = id;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

const dataURLToBlob = (dataurl) => {
  const [meta, data] = dataurl.split(",");
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
};

function applyBlackWhiteGamma(r, g, b, blackPoint, whitePoint, gamma) {
  const map = (v) => {
    let t = (v - blackPoint) / (whitePoint - blackPoint || 1);
    t = Math.max(0, Math.min(1, t));
    t = Math.pow(t, 1 / gamma);
    return Math.round(t * 255);
  };
  return [map(r), map(g), map(b)];
}

/* -------------------------------- GIF helpers -------------------------------- */
const renderGifFrame = (frame, canvas, prevImageData) => {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (frame.disposalType === 2) ctx.clearRect(0, 0, canvas.width, canvas.height);
  else if (frame.disposalType === 3 && prevImageData) ctx.putImageData(prevImageData, 0, 0);

  const temp = document.createElement("canvas");
  temp.width = frame.dims.width;
  temp.height = frame.dims.height;
  const tctx = temp.getContext("2d");
  const imgData = tctx.createImageData(frame.dims.width, frame.dims.height);
  imgData.data.set(frame.patch);
  tctx.putImageData(imgData, 0, 0);

  ctx.drawImage(temp, frame.dims.left, frame.dims.top);
  const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const saved = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { full, saved };
};

const getGifFramesData = (buffer) => {
  const gif = Gifuct.parseGIF(buffer);
  const frames = Gifuct.decompressFrames(gif, true);
  if (!frames || frames.length === 0) throw new Error("GIF 프레임 없음");
  const w = gif.lsd.width,
    h = gif.lsd.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const frameDataURLs = [];
  let prev = null;
  for (const f of frames) {
    const { full, saved } = renderGifFrame(f, canvas, prev);
    prev = saved;
    ctx.putImageData(full, 0, 0);
    frameDataURLs.push(canvas.toDataURL("image/png"));
  }
  return { frames: frameDataURLs, width: w, height: h };
};

const applyEmboss = (imgData, amount) => {
  const d = imgData.data;
  const w = imgData.width;
  const h = imgData.height;
  const tmp = new Uint8ClampedArray(d);

  const kernel = [
    [-2, -1, 0],
    [-1, 1, 1],
    [0, 1, 2]
  ];

  // 💡 원본 데이터 백업
  const original = new Uint8ClampedArray(d);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const i = ((y + ky) * w + (x + kx)) * 4;
          const k = kernel[ky + 1][kx + 1];
          r += tmp[i] * k;
          g += tmp[i + 1] * k;
          b += tmp[i + 2] * k;
        }
      }
      const idx = (y * w + x) * 4;
      
      // 엠보스 결과 (회색조)
      const embossR = Math.max(0, Math.min(255, r + 128));
      const embossG = Math.max(0, Math.min(255, g + 128));
      const embossB = Math.max(0, Math.min(255, b + 128));
      
      // 💡 원본과 블렌딩 (amount로 강도 조절)
      const blend = amount / 2; // 0~1 범위로 조정
      d[idx] = original[idx] * (1 - blend) + embossR * blend;
      d[idx + 1] = original[idx + 1] * (1 - blend) + embossG * blend;
      d[idx + 2] = original[idx + 2] * (1 - blend) + embossB * blend;
    }
  }
  return imgData;
};

// 먼지/얼룩 효과
const applyDust = (imgData, intensity) => {
  if (intensity <= 0) return imgData;
  
  const d = imgData.data;
  const w = imgData.width;
  const h = imgData.height;
  
  const numSpots = Math.floor((w * h / 10000) * (intensity / 10));
  
  for (let i = 0; i < numSpots; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    const size = Math.floor(Math.random() * 5) + 1;
    const darkness = 0.3 + Math.random() * 0.4;
    
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= size) {
            const idx = (ny * w + nx) * 4;
            const factor = 1 - (dist / size) * darkness;
            d[idx] *= factor;
            d[idx + 1] *= factor;
            d[idx + 2] *= factor;
          }
        }
      }
    }
  }
  
  return imgData;
};

// 스크래치 효과
const applyScratches = (imgData, intensity) => {
  if (intensity <= 0) return imgData;
  
  const d = imgData.data;
  const w = imgData.width;
  const h = imgData.height;
  
  const numScratches = Math.floor((intensity / 10) * 3);
  
  for (let i = 0; i < numScratches; i++) {
    const isVertical = Math.random() > 0.3; // 70% 수직선
    const brightness = Math.random() > 0.5 ? 1.3 : 0.7; // 밝거나 어둡거나
    
    if (isVertical) {
      const x = Math.floor(Math.random() * w);
      const startY = Math.floor(Math.random() * h * 0.5);
      const length = Math.floor(h * 0.3 + Math.random() * h * 0.4);
      
      for (let y = startY; y < Math.min(h, startY + length); y++) {
        const idx = (y * w + x) * 4;
        d[idx] = Math.min(255, d[idx] * brightness);
        d[idx + 1] = Math.min(255, d[idx + 1] * brightness);
        d[idx + 2] = Math.min(255, d[idx + 2] * brightness);
      }
    } else {
      const y = Math.floor(Math.random() * h);
      const startX = Math.floor(Math.random() * w * 0.3);
      const length = Math.floor(w * 0.4 + Math.random() * w * 0.3);
      
      for (let x = startX; x < Math.min(w, startX + length); x++) {
        const idx = (y * w + x) * 4;
        d[idx] = Math.min(255, d[idx] * brightness);
        d[idx + 1] = Math.min(255, d[idx + 1] * brightness);
        d[idx + 2] = Math.min(255, d[idx + 2] * brightness);
      }
    }
  }
  
  return imgData;
};

// 테이프 에이징 (색 바램)
const applyTapeAge = (imgData, intensity) => {
  if (intensity <= 0) return imgData;
  
  const d = imgData.data;
  const factor = intensity / 100;
  
  for (let i = 0; i < d.length; i += 4) {
    // 세피아 톤 + 채도 감소
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    
    // 세피아 변환
    const tr = 0.393 * r + 0.769 * g + 0.189 * b;
    const tg = 0.349 * r + 0.686 * g + 0.168 * b;
    const tb = 0.272 * r + 0.534 * g + 0.131 * b;
    
    // 원본과 블렌딩
    d[i] = r * (1 - factor) + tr * factor;
    d[i + 1] = g * (1 - factor) + tg * factor;
    d[i + 2] = b * (1 - factor) + tb * factor;
  }
  
  return imgData;
};

const applyTVGlow = (imgData, glowStrength) => {
  const d = imgData.data;
  const w = imgData.width;
  const h = imgData.height;
  const tmp = new Uint8ClampedArray(d);

  const radius = 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const ni = (ny * w + nx) * 4;
            rSum += tmp[ni];
            gSum += tmp[ni + 1];
            bSum += tmp[ni + 2];
            count++;
          }
        }
      }
      d[i] = d[i] * (1 - glowStrength) + (rSum / count) * glowStrength;
      d[i + 1] = d[i + 1] * (1 - glowStrength) + (gSum / count) * glowStrength;
      d[i + 2] = d[i + 2] * (1 - glowStrength) + (bSum / count) * glowStrength;
    }
  }
  return imgData;
};

/* -------------------------------- VHS core -------------------------------- */
const applyVHSEffect = (imgData, s) => {
  const d = imgData.data;
  const w = imgData.width;
  const h = imgData.height;

  // 1) 기본 색 보정 (Black/White/Gamma -> Brightness/Contrast/Saturation/Grayscale/Invert)
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i],
      g = d[i + 1],
      b = d[i + 2];

    [r, g, b] = applyBlackWhiteGamma(r, g, b, s.blackPoint, s.whitePoint, s.gamma);

    if (s.brightness) {
      r += s.brightness;
      g += s.brightness;
      b += s.brightness;
    }
    if (s.contrast) {
      const f = (259 * (s.contrast + 255)) / (255 * (259 - s.contrast));
      r = f * (r - 128) + 128;
      g = f * (g - 128) + 128;
      b = f * (b - 128) + 128;
    }
    if (s.saturation) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = 1 + s.saturation / 100;
      r = gray + sat * (r - gray);
      g = gray + sat * (g - gray);
      b = gray + sat * (b - gray);
    }
    if (s.grayscale) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = gray;
    }
    if (s.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }

  // 이후 픽셀 조작 효과들은 임시 배열(tmp)을 사용하여 원본 데이터를 보존해야 함

  // 2) Sharpen (간단한 언샤프 마스크 느낌)
  if (s.sharpen > 0) {
    const tmp = new Uint8ClampedArray(d);
    const amount = s.sharpen;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const center = tmp[i + c];
          const sum =
            tmp[((y - 1) * w + x) * 4 + c] +
            tmp[((y + 1) * w + x) * 4 + c] +
            tmp[(y * w + x - 1) * 4 + c] +
            tmp[(y * w + x + 1) * 4 + c];
          d[i + c] = Math.max(0, Math.min(255, center + amount * (center * 4 - sum)));
        }
      }
    }
  }

  // 3) Edge wave (화면 흔들림)
  if (s.edgeWave > 0) {
    const tmp = new Uint8ClampedArray(d);
    const intensity = s.edgeWave;
    for (let y = 0; y < h; y++) {
      const offset = Math.floor(Math.sin(y * 0.1) * intensity * 5);
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(w - 1, x + offset));
        const i = (y * w + x) * 4;
        const si = (y * w + sx) * 4;
        d[i] = tmp[si];
        d[i + 1] = tmp[si + 1];
        d[i + 2] = tmp[si + 2];
      }
    }
  }

  // 4) Luma smear (단순 수직 혼합)
  if (s.lumaSmear > 0) {
    const tmp = new Uint8ClampedArray(d);
    const radius = Math.max(1, Math.floor(s.lumaSmear));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let lumaSum = 0,
          count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < h) {
            const ti = (ny * w + x) * 4;
            lumaSum += 0.299 * tmp[ti] + 0.587 * tmp[ti + 1] + 0.114 * tmp[ti + 2];
            count++;
          }
        }
        const avgLuma = lumaSum / (count || 1);
        const mixFactor = Math.min(1, s.lumaSmear / 10);
        d[i] = d[i] * (1 - mixFactor) + avgLuma * mixFactor;
        d[i + 1] = d[i + 1] * (1 - mixFactor) + avgLuma * mixFactor;
        d[i + 2] = d[i + 2] * (1 - mixFactor) + avgLuma * mixFactor;
      }
    }
  }

  // 5) Color bleed horizontal / vertical (간단 평균)
  if (s.colorBleedH > 0) {
    const tmp = new Uint8ClampedArray(d);
    const rads = Math.floor(s.colorBleedH);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let dx = -rads; dx <= rads; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) {
            const ti = (y * w + nx) * 4;
            r += tmp[ti];
            g += tmp[ti + 1];
            b += tmp[ti + 2];
            count++;
          }
        }
        const i = (y * w + x) * 4;
        d[i] = r / (count || 1);
        d[i + 1] = g / (count || 1);
        d[i + 2] = b / (count || 1);
      }
    }
  }
  if (s.colorBleedV > 0) {
    const tmp = new Uint8ClampedArray(d);
    const rads = Math.floor(s.colorBleedV);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let dy = -rads; dy <= rads; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < h) {
            const ti = (ny * w + x) * 4;
            r += tmp[ti];
            g += tmp[ti + 1];
            b += tmp[ti + 2];
            count++;
          }
        }
        const i = (y * w + x) * 4;
        d[i] = r / (count || 1);
        d[i + 1] = g / (count || 1);
        d[i + 2] = b / (count || 1);
      }
    }
  }

  // 6) Chroma phase / loss
  if (s.chromaPhase > 0) {
    const tmp = new Uint8ClampedArray(d);
    const shift = Math.floor(s.chromaPhase);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const rx = Math.min(w - 1, x + shift);
        const bx = Math.max(0, x - shift);
        // R (Red) shift
        d[i] = tmp[(y * w + rx) * 4];
        // G (Green) is usually kept as-is or averaged (Luma)
        // B (Blue) shift
        d[i + 2] = tmp[(y * w + bx) * 4 + 2];
      }
    }
  }
  if (s.chromaLoss > 0) {
    const loss = s.chromaLoss / 100;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i] * (1 - loss) + gray * loss;
      d[i + 1] = d[i + 1] * (1 - loss) + gray * loss;
      d[i + 2] = d[i + 2] * (1 - loss) + gray * loss;
    }
  }

  // 7) Video noise (monochrome-like)
  if (s.videoNoise > 0) {
    const amount = s.videoNoise * 2.55;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amount;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
  }

  // 8) Vignette
  if (s.vignette > 0) {
    const cx = w / 2,
      cy = h / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    const strength = s.vignette / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx,
          dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const factor = 1 - (dist / maxDist) * strength;
        const i = (y * w + x) * 4;
        d[i] *= factor;
        d[i + 1] *= factor;
        d[i + 2] *= factor;
      }
    }
  }
  
  // =========================================================
  // 💡 추가된 효과들
  // =========================================================
  
  // 9) Chromatic Aberration (R/B 채널 픽셀 시프트) - `chromatic` 설정 사용
  if (s.chromatic > 0) {
    const tmp = new Uint8ClampedArray(d);
    const shift = Math.floor(s.chromatic);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        
        // Red (R) 채널을 오른쪽으로 이동
        const rx = Math.min(w - 1, x - shift);
        const ri = (y * w + rx) * 4;
        
        // Blue (B) 채널을 왼쪽으로 이동
        const bx = Math.max(0, x + shift);
        const bi = (y * w + bx) * 4;
        
        // Green (G) 채널은 그대로 유지 (또는 별도의 시프트)
        
        // R 채널 업데이트
        d[i] = (ri >= 0 && ri < d.length) ? tmp[ri] : d[i];
        
        // B 채널 업데이트
        d[i + 2] = (bi + 2 >= 0 && bi + 2 < d.length) ? tmp[bi + 2] : d[i + 2];
        
        // G 채널은 tmp[i + 1]을 유지 (현재는 이미 d 배열에 있으므로 복사가 필요 없음)
        // d[i+1] = tmp[i+1]; // 필요하다면
      }
    }
  }
  
  // 10) Blur (간단한 박스 블러) - `blur` 설정 사용
  if (s.blur > 0) {
      const tmp = new Uint8ClampedArray(d);
      const radius = Math.floor(s.blur);
      for (let y = radius; y < h - radius; y++) {
          for (let x = radius; x < w - radius; x++) {
              const i = (y * w + x) * 4;
              let r = 0, g = 0, b = 0, count = 0;

              for (let dy = -radius; dy <= radius; dy++) {
                  for (let dx = -radius; dx <= radius; dx++) {
                      const ti = ((y + dy) * w + (x + dx)) * 4;
                      r += tmp[ti];
                      g += tmp[ti + 1];
                      b += tmp[ti + 2];
                      count++;
                  }
              }
              
              if (count > 0) {
                  d[i] = r / count;
                  d[i + 1] = g / count;
                  d[i + 2] = b / count;
              }
          }
      }
  }
  
  // 11) Noise (컬러 노이즈) - `noise` 설정 사용
  if (s.noise > 0) {
      const amount = s.noise * 2.55; // 0-100% -> 0-255
      for (let i = 0; i < d.length; i += 4) {
          const nr = (Math.random() - 0.5) * amount;
          const ng = (Math.random() - 0.5) * amount;
          const nb = (Math.random() - 0.5) * amount;
          
          d[i] = Math.max(0, Math.min(255, d[i] + nr));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + ng));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + nb));
      }
  }

  // 12) Scanlines (주사선 효과) - `scanlines` 설정 사용 (가장 마지막에 적용)
  if (s.scanlines > 0) {
      const alpha = s.scanlines / 200; // 0-100 -> 0-0.5
      for (let y = 0; y < h; y++) {
          if (y % 2 !== 0) { // 홀수 라인만 어둡게
              for (let x = 0; x < w; x++) {
                  const i = (y * w + x) * 4;
                  d[i] = Math.max(0, d[i] * (1 - alpha));
                  d[i + 1] = Math.max(0, d[i + 1] * (1 - alpha));
                  d[i + 2] = Math.max(0, d[i + 2] * (1 - alpha));
              }
          }
      }
// 13) Color Shift / RGB Separation
if (s.colorShift > 0) {
  const tmp = new Uint8ClampedArray(d);
  const maxShift = Math.floor(s.colorShift);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y*w+x)*4;
      const rIdx = ((y*w + Math.min(w-1,x+Math.floor(Math.random()*maxShift))) *4);
      const bIdx = ((y*w + Math.max(0,x-Math.floor(Math.random()*maxShift))) *4 +2);
      d[i] = tmp[rIdx];
      d[i+2] = tmp[bIdx];
    }
  }
}

// 14) VHS Burn / Corner Fade
if (s.burn > 0) {
  const factor = s.burn / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y*w+x)*4;
      const dx = Math.abs(x - w/2)/(w/2);
      const dy = Math.abs(y - h/2)/(h/2);
      const fade = Math.sqrt(dx*dx + dy*dy) * factor;
      d[i] *= 1 - fade*0.8;
      d[i+1] *= 1 - fade*0.6;
      d[i+2] *= 1 - fade*0.5;
    }
  }
}

// 15) VHS Tracking Noise / Rolling Lines
if (s.trackingNoise > 0) {
  const shift = Math.floor(Math.random() * s.trackingNoise * 2 - s.trackingNoise);
  const tmp = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    const rowShift = (y % 3 === 0) ? shift : 0;
    for (let x = 0; x < w; x++) {
      const i = (y*w+x)*4;
      const j = (y*w+Math.min(w-1,Math.max(0,x+rowShift)))*4;
      d[i] = tmp[j]; 
      d[i+1] = tmp[j+1]; 
      d[i+2] = tmp[j+2];
    }
  }
}
  }
  // =========================================================

  return imgData;
};

/* -------------------------------- Component -------------------------------- */
const VHSConverter = () => {
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const originalSize = useRef({ width: 0, height: 0 });
  const playTimer = useRef(null);

  const defaultSettings = {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    grayscale: false,
    invert: false,
    gamma: 1,
    blackPoint: 0,
    whitePoint: 255,
    chromatic: 2, // 💡 추가된 효과
    scanlines: 10, // 💡 추가된 효과
    noise: 0, // 💡 추가된 효과
    blur: 0, // 💡 추가된 효과
    vignette: 0,
    edgeWave: 0,
    sharpen: 0.5,
    colorBleedH: 0,
    colorBleedV: 0,
    chromaPhase: 0,
    chromaLoss: 0,
    videoNoise: 0,
    lumaSmear: 0,
    tapeSpeed: 0.2,
  colorShift: 0,      // RGB Separation (0-20)
  burn: 0,            // Corner Fade (0-100)
  trackingNoise: 0,   // Tracking Noise (0-50)
  emboss: 0,          // Emboss (0-2)
  tvGlow: 0,          // TV Glow (0-100)
  tapeAge: 0,      // 전체 에이징 강도 (0-100)
  dust: 0,         // 먼지/얼룩 (0-100)
  scratches: 0,    // 스크래치 (0-100)
    width: "",
    height: "",
    lockAspectRatio: true,
  };

const presets = {
  "원본": {
    brightness: 0, contrast: 0, saturation: 0, grayscale: false, invert: false,
    gamma: 1, blackPoint: 0, whitePoint: 255, chromatic: 0, scanlines: 0,
    noise: 0, blur: 0, vignette: 0, edgeWave: 0, sharpen: 0, colorBleedH: 0,
    colorBleedV: 0, chromaPhase: 0, chromaLoss: 0, videoNoise: 0, lumaSmear: 0,
    colorShift: 0, burn: 0, trackingNoise: 0, emboss: 0, tvGlow: 0,
    tapeAge: 0, dust: 0, scratches: 0
  },
  "클래식 VHS": {
    brightness: -5, contrast: 15, saturation: -20, chromatic: 3, scanlines: 25,
    blur: 1, vignette: 30, sharpen: 0.8, colorBleedH: 2, chromaPhase: 2,
    chromaLoss: 15, videoNoise: 8, burn: 15, trackingNoise: 5, tvGlow: 20,
    tapeAge: 30, dust: 20, scratches: 15
  },
  "90년대 캠코더": {
    brightness: 10, contrast: 20, saturation: 30, chromatic: 2, scanlines: 15,
    blur: 0, vignette: 20, sharpen: 1.2, colorBleedH: 1, colorBleedV: 1,
    chromaPhase: 1, videoNoise: 5, colorShift: 3, burn: 10, tvGlow: 15,
    tapeAge: 10, dust: 5, scratches: 5
  },
  "손상된 테이프": {
    brightness: -15, contrast: -10, saturation: -40, chromatic: 8, scanlines: 40,
    blur: 2, vignette: 50, edgeWave: 2, colorBleedH: 4, colorBleedV: 3,
    chromaPhase: 5, chromaLoss: 60, videoNoise: 30, trackingNoise: 35,
    colorShift: 10, burn: 40, emboss: 0.3, tvGlow: 10,
    tapeAge: 80, dust: 60, scratches: 50
  },
  "몽환적 레트로": {
    brightness: 5, contrast: 10, saturation: -30, gamma: 1.2, chromatic: 5,
    scanlines: 20, blur: 2, vignette: 70, sharpen: 0.3, lumaSmear: 5,
    chromaLoss: 30, videoNoise: 12, burn: 50, tvGlow: 60, emboss: 0.5,
    tapeAge: 40, dust: 30, scratches: 20
  },
  "흑백 빈티지": {
    brightness: -10, contrast: 30, saturation: 0, grayscale: true, gamma: 1.3,
    scanlines: 35, vignette: 60, sharpen: 1.5, videoNoise: 20, burn: 30,
    trackingNoise: 15, tvGlow: 25,
    tapeAge: 70, dust: 50, scratches: 40
  }
};

  const [settings, setSettings] = useState({ ...defaultSettings });
  const [image, setImage] = useState(null); // {src, width, height}
  const [gifFrames, setGifFrames] = useState([]); // array
  const [ditheredFrames, setDitheredFrames] = useState([]); // cached processed frames
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  /* helper: set and keep aspect ratio */
  const handleWidthChange = (val) => {
    const w = parseInt(val) || "";
    setSettings((s) => {
      if (!w) return { ...s, width: "" };
      const next = { ...s, width: w };
      if (s.lockAspectRatio && originalSize.current.width) {
        next.height = Math.round((w * originalSize.current.height) / originalSize.current.width);
      }
      return next;
    });
  };
  const handleHeightChange = (val) => {
    const h = parseInt(val) || "";
    setSettings((s) => {
      if (!h) return { ...s, height: "" };
      const next = { ...s, height: h };
      if (s.lockAspectRatio && originalSize.current.height) {
        next.width = Math.round((h * originalSize.current.width) / originalSize.current.height);
      }
      return next;
    });
  };

  /* load file */
  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    setGifFrames([]);
    setDitheredFrames([]);
    setResult(null);
    setFrameIndex(0); // 파일 업로드 시 프레임 인덱스 초기화
    setPlaying(false); // 재생 중지
    
    const isGif = file.type === "image/gif";
    const reader = new FileReader();
    if (isGif) {
      reader.readAsArrayBuffer(file);
      reader.onload = (ev) => {
        try {
          const { frames, width, height } = getGifFramesData(ev.target.result);
          originalSize.current = { width, height };
          setImage({ src: frames[0], width, height }); // 첫 프레임을 이미지로 설정
          setGifFrames(frames);
          setSettings((s) => ({ ...s, width: width, height: height }));
        } catch (err) {
          console.error(err);
          alert("GIF 파일을 처리하는 데 실패했습니다.");
        } finally {
          setProcessing(false);
        }
      };
      reader.onerror = () => setProcessing(false);
    } else {
      reader.readAsDataURL(file);
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          originalSize.current = { width: img.width, height: img.height };
          setImage({ src: img.src, width: img.width, height: img.height });
          setSettings((s) => ({ ...s, width: img.width, height: img.height }));
          setProcessing(false);
        };
        img.onerror = () => setProcessing(false);
        img.src = ev.target.result;
      };
      reader.onerror = () => setProcessing(false);
    }
  };

/* process frames (preview) - single frame or set */
const processImageFrames = useCallback(
  async (framesToProcess = null) => {
    // framesToProcess === null => preview single frame (image or current gif frame)
    setProcessing(true);
    const canvas = canvasRef.current;
    const tw = settings.width || originalSize.current.width || 512;
    const th = settings.height || originalSize.current.height || 512;
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;

    // GIF 프레임이 있으면 현재 프레임만, 없으면 단일 이미지만 처리
    const frames = framesToProcess ?? (gifFrames.length ? [gifFrames[frameIndex]] : image ? [image.src] : []);
    const out = [];

    for (const src of frames) {
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, tw, th);
          ctx.drawImage(img, 0, 0, tw, th);
          let data = ctx.getImageData(0, 0, tw, th);
          
          // 💡 여기가 핵심! Emboss와 TV Glow를 먼저 적용
          if (settings.emboss > 0) {
            data = applyEmboss(data, settings.emboss);
          }
          if (settings.tvGlow > 0) {
            data = applyTVGlow(data, settings.tvGlow / 100);
          }
          
          // 그 다음 VHS 효과 적용
          data = applyVHSEffect(data, settings);

if (settings.tapeAge > 0) {
    data = applyTapeAge(data, settings.tapeAge);
  }
  if (settings.dust > 0) {
    data = applyDust(data, settings.dust);
  }
  if (settings.scratches > 0) {
    data = applyScratches(data, settings.scratches);
  }

          ctx.putImageData(data, 0, 0);
          out.push(canvas.toDataURL("image/png"));
          resolve();
        };
        img.onerror = () => {
          // fallback: blank
          const tmp = document.createElement("canvas");
          tmp.width = tw;
          tmp.height = th;
          out.push(tmp.toDataURL("image/png"));
          resolve();
        };
        img.src = src;
      });
    }

    setDitheredFrames(out);
    setResult(out[0] || null);
    setProcessing(false);
    return out;
  },
  [settings, image, gifFrames, frameIndex]
);

 useEffect(() => {
  if (!image) return;
  processImageFrames();
}, [
  settings.brightness,
  settings.contrast,
  settings.saturation,
  settings.grayscale,
  settings.invert,
  settings.sharpen,
  settings.edgeWave,
  settings.lumaSmear,
  settings.colorBleedH,
  settings.colorBleedV,
  settings.chromaPhase,
  settings.chromaLoss,
  settings.videoNoise,
  settings.vignette,
  settings.gamma,
  settings.blackPoint,
  settings.whitePoint,
  settings.chromatic,
  settings.scanlines,
  settings.noise,
  settings.blur,
  settings.colorShift,
  settings.burn,
  settings.trackingNoise,
  settings.emboss,
  settings.tvGlow,
  settings.tapeAge,    // 💡 추가
  settings.dust,       // 💡 추가
  settings.scratches,  // 💡 추가
  settings.width,
  settings.height,
  image,
  frameIndex,
  processImageFrames
]);

  /* gif play */
  useEffect(() => {
    if (!playing || gifFrames.length === 0) {
      if (playTimer.current) {
        clearInterval(playTimer.current);
        playTimer.current = null;
      }
      return;
    }
    const interval = Math.max(40, 300 - settings.tapeSpeed * 250); // tapeSpeed affects
    playTimer.current = setInterval(() => {
      setFrameIndex((p) => (p + 1) % gifFrames.length);
    }, interval);
    return () => {
      if (playTimer.current) {
        clearInterval(playTimer.current);
        playTimer.current = null;
      }
    };
  }, [playing, gifFrames, settings.tapeSpeed]);

  /* download current PNG */
  const downloadPNG = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result;
    a.download = `vhs_result_${Date.now()}.png`;
    a.click();
  };

  /* save all frames as zip (for GIFs) */
  const saveFramesAsZip = async () => {
    if (gifFrames.length === 0 && !result) {
      alert("저장할 프레임이 없습니다.");
      return;
    }
    setProcessing(true);
    
    try {
      // ensure JSZip/FileSaver loaded
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "jszip-cdn");
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js", "filesaver-cdn");
      if (typeof window.JSZip === "undefined" || typeof window.saveAs === "undefined") {
        throw new Error("ZIP 라이브러리 로드 실패");
      }
      
      let framesToZip = ditheredFrames;
      // GIF 파일인데 전체 프레임이 처리되지 않았을 경우, 모든 프레임을 처리합니다.
      if (gifFrames.length > 0 && ditheredFrames.length !== gifFrames.length) {
        // process all frames (may be heavy)
        framesToZip = await processImageFrames(gifFrames);
      } else if (gifFrames.length === 0 && result) {
        // 단일 이미지인 경우, 현재 결과를 프레임으로 사용
        framesToZip = [result];
      }
      
      const zip = new window.JSZip();
      framesToZip.forEach((durl, idx) => {
        const blob = dataURLToBlob(durl);
        zip.file(`vhs_frame_${String(idx + 1).padStart(3, "0")}.png`, blob);
      });
      const blob = await zip.generateAsync({ type: "blob" });
      window.saveAs(blob, `vhs_frames_${Date.now()}.zip`);
    } catch (err) {
      console.error(err);
      alert("ZIP 저장 실패: " + (err.message || err));
    } finally {
      setProcessing(false);
      // 전체 프레임을 처리했더라도, preview는 현재 프레임으로 유지
      processImageFrames(); 
    }
  };

  /* reset effects but keep size */
  const resetEffects = () => {
    setSettings((s) => ({
      ...defaultSettings,
      width: s.width || originalSize.current.width || "",
      height: s.height || originalSize.current.height || "",
      lockAspectRatio: s.lockAspectRatio ?? true,
    }));
  };

  /* UI small helpers */
  const SliderRow = ({ label, settingKey, min = 0, max = 100, step = 1 }) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <div>{label}</div>
        <div style={{ color: "#d6bcfa" }}>{String(settings[settingKey])}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={settings[settingKey]}
          onChange={(e) => setSettings((s) => ({ ...s, [settingKey]: Number(e.target.value) }))}
          style={{ flex: 1 }}
        />
        <input
          type={step < 1 ? "number" : "number"}
          step={step}
          value={settings[settingKey]}
          onChange={(e) => setSettings((s) => ({ ...s, [settingKey]: Number(e.target.value) || 0 }))}
          style={{ width: 72, background: "#1f2937", color: "white", border: "none", padding: "6px 8px", borderRadius: 6 }}
        />
      </div>
    </div>
  );
  
  const DisplayImage = () => {
    if (processing) {
      return <div style={{ color: "#c084fc" }}>처리중...</div>;
    }
    
    // GIF 재생 중일 때: 캐시된 (처리된) 프레임 보여주기
    if (playing && ditheredFrames.length > frameIndex) {
      return <img src={ditheredFrames[frameIndex]} alt="result" style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }} />;
    }

    // 단일 이미지나 GIF 일시정지 상태일 때: result (현재 처리된 프레임) 보여주기
    if (result) {
      return <img src={result} alt="result" style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }} />;
    }
    
    return <div style={{ color: "#94a3b8" }}>변환 결과가 여기에 표시됩니다</div>;
  };

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "linear-gradient(180deg,#0f172a,#381d6d)", color: "white", padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <h1 style={{ textAlign: "center", fontSize: 22, marginBottom: 12 }}>
          📺 VHS 아날로그 캠코더 변환기 📼
        </h1>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
          {/* controls */}
          <div style={{ background: "#111827", padding: 12, borderRadius: 10, maxHeight: "80vh", overflowY: "auto" }}>
            <input ref={fileRef} type="file" accept="image/*,.gif" style={{ display: "none" }} onChange={handleFile} />
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button onClick={() => fileRef.current?.click()} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: "#7c3aed", color: "white", border: "none" }}>
                이미지 업로드
              </button>
              <button onClick={resetEffects} style={{ padding: "8px 10px", borderRadius: 8, background: "#374151", color: "white", border: "none" }}>
                초기화
              </button>
            </div>

  {/* 💡 여기에 프리셋 추가 */}
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 12, marginBottom: 6, color: "#c4b5fd" }}>프리셋</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {Object.keys(presets).map((presetName) => (
        <button
          key={presetName}
          onClick={() => {
            const preset = presets[presetName];
            setSettings((s) => ({
              ...s,
              ...preset,
              width: s.width,
              height: s.height,
              lockAspectRatio: s.lockAspectRatio
            }));
          }}
          style={{
            padding: "6px 8px",
            borderRadius: 6,
            background: "#374151",
            color: "white",
            border: "none",
            fontSize: 11,
            cursor: "pointer",
            transition: "background 0.2s"
          }}
          onMouseEnter={(e) => e.target.style.background = "#4b5563"}
          onMouseLeave={(e) => e.target.style.background = "#374151"}
        >
          {presetName}
        </button>
      ))}
    </div>
  </div>

  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
    {/* PNG, ZIP 저장 버튼들 */}
  </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button onClick={downloadPNG} style={{ flex: 1, padding: "8px", borderRadius: 8, background: "#059669", color: "white", border: "none" }}>
                PNG 저장
              </button>
              <button onClick={saveFramesAsZip} style={{ padding: "8px", borderRadius: 8, background: "#db2777", color: "white", border: "none" }}>
                ZIP 저장
              </button>
            </div>

            {/* Size */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>너비 (Width)</div>
                  <input
                    type="number"
                    min="1"
                    value={settings.width || ""}
                    onChange={(e) => handleWidthChange(e.target.value)}
                    style={{ width: "100%", padding: 8, borderRadius: 6, background: "#0b1220", color: "white", border: "none" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>높이 (Height)</div>
                  <input
                    type="number"
                    min="1"
                    value={settings.height || ""}
                    onChange={(e) => handleHeightChange(e.target.value)}
                    style={{ width: "100%", padding: 8, borderRadius: 6, background: "#0b1220", color: "white", border: "none" }}
                  />
                </div>
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={settings.lockAspectRatio}
                  onChange={(e) => setSettings((s) => ({ ...s, lockAspectRatio: e.target.checked }))}
                />
                원본 비율 고정
              </label>
            </div>

            {/* sliders grouped compactly */}
            <div style={{ marginTop: 6 }}>
              <h4 style={{ margin: "8px 0", color: "#c4b5fd" }}>기본 색보정</h4>
              <SliderRow label="밝기 (Brightness)" settingKey="brightness" min={-100} max={100} step={1} />
              <SliderRow label="대비 (Contrast)" settingKey="contrast" min={-100} max={100} step={1} />
              <SliderRow label="채도 (Saturation)" settingKey="saturation" min={-100} max={100} step={1} />
              <SliderRow label="감마 (Gamma)" settingKey="gamma" min={0.1} max={3} step={0.01} />
              <SliderRow label="블랙 포인트" settingKey="blackPoint" min={0} max={128} step={1} />
              <SliderRow label="화이트 포인트" settingKey="whitePoint" min={127} max={255} step={1} />

              <h4 style={{ margin: "12px 0 8px", color: "#fbcfe8" }}>VHS / 아날로그 효과</h4>
              <SliderRow label="Sharpen" settingKey="sharpen" min={0} max={3} step={0.05} />
              <SliderRow label="Edge Wave" settingKey="edgeWave" min={0} max={3} step={0.05} />
              <SliderRow label="Luma Smear" settingKey="lumaSmear" min={0} max={10} step={1} />
              <SliderRow label="Color Bleed H" settingKey="colorBleedH" min={0} max={5} step={1} />
              <SliderRow label="Color Bleed V" settingKey="colorBleedV" min={0} max={5} step={1} />
              
              <SliderRow label="Blur" settingKey="blur" min={0} max={5} step={1} /> {/* 💡 추가된 슬라이더 */}

              <h4 style={{ margin: "12px 0 8px", color: "#fde68a" }}>Chroma / Noise</h4>
              <SliderRow label="Chroma Phase" settingKey="chromaPhase" min={0} max={10} step={1} />
              <SliderRow label="Chromatic Aberration" settingKey="chromatic" min={0} max={10} step={1} /> {/* 💡 추가된 슬라이더 */}
              <SliderRow label="Chroma Loss (%)" settingKey="chromaLoss" min={0} max={100} step={1} />
              <SliderRow label="Video Noise (Luma)" settingKey="videoNoise" min={0} max={100} step={1} />
              <SliderRow label="Color Noise" settingKey="noise" min={0} max={100} step={1} /> {/* 💡 추가된 슬라이더 */}
              <SliderRow label="Vignette (%)" settingKey="vignette" min={0} max={100} step={1} />

<h4 style={{ margin: "12px 0 8px", color: "#93c5fd" }}>추가 VHS 효과</h4>
<SliderRow label="Color Shift (RGB 분리)" settingKey="colorShift" min={0} max={20} step={1} />
<SliderRow label="Corner Burn" settingKey="burn" min={0} max={100} step={1} />
<SliderRow label="Tracking Noise" settingKey="trackingNoise" min={0} max={50} step={1} />
<SliderRow label="Emboss" settingKey="emboss" min={0} max={2} step={0.1} />
<SliderRow label="TV Glow" settingKey="tvGlow" min={0} max={100} step={1} />
              <h4 style={{ margin: "12px 0 8px", color: "#93c5fd" }}>기타</h4>
<h4 style={{ margin: "12px 0 8px", color: "#fbbf24" }}>테이프 에이징</h4>
<SliderRow label="전체 에이징" settingKey="tapeAge" min={0} max={100} step={1} />
<SliderRow label="먼지/얼룩" settingKey="dust" min={0} max={100} step={1} />
<SliderRow label="스크래치" settingKey="scratches" min={0} max={100} step={1} />
              <SliderRow label="Scanlines" settingKey="scanlines" min={0} max={100} step={1} /> {/* 💡 추가된 슬라이더 */}
              <SliderRow label="Tape Speed (GIF 재생 영향)" settingKey="tapeSpeed" min={0} max={1} step={0.01} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={settings.grayscale}
                    onChange={(e) => setSettings((s) => ({ ...s, grayscale: e.target.checked }))}
                  />
                  흑백
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={settings.invert}
                    onChange={(e) => setSettings((s) => ({ ...s, invert: e.target.checked }))}
                  />
                  반전
                </label>
              </div>
            </div>
          </div>

          {/* preview area (two columns) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 12 }}>
              {/* original */}
              <div style={{ flex: 1, background: "#0b1220", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 14, marginBottom: 8, color: "#c7d2fe" }}>원본</div>
                <div style={{ background: "black", borderRadius: 8, minHeight: 320, display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}>
                  {image ? (
                    <img
                      src={gifFrames.length > 0 ? gifFrames[frameIndex] : image.src}
                      alt="original"
                      style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
                    />
                  ) : (
                    <div style={{ color: "#94a3b8" }}>이미지를 업로드하세요 (JPG / PNG / GIF)</div>
                  )}
                </div>

                {gifFrames.length > 1 && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <button 
                      onClick={() => {setPlaying(false); setFrameIndex((p) => (p - 1 + gifFrames.length) % gifFrames.length);}} 
                      style={{ padding: 8, background: "#1f2937", borderRadius: 6, border: "none", color: "white" }}
                      disabled={playing}
                    >
                      ◀
                    </button>
                    <button onClick={() => setPlaying((p) => !p)} style={{ flex: 1, padding: 8, background: "#7c3aed", color: "white", borderRadius: 6, border: "none" }}>
                      {playing ? "정지" : "재생"}
                    </button>
                    <button 
                      onClick={() => {setPlaying(false); setFrameIndex((p) => (p + 1) % gifFrames.length);}} 
                      style={{ padding: 8, background: "#1f2937", borderRadius: 6, border: "none", color: "white" }}
                      disabled={playing}
                    >
                      ▶
                    </button>
                    <div style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 13 }}>
                      프레임 {frameIndex + 1}/{gifFrames.length}
                    </div>
                  </div>
                )}
              </div>

              {/* result */}
              <div style={{ flex: 1, background: "#0b1220", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 14, marginBottom: 8, color: "#fbcfe8" }}>VHS 변환 결과</div>
                <div style={{ background: "black", borderRadius: 8, minHeight: 320, display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}>
                  <DisplayImage /> {/* 💡 수정된 컴포넌트 사용 */}
                </div>
              </div>
            </div>

            <canvas ref={canvasRef} style={{ display: "none" }} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default VHSConverter;