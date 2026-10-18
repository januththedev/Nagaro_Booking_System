/**
 * Seed data.
 *
 * Two modes:
 *   - `node src/server/db/seed.js`            catalogue only (spaces, rates, desks)
 *   - `node src/server/db/seed.js --demo`      catalogue + customers + bookings + inquiries
 *
 * Idempotent: existing spaces (matched by code) are never duplicated or
 * overwritten. Demo reservations are only created when the database has no
 * reservations at all, so re-running never piles up fake bookings.
 */
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from './connection.js';
import { applyMigrations } from './migrate.js';
import { businessLocalToEpoch, businessDateKey, startOfBusinessDay } from '../domain/time.js';
import { SPACE_CATEGORY, SPACE_STATUS } from '../domain/constants.js';
import { createSpace, getSpaceByCode, publishSpace, addImageRecord } from '../services/spaceService.js';
import { createCustomer } from '../services/customerService.js';
import { createReservation, createMaintenanceBlock } from '../services/bookingService.js';
import { nextReference, randomToken } from '../domain/references.js';
import { withWriteTransaction } from './connection.js';
import { hashPassword } from '../security/passwords.js';
import { recordAudit } from '../services/auditService.js';
import { ensureUploadDir, uploadDir } from '../security/uploads.js';

/* ------------------------------------------------- generated placeholder art */

/**
 * Minimal PNG encoder used to create honest placeholder artwork for seeded
 * spaces. Real photographs are uploaded by staff through the normal upload
 * flow; these are clearly synthetic gradient banners.
 */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y, width, height);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const idat = deflateSync(raw, { level: 6 });

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crcTable = encodePng.crcTable ??= buildCrcTable();
    let crc = 0xFFFFFFFF;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([length, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

function gradientPng(width, height, from, to) {
  return encodePng(width, height, (x, y) => {
    const t = (x / width) * 0.6 + (y / height) * 0.4;
    return [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
  });
}

/* ---------------- Architectural Interior Scene PNG Renderer ---------------- */

function hex(value) {
  const clean = value.startsWith('#') ? value.slice(1) : value;
  const num = parseInt(clean, 16);
  return [(num >> 16) & 0xFF, (num >> 8) & 0xFF, num & 0xFF];
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function mixRgb(a, b, t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    (a[0] + (b[0] - a[0]) * u) | 0,
    (a[1] + (b[1] - a[1]) * u) | 0,
    (a[2] + (b[2] - a[2]) * u) | 0,
  ];
}

function createSceneCanvas(width, height) {
  const buf = new Uint8Array(width * height * 3);

  const blendPixel = (x, y, r, g, b, alpha) => {
    if (x < 0 || x >= width || y < 0 || y >= height || alpha <= 0) return;
    const idx = (y * width + x) * 3;
    if (alpha >= 0.999) {
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      return;
    }
    const inv = 1 - alpha;
    buf[idx] = (buf[idx] * inv + r * alpha) | 0;
    buf[idx + 1] = (buf[idx + 1] * inv + g * alpha) | 0;
    buf[idx + 2] = (buf[idx + 2] * inv + b * alpha) | 0;
  };

  const fillRect = (x, y, w, h, color, alpha = 1) => {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    const [r, g, b] = color;
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        blendPixel(px, py, r, g, b, alpha);
      }
    }
  };

  const fillRectGradientV = (x, y, w, h, topColor, bottomColor, alpha = 1) => {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    const span = Math.max(1, h);
    for (let py = y0; py < y1; py += 1) {
      const t = (py - y) / span;
      const [r, g, b] = mixRgb(topColor, bottomColor, t);
      for (let px = x0; px < x1; px += 1) {
        blendPixel(px, py, r, g, b, alpha);
      }
    }
  };

  const fillPoly = (points, colorOrShader, alpha = 1) => {
    if (points.length < 3) return;
    let minY = height;
    let maxY = 0;
    for (const [, py] of points) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));
    const isShader = typeof colorOrShader === 'function';
    const [cr, cg, cb] = isShader ? [0, 0, 0] : colorOrShader;
    const n = points.length;

    for (let py = y0; py <= y1; py += 1) {
      const scanY = py + 0.5;
      const nodes = [];
      let j = n - 1;
      for (let i = 0; i < n; i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi < scanY && yj >= scanY) || (yj < scanY && yi >= scanY)) {
          nodes.push(xi + ((scanY - yi) / (yj - yi)) * (xj - xi));
        }
        j = i;
      }
      nodes.sort((a, b) => a - b);
      for (let k = 0; k < nodes.length - 1; k += 2) {
        const xStart = Math.max(0, Math.floor(nodes[k]));
        const xEnd = Math.min(width - 1, Math.ceil(nodes[k + 1]));
        for (let px = xStart; px <= xEnd; px += 1) {
          if (isShader) {
            const [sr, sg, sb, sa = alpha] = colorOrShader(px, py);
            blendPixel(px, py, sr, sg, sb, sa);
          } else {
            blendPixel(px, py, cr, cg, cb, alpha);
          }
        }
      }
    }
  };

  const fillPolyVGrad = (points, topColor, bottomColor, alpha = 1) => {
    let minY = height;
    let maxY = 0;
    for (const [, py] of points) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const span = Math.max(1, maxY - minY);
    fillPoly(points, (px, py) => {
      const [r, g, b] = mixRgb(topColor, bottomColor, (py - minY) / span);
      return [r, g, b, alpha];
    }, alpha);
  };

  const fillPolyHGrad = (points, leftColor, rightColor, alpha = 1) => {
    let minX = width;
    let maxX = 0;
    for (const [px] of points) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
    }
    const span = Math.max(1, maxX - minX);
    fillPoly(points, (px) => {
      const [r, g, b] = mixRgb(leftColor, rightColor, (px - minX) / span);
      return [r, g, b, alpha];
    }, alpha);
  };

  const drawLine = (x0, y0, x1, y1, thickness, color, alpha = 1) => {
    const rHalf = thickness * 0.5;
    const pad = rHalf + 1.2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + pad));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy || 1;
    const [r, g, b] = color;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
        const projX = x0 + t * dx;
        const projY = y0 + t * dy;
        const dist = Math.hypot(px - projX, py - projY);
        if (dist <= rHalf + 0.8) {
          const cov = dist <= rHalf - 0.4 ? 1 : Math.max(0, (rHalf + 0.8 - dist) / 1.2);
          blendPixel(px, py, r, g, b, alpha * cov);
        }
      }
    }
  };

  const strokePoly = (points, thickness, color, alpha = 1, closed = true) => {
    const limit = closed ? points.length : points.length - 1;
    for (let i = 0; i < limit; i += 1) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      drawLine(x0, y0, x1, y1, thickness, color, alpha);
    }
  };

  const fillEllipse = (cx, cy, rx, ry, color, alpha = 1) => {
    const minX = Math.max(0, Math.floor(cx - rx - 1));
    const maxX = Math.min(width - 1, Math.ceil(cx + rx + 1));
    const minY = Math.max(0, Math.floor(cy - ry - 1));
    const maxY = Math.min(height - 1, Math.ceil(cy + ry + 1));
    const [r, g, b] = color;
    for (let py = minY; py <= maxY; py += 1) {
      const ny = (py - cy) / ry;
      for (let px = minX; px <= maxX; px += 1) {
        const nx = (px - cx) / rx;
        const d = Math.hypot(nx, ny);
        if (d <= 1.05) {
          const cov = d <= 0.92 ? 1 : Math.max(0, (1.05 - d) / 0.13);
          blendPixel(px, py, r, g, b, alpha * cov);
        }
      }
    }
  };

  const addRadialGlow = (cx, cy, rx, ry, color, maxAlpha = 0.35) => {
    const minX = Math.max(0, Math.floor(cx - rx));
    const maxX = Math.min(width - 1, Math.ceil(cx + rx));
    const minY = Math.max(0, Math.floor(cy - ry));
    const maxY = Math.min(height - 1, Math.ceil(cy + ry));
    const [r, g, b] = color;
    for (let py = minY; py <= maxY; py += 1) {
      const ny = (py - cy) / ry;
      for (let px = minX; px <= maxX; px += 1) {
        const nx = (px - cx) / rx;
        const d2 = nx * nx + ny * ny;
        if (d2 < 1) {
          const falloff = (1 - d2) * (1 - d2);
          blendPixel(px, py, r, g, b, maxAlpha * falloff);
        }
      }
    }
  };

  const applyArchitecturalFinish = () => {
    // Subtle vignette and tactile architectural grain so surfaces feel warm and natural.
    for (let y = 0; y < height; y += 1) {
      const ny = (y / height) - 0.5;
      for (let x = 0; x < width; x += 1) {
        const nx = (x / width) - 0.5;
        const vig = 1 - Math.max(0, (nx * nx * 0.85 + ny * ny * 1.05) - 0.12) * 0.38;
        const hash = (((x * 374761393 + y * 668265263) ^ 0x5BF03635) >>> 0) & 0xFF;
        const grain = ((hash / 255) - 0.5) * 4.5;
        const idx = (y * width + x) * 3;
        buf[idx] = clampByte(buf[idx] * vig + grain);
        buf[idx + 1] = clampByte(buf[idx + 1] * vig + grain);
        buf[idx + 2] = clampByte(buf[idx + 2] * vig + grain);
      }
    }
  };

  return {
    buf,
    fillRect,
    fillRectGradientV,
    fillPoly,
    fillPolyVGrad,
    fillPolyHGrad,
    drawLine,
    strokePoly,
    fillEllipse,
    addRadialGlow,
    applyArchitecturalFinish,
  };
}

/* ---- Reusable architectural furniture & detail components ---- */

function drawWindowWithGreenery(c, quad, { mullionsX = 2, mullionsY = 2, warmSky = false } = {}) {
  const [tl, tr, br, bl] = quad;
  const skyTop = hex(warmSky ? '#DCE5DC' : '#C8DCE0');
  const skyBot = hex(warmSky ? '#F4E4C8' : '#E7F1F2');
  c.fillPolyVGrad(quad, skyTop, skyBot, 1);

  // Soft distant horizon hills
  const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const hLeft = lerpPt(tl, bl, 0.54);
  const hRight = lerpPt(tr, br, 0.50);
  c.fillPolyVGrad([hLeft, hRight, br, bl], hex('#9AB6A8'), hex('#6C9080'), 0.85);

  // Layered lush tree canopy & foliage (#7A9E8E -> #2F5E46)
  const f1L = lerpPt(tl, bl, 0.42);
  const f1M = [
    (tl[0] + tr[0]) * 0.5,
    (tl[1] + tr[1]) * 0.5 + (bl[1] - tl[1]) * 0.34,
  ];
  const f1R = lerpPt(tr, br, 0.46);
  c.fillPolyVGrad([f1L, f1M, f1R, br, bl], hex('#7A9E8E'), hex('#3F6E59'), 0.95);

  // Organic botanical foliage clusters inside window view
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) * 0.25;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) * 0.25;
  const spanX = Math.abs(tr[0] - tl[0]);
  const spanY = Math.abs(bl[1] - tl[1]);
  c.fillEllipse(cx - spanX * 0.18, cy + spanY * 0.10, spanX * 0.26, spanY * 0.20, hex('#4F7C68'), 0.8);
  c.fillEllipse(cx + spanX * 0.15, cy + spanY * 0.16, spanX * 0.28, spanY * 0.18, hex('#2F5E46'), 0.85);
  c.fillEllipse(cx - spanX * 0.04, cy + spanY * 0.25, spanX * 0.22, spanY * 0.14, hex('#84AA96'), 0.55);

  // Architectural window mullions
  const frameCol = hex('#273136');
  for (let i = 1; i <= mullionsX; i += 1) {
    const t = i / (mullionsX + 1);
    const pTop = lerpPt(tl, tr, t);
    const pBot = lerpPt(bl, br, t);
    c.drawLine(pTop[0], pTop[1], pBot[0], pBot[1], 3.2, frameCol, 0.95);
  }
  for (let j = 1; j <= mullionsY; j += 1) {
    const t = j / (mullionsY + 1);
    const pLeft = lerpPt(tl, bl, t);
    const pRight = lerpPt(tr, br, t);
    c.drawLine(pLeft[0], pLeft[1], pRight[0], pRight[1], 2.8, frameCol, 0.92);
  }
  c.strokePoly(quad, 4.2, frameCol, 1, true);
}

function drawPresentationScreen(c, quad, { variant = 0 } = {}) {
  const [tl, tr, br, bl] = quad;
  // Outer bezel
  c.fillPoly(quad, hex('#121A20'), 1);
  c.strokePoly(quad, 2.5, hex('#37464F'), 0.9, true);

  const bilerp = (u, v) => {
    const topX = tl[0] + (tr[0] - tl[0]) * u;
    const topY = tl[1] + (tr[1] - tl[1]) * u;
    const botX = bl[0] + (br[0] - bl[0]) * u;
    const botY = bl[1] + (br[1] - bl[1]) * u;
    return [topX + (botX - topX) * v, topY + (botY - topY) * v];
  };

  const screenQuad = [bilerp(0.04, 0.06), bilerp(0.96, 0.06), bilerp(0.96, 0.94), bilerp(0.04, 0.94)];
  c.fillPolyVGrad(screenQuad, hex('#1C2830'), hex('#152128'), 1);

  // Header accent bar
  c.fillPoly([bilerp(0.08, 0.13), bilerp(0.55, 0.13), bilerp(0.55, 0.21), bilerp(0.08, 0.21)], hex('#2F7A72'), 0.95);
  c.fillPoly([bilerp(0.60, 0.13), bilerp(0.92, 0.13), bilerp(0.92, 0.21), bilerp(0.60, 0.21)], hex('#D9A45B'), 0.85);

  // Chart bars & data cards inside presentation screen
  const barHeights = variant === 0 ? [0.42, 0.62, 0.50, 0.78, 0.68] : [0.55, 0.45, 0.72, 0.64, 0.84];
  const barColors = ['#3B9B90', '#4DB3A6', '#E0A956', '#3B9B90', '#E8B86B'];
  for (let i = 0; i < barHeights.length; i += 1) {
    const u0 = 0.10 + i * 0.10;
    const u1 = u0 + 0.065;
    const vTop = 0.84 - barHeights[i] * 0.52;
    c.fillPoly(
      [bilerp(u0, vTop), bilerp(u1, vTop), bilerp(u1, 0.84), bilerp(u0, 0.84)],
      hex(barColors[i]),
      0.92,
    );
  }

  // Right-side summary card on screen
  c.fillPoly([bilerp(0.63, 0.29), bilerp(0.91, 0.29), bilerp(0.91, 0.84), bilerp(0.63, 0.84)], hex('#243640'), 0.95);
  const p1 = bilerp(0.66, 0.70);
  const p2 = bilerp(0.74, 0.54);
  const p3 = bilerp(0.81, 0.60);
  const p4 = bilerp(0.88, 0.40);
  c.drawLine(p1[0], p1[1], p2[0], p2[1], 2.2, hex('#E8B86B'), 0.95);
  c.drawLine(p2[0], p2[1], p3[0], p3[1], 2.2, hex('#E8B86B'), 0.95);
  c.drawLine(p3[0], p3[1], p4[0], p4[1], 2.2, hex('#E8B86B'), 0.95);
}

function drawGlassWhiteboard(c, quad) {
  const [tl, tr, br, bl] = quad;
  c.fillPolyVGrad(quad, hex('#EFF5F5'), hex('#DDE9E9'), 0.82);
  c.strokePoly(quad, 2.0, hex('#8DA3A6'), 0.85, true);

  const bilerp = (u, v) => {
    const topX = tl[0] + (tr[0] - tl[0]) * u;
    const topY = tl[1] + (tr[1] - tl[1]) * u;
    const botX = bl[0] + (br[0] - bl[0]) * u;
    const botY = bl[1] + (br[1] - bl[1]) * u;
    return [topX + (botX - topX) * v, topY + (botY - topY) * v];
  };

  // Subtle glass reflection diagonal
  c.fillPoly([bilerp(0.15, 0.05), bilerp(0.32, 0.05), bilerp(0.18, 0.95), bilerp(0.04, 0.95)], hex('#FFFFFF'), 0.35);

  // Diagram lines & sticky notes on whiteboard
  const stickyColors = ['#E5B567', '#5BA89E', '#E08A6B'];
  for (let i = 0; i < 3; i += 1) {
    const u0 = 0.14 + i * 0.22;
    const u1 = u0 + 0.15;
    c.fillPoly([bilerp(u0, 0.20), bilerp(u1, 0.20), bilerp(u1, 0.42), bilerp(u0, 0.42)], hex(stickyColors[i]), 0.85);
  }
  const d1 = bilerp(0.16, 0.62);
  const d2 = bilerp(0.52, 0.58);
  const d3 = bilerp(0.84, 0.66);
  c.drawLine(d1[0], d1[1], d2[0], d2[1], 1.8, hex('#2F5E58'), 0.7);
  c.drawLine(d2[0], d2[1], d3[0], d3[1], 1.8, hex('#2F5E58'), 0.7);

  // Marker tray at bottom
  c.drawLine(bl[0] + (br[0] - bl[0]) * 0.2, bl[1] + (br[1] - bl[1]) * 0.2, bl[0] + (br[0] - bl[0]) * 0.8, bl[1] + (br[1] - bl[1]) * 0.8, 3.0, hex('#465459'), 0.9);
}

function drawPlanter(c, cx, baseY, scale = 1) {
  const potW = 26 * scale;
  const potH = 34 * scale;
  const topY = baseY - potH;
  // Terracotta planter pot
  c.fillPolyHGrad(
    [
      [cx - potW, topY],
      [cx + potW, topY],
      [cx + potW * 0.76, baseY],
      [cx - potW * 0.76, baseY],
    ],
    hex('#C4724B'),
    hex('#8E4A2B'),
    1,
  );
  c.fillRect(cx - potW * 1.06, topY - 4 * scale, potW * 2.12, 5 * scale, hex('#B5653F'), 1);

  // Architectural lush foliage (#2F5E46, #3E7559, #578F71)
  const leaves = [
    [-22, -26, 16, 24, '#2F5E46'],
    [0, -38, 18, 28, '#3B7054'],
    [20, -24, 16, 22, '#28523C'],
    [-12, -16, 14, 18, '#528A6C'],
    [13, -15, 14, 18, '#467D60'],
  ];
  for (const [dx, dy, rx, ry, col] of leaves) {
    c.fillEllipse(cx + dx * scale, topY + dy * scale, rx * scale, ry * scale, hex(col), 0.96);
  }
}

function drawChair(c, cx, cy, scale = 1, colorHex = '#2B3D3B', facing = 'front') {
  const w = 22 * scale;
  const h = 24 * scale;
  const seatY = cy + 6 * scale;
  const legCol = hex('#23272A');
  // Slender architectural chair legs
  c.drawLine(cx - w * 0.7, seatY, cx - w * 0.85, seatY + 18 * scale, 2.2 * scale, legCol, 0.9);
  c.drawLine(cx + w * 0.7, seatY, cx + w * 0.85, seatY + 18 * scale, 2.2 * scale, legCol, 0.9);
  // Upholstered shell
  const shellTop = hex(colorHex);
  const shellBot = mixRgb(shellTop, [15, 20, 22], 0.35);
  c.fillPolyVGrad(
    [
      [cx - w * 0.82, cy - h],
      [cx + w * 0.82, cy - h],
      [cx + w, seatY],
      [cx - w, seatY],
    ],
    shellTop,
    shellBot,
    0.98,
  );
  if (facing === 'back') {
    c.drawLine(cx - w * 0.65, cy - h * 0.55, cx + w * 0.65, cy - h * 0.55, 1.8 * scale, hex('#586B69'), 0.5);
  }
}

/* ---- Scene 1: Meeting & Training Rooms (TRC-MR-01 Baobab & TRC-MR-02 Acacia) ---- */

function renderMeetingRoomScene(c, width, height, spaceCode, variant) {
  const isTraining = spaceCode === 'TRC-MR-02';
  const warmAfternoon = variant === 1;

  // 1. Perspective room geometry
  const vxL = warmAfternoon ? 150 : 195;
  const vxR = warmAfternoon ? 610 : 635;
  const vyTop = 98;
  const vyBot = 336;

  // Ceiling (#F2ECE1 -> #E6DEC8)
  c.fillPolyVGrad(
    [[0, 0], [width, 0], [vxR, vyTop], [vxL, vyTop]],
    hex(warmAfternoon ? '#EFE6D5' : '#F6F1E7'),
    hex('#E5DCCB'),
    1,
  );

  // Recessed ceiling coffer
  const cofferPts = isTraining
    ? [[90, 12], [710, 12], [vxR - 25, vyTop - 12], [vxL + 25, vyTop - 12]]
    : [[135, 16], [665, 16], [vxR - 38, vyTop - 14], [vxL + 38, vyTop - 14]];
  c.fillPolyVGrad(cofferPts, hex('#DDD3C0'), hex('#EAE2D3'), 1);
  c.strokePoly(cofferPts, 1.8, hex('#C5B9A5'), 0.85, true);

  // Left wall, Back wall, Right wall in soft architectural plaster (#F2ECE1 / #E6DEC8)
  c.fillPolyHGrad(
    [[0, 0], [vxL, vyTop], [vxL, vyBot], [0, 436]],
    hex(warmAfternoon ? '#EADBC5' : '#E6DEC8'),
    hex(warmAfternoon ? '#DFCFB6' : '#DDD3BE'),
    1,
  );
  c.fillPolyVGrad(
    [[vxL, vyTop], [vxR, vyTop], [vxR, vyBot], [vxL, vyBot]],
    hex(warmAfternoon ? '#F4E9D8' : '#F2ECE1'),
    hex(warmAfternoon ? '#E8DAC4' : '#E6DEC8'),
    1,
  );
  c.fillPolyHGrad(
    [[vxR, vyTop], [width, 0], [width, 438], [vxR, vyBot]],
    hex('#E2D8C3'),
    hex(warmAfternoon ? '#D6C6AE' : '#D5CBB6'),
    1,
  );

  // Warm engineered oak floor with subtle perspective plank lines
  c.fillPolyVGrad(
    [[0, 436], [vxL, vyBot], [vxR, vyBot], [width, 438], [width, height], [0, height]],
    hex(warmAfternoon ? '#C9A47B' : '#C6A884'),
    hex(warmAfternoon ? '#9C754E' : '#9E7D58'),
    1,
  );
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10;
    const xTop = vxL + (vxR - vxL) * t;
    const xBot = -120 + (width + 240) * t;
    c.drawLine(xTop, vyBot, xBot, height, 1.1, hex('#7D5E3F'), 0.25);
  }

  // Structural corner lines & baseboard trim
  c.drawLine(vxL, vyTop, vxL, vyBot, 2.0, hex('#C9BFA9'), 0.8);
  c.drawLine(vxR, vyTop, vxR, vyBot, 2.0, hex('#C9BFA9'), 0.8);
  c.drawLine(0, 436, vxL, vyBot, 3.5, hex('#B5A68F'), 0.9);
  c.drawLine(vxL, vyBot, vxR, vyBot, 3.0, hex('#B5A68F'), 0.9);
  c.drawLine(vxR, vyBot, width, 438, 3.5, hex('#B5A68F'), 0.9);

  // 2. Floor-to-ceiling mullioned window on the left wall + optional clerestory/back window
  const winQuad = [
    [18, 36],
    [vxL - 16, vyTop + 14],
    [vxL - 16, vyBot - 16],
    [18, 398],
  ];
  drawWindowWithGreenery(c, winQuad, { mullionsX: isTraining ? 3 : 2, mullionsY: 2, warmSky: warmAfternoon });

  if (warmAfternoon) {
    // Secondary window bay on back-left for Variant 1
    drawWindowWithGreenery(
      c,
      [[vxL + 16, vyTop + 18], [vxL + 135, vyTop + 18], [vxL + 135, vyBot - 22], [vxL + 16, vyBot - 22]],
      { mullionsX: 1, mullionsY: 2, warmSky: true },
    );
  } else {
    // Architectural timber/fabric acoustic panels on back wall
    for (let i = 0; i < 4; i += 1) {
      const px = vxL + 26 + i * 26;
      c.fillRect(px, vyTop + 28, 18, 152, hex('#D6C8B2'), 0.85);
      c.drawLine(px, vyTop + 28, px, vyTop + 180, 1.2, hex('#B5A38A'), 0.7);
    }
  }

  // 3. Wall-mounted presentation display (#1C2830) & glass whiteboard
  if (!isTraining) {
    const screenX = warmAfternoon ? vxL + 165 : vxL + 142;
    const screenW = warmAfternoon ? 185 : 175;
    drawPresentationScreen(
      c,
      [[screenX, vyTop + 36], [screenX + screenW, vyTop + 36], [screenX + screenW, vyTop + 146], [screenX, vyTop + 146]],
      { variant },
    );
    // Credenza below screen
    c.fillRect(screenX - 18, vyBot - 48, screenW + 36, 42, hex('#6B4A32'), 0.96);
    c.fillRect(screenX - 18, vyBot - 52, screenW + 36, 5, hex('#8C6548'), 0.96);

    // Glass whiteboard on right wall
    drawGlassWhiteboard(c, [
      [vxR + 24, vyTop + 28],
      [width - 28, 76],
      [width - 28, 305],
      [vxR + 24, vyBot - 46],
    ]);
  } else {
    // Acacia Training Room: dual/wide 86" presentation wall + presenter lectern + right wall whiteboard
    const s1X = vxL + 120;
    drawPresentationScreen(
      c,
      [[s1X, vyTop + 28], [s1X + 210, vyTop + 28], [s1X + 210, vyTop + 144], [s1X, vyTop + 144]],
      { variant },
    );
    // Presenter lectern at front left
    c.fillPolyVGrad(
      [[vxL + 42, vyBot - 78], [vxL + 92, vyBot - 84], [vxL + 88, vyBot - 8], [vxL + 46, vyBot - 8]],
      hex('#6E4930'),
      hex('#472E1D'),
      0.98,
    );
    drawGlassWhiteboard(c, [
      [vxR + 20, vyTop + 26],
      [width - 24, 72],
      [width - 24, 298],
      [vxR + 20, vyBot - 48],
    ]);
  }

  // 4. Soft diagonal daylight shafts from the window across the room
  const beamColor = hex(warmAfternoon ? '#FFE8BE' : '#FFFDF5');
  c.fillPoly(
    [[18, 140], [vxL - 16, 175], [640, 445], [210, 488]],
    beamColor,
    warmAfternoon ? 0.22 : 0.16,
  );
  c.fillPoly(
    [[18, 250], [vxL - 16, 260], [520, 495], [90, 500]],
    beamColor,
    warmAfternoon ? 0.18 : 0.12,
  );

  // 5. Recessed linear pendant luminaire & warm ceiling glow
  const lampCx = (vxL + vxR) * 0.5;
  c.addRadialGlow(lampCx, 96, 220, 58, hex('#FFE29A'), warmAfternoon ? 0.42 : 0.32);
  if (!isTraining) {
    c.drawLine(lampCx - 95, 32, lampCx - 95, 92, 1.6, hex('#4A453E'), 0.85);
    c.drawLine(lampCx + 95, 32, lampCx + 95, 92, 1.6, hex('#4A453E'), 0.85);
    c.fillRect(lampCx - 130, 90, 260, 8, hex('#2B3135'), 0.96);
    c.fillRect(lampCx - 124, 96, 248, 4, hex('#FFF1C9'), 0.98);
  } else {
    // Dual training room linear pendants
    for (const offset of [-115, 115]) {
      const lx = lampCx + offset;
      c.drawLine(lx - 55, 28, lx - 55, 84, 1.5, hex('#4A453E'), 0.8);
      c.drawLine(lx + 55, 28, lx + 55, 84, 1.5, hex('#4A453E'), 0.8);
      c.fillRect(lx - 78, 82, 156, 7, hex('#2B3135'), 0.95);
      c.fillRect(lx - 72, 88, 144, 3, hex('#FFF1C9'), 0.98);
    }
  }

  // Indoor architectural planter in background corner
  drawPlanter(c, vxR - 36, vyBot - 4, 0.85);

  // 6. Tables & architectural chairs
  if (!isTraining) {
    // Baobab 12-seat conference table in perspective (#5C3D28 / #7A5236)
    const tTopL = warmAfternoon ? 255 : 275;
    const tTopR = warmAfternoon ? 525 : 545;
    const tBotL = warmAfternoon ? 135 : 170;
    const tBotR = warmAfternoon ? 645 : 665;
    const tY0 = 296;
    const tY1 = 418;

    // Far-side & head chairs
    drawChair(c, (tTopL + tTopR) * 0.5, tY0 - 12, 0.78, '#263C39', 'front');
    for (let i = 0; i < 4; i += 1) {
      const t = (i + 0.5) / 4;
      const y = tY0 + (tY1 - tY0) * t * 0.82;
      const xL = tTopL + (tBotL - tTopL) * t - 26;
      const xR = tTopR + (tBotR - tTopR) * t + 26;
      const sc = 0.78 + t * 0.28;
      drawChair(c, xL, y - 6, sc, '#2B423F', 'front');
      drawChair(c, xR, y - 6, sc, '#2B423F', 'front');
    }

    // Floor shadow under table
    c.fillPoly(
      [[tTopL - 8, tY0 + 36], [tTopR + 8, tY0 + 36], [tBotR + 18, height], [tBotL - 18, height]],
      hex('#3A281A'),
      0.34,
    );

    // Table legs
    c.drawLine(tBotL + 55, tY1 + 10, tBotL + 42, 488, 8, hex('#2D1F14'), 0.95);
    c.drawLine(tBotR - 55, tY1 + 10, tBotR - 42, 488, 8, hex('#2D1F14'), 0.95);

    // Walnut tabletop
    const tableQuad = [[tTopL, tY0], [tTopR, tY0], [tBotR, tY1], [tBotL, tY1]];
    c.fillPolyVGrad(tableQuad, hex('#7A5236'), hex('#5C3D28'), 1);
    // Sunlit bevel highlight on left side of table
    c.fillPoly(
      [[tTopL + 10, tY0 + 4], [tTopL + 115, tY0 + 4], [tBotL + 165, tY1 - 6], [tBotL + 14, tY1 - 6]],
      hex('#9B6E4C'),
      0.28,
    );
    // Table edge apron
    c.fillPoly(
      [[tBotL, tY1], [tBotR, tY1], [tBotR, tY1 + 14], [tBotL, tY1 + 14]],
      hex('#3E2718'),
      1,
    );

    // Central brushed-bronze AV / power trough & notebooks/laptops
    const midTop = (tTopL + tTopR) * 0.5;
    const midBot = (tBotL + tBotR) * 0.5;
    c.fillPoly(
      [[midTop - 16, tY0 + 22], [midTop + 16, tY0 + 22], [midBot + 26, tY1 - 24], [midBot - 26, tY1 - 24]],
      hex('#2C221B'),
      0.88,
    );
    // Open laptop & folio on table
    c.fillPoly(
      [[midBot - 140, 368], [midBot - 88, 368], [midBot - 82, 388], [midBot - 146, 388]],
      hex('#D8DEE2'),
      0.92,
    );
    c.fillPoly(
      [[midBot + 78, 352], [midBot + 126, 352], [midBot + 132, 370], [midBot + 72, 370]],
      hex('#E8DFD1'),
      0.9,
    );

    // Foreground chairs (seen from back)
    drawChair(c, midBot - 115, tY1 + 36, 1.12, '#203330', 'back');
    drawChair(c, midBot + 115, tY1 + 36, 1.12, '#203330', 'back');
  } else {
    // Acacia 30-seat Training Room: 3 tiered classroom rows of left & right training tables
    const rows = [
      { y0: 294, y1: 318, spreadTop: 205, spreadBot: 235, scale: 0.72 },
      { y0: 340, y1: 372, spreadTop: 248, spreadBot: 290, scale: 0.88 },
      { y0: 400, y1: 442, spreadTop: 302, spreadBot: 356, scale: 1.06 },
    ];
    const center = width * 0.5 + (warmAfternoon ? -18 : 10);

    for (const row of rows) {
      for (const side of [-1, 1]) {
        const innerTop = center + side * 24;
        const outerTop = center + side * row.spreadTop;
        const innerBot = center + side * 28;
        const outerBot = center + side * row.spreadBot;
        const xTL = Math.min(innerTop, outerTop);
        const xTR = Math.max(innerTop, outerTop);
        const xBL = Math.min(innerBot, outerBot);
        const xBR = Math.max(innerBot, outerBot);

        // 3 chairs per desk bank
        for (let ch = 0; ch < 3; ch += 1) {
          const u = (ch + 0.5) / 3;
          const cx = xBL + (xBR - xBL) * u;
          drawChair(c, cx, row.y1 + 8 * row.scale, row.scale * 0.85, '#263D3A', 'back');
        }

        // Desk top (#7A5236 -> #5C3D28) & modesty panel
        c.fillPolyVGrad(
          [[xTL, row.y0], [xTR, row.y0], [xBR, row.y1], [xBL, row.y1]],
          hex('#7A5236'),
          hex('#5C3D28'),
          1,
        );
        c.fillRect(xBL, row.y1, xBR - xBL, 8 * row.scale, hex('#3F2819'), 0.96);

        // Workbooks / laptops on desks
        for (let ch = 0; ch < 3; ch += 1) {
          const u = (ch + 0.5) / 3;
          const lx = xTL + (xTR - xTL) * u;
          const ly = (row.y0 + row.y1) * 0.5;
          c.fillRect(lx - 10 * row.scale, ly - 4 * row.scale, 20 * row.scale, 8 * row.scale, hex('#E8E2D5'), 0.88);
        }
      }
    }
  }
}

/* ---- Scene 2: Grand Auditorium (TRC-AUD-01) ---- */

function renderAuditoriumScene(c, width, height, variant) {
  const angled = variant === 1;
  const sL = angled ? 210 : 175;
  const sR = angled ? 700 : 625;
  const sTop = 92;
  const sBot = 286;

  // 1. Dark theatre ceiling (#13191E -> #1D262E) with acoustic cloud baffles
  c.fillPolyVGrad(
    [[0, 0], [width, 0], [sR, sTop], [sL, sTop]],
    hex('#11171C'),
    hex('#1E2730'),
    1,
  );
  for (let b = 1; b <= 4; b += 1) {
    const t = b / 5;
    const y = sTop * t;
    const x0 = sL * t;
    const x1 = width - (width - sR) * t;
    c.drawLine(x0, y, x1, y, 4.5 * (1 - t * 0.4), hex('#2A3540'), 0.85);
  }

  // 2. Acoustic timber slat side walls (#3A261B base with #8C5832 / #B07345 vertical ribs)
  const leftWall = [[0, 0], [sL, sTop], [sL, sBot + 24], [0, 412]];
  const rightWall = [[sR, sTop], [width, 0], [width, 412], [sR, sBot + 24]];
  c.fillPolyHGrad(leftWall, hex('#3A261B'), hex('#593824'), 1);
  c.fillPolyHGrad(rightWall, hex('#593824'), hex('#3A261B'), 1);

  // Rhythmic vertical timber slats along left and right walls
  const slatCount = 16;
  for (let i = 1; i < slatCount; i += 1) {
    const t = i / slatCount;
    // Left wall rib
    const lx = sL * t;
    const lyTop = sTop * t;
    const lyBot = 412 + (sBot + 24 - 412) * t;
    const ribCol = i % 3 === 0 ? hex('#AD7142') : hex('#8C5832');
    c.drawLine(lx, lyTop, lx, lyBot, 3.2 * (1 - t * 0.35), ribCol, 0.92);

    // Right wall rib
    const rx = width - (width - sR) * t;
    const ryTop = sTop * t;
    const ryBot = 412 + (sBot + 24 - 412) * t;
    c.drawLine(rx, ryTop, rx, ryBot, 3.2 * (1 - t * 0.35), ribCol, 0.92);
  }

  // Warm architectural wall-washer grazing glow on timber slats
  c.addRadialGlow(sL * 0.55, 220, 95, 130, hex('#F2A84B'), 0.22);
  c.addRadialGlow(width - (width - sR) * 0.55, 220, 95, 130, hex('#F2A84B'), 0.22);

  // 3. Stage back wall & wide projection backdrop (#1A3640)
  c.fillPolyVGrad(
    [[sL, sTop], [sR, sTop], [sR, sBot], [sL, sBot]],
    hex('#231A15'),
    hex('#36251B'),
    1,
  );

  const scrL = sL + 36;
  const scrR = sR - 36;
  const scrTop = sTop + 20;
  const scrBot = sBot - 32;
  c.fillPolyVGrad(
    [[scrL, scrTop], [scrR, scrTop], [scrR, scrBot], [scrL, scrBot]],
    hex('#1A3640'),
    hex('#10232A'),
    1,
  );
  c.strokePoly([[scrL, scrTop], [scrR, scrTop], [scrR, scrBot], [scrL, scrBot]], 2.5, hex('#4A6E78'), 0.85, true);

  // Geometric stage keynote graphics on projection backdrop
  const scrMidX = (scrL + scrR) * 0.5;
  const scrMidY = (scrTop + scrBot) * 0.5;
  c.fillPoly(
    [[scrL + 28, scrBot - 18], [scrMidX - 10, scrTop + 24], [scrMidX + 55, scrBot - 18]],
    hex('#2A5C66'),
    0.55,
  );
  c.fillPoly(
    [[scrMidX - 30, scrBot - 18], [scrMidX + 45, scrTop + 34], [scrR - 34, scrBot - 18]],
    hex('#D99B4E'),
    0.38,
  );
  c.fillEllipse(scrMidX, scrMidY - 4, 42, 42, hex('#E8B668'), 0.25);
  c.drawLine(scrL + 48, scrMidY + 26, scrR - 48, scrMidY + 26, 2.0, hex('#7CC2BA'), 0.7);
  c.drawLine(scrMidX - 85, scrMidY - 12, scrMidX + 85, scrMidY - 12, 3.0, hex('#F3ECE0'), 0.85);

  // 4. Illuminated wide stage platform (#C89B6E) & presenter lectern
  const stgFrontL = angled ? 115 : 110;
  const stgFrontR = angled ? 745 : 690;
  const stgFrontY = 324;
  c.fillPolyVGrad(
    [[sL, sBot - 8], [sR, sBot - 8], [stgFrontR, stgFrontY], [stgFrontL, stgFrontY]],
    hex('#D8AE82'),
    hex('#B68556'),
    1,
  );
  // Stage front riser & warm footlight strip
  c.fillPoly(
    [[stgFrontL, stgFrontY], [stgFrontR, stgFrontY], [stgFrontR, stgFrontY + 22], [stgFrontL, stgFrontY + 22]],
    hex('#4A2E1B'),
    1,
  );
  c.drawLine(stgFrontL + 8, stgFrontY + 1, stgFrontR - 8, stgFrontY + 1, 2.8, hex('#FFE29C'), 0.92);

  // Presenter lectern on stage right
  const lecX = angled ? scrL + 95 : scrR - 75;
  const lecY = stgFrontY - 10;
  c.fillPolyVGrad(
    [[lecX - 18, lecY - 52], [lecX + 18, lecY - 56], [lecX + 14, lecY], [lecX - 14, lecY]],
    hex('#6E472C'),
    hex('#3E2515'),
    0.98,
  );
  c.drawLine(lecX - 18, lecY - 53, lecX + 18, lecY - 57, 3.0, hex('#E8B86B'), 0.9);

  // 5. Overhead stage spotlights & translucent light cones
  const spotCount = 5;
  for (let i = 0; i < spotCount; i += 1) {
    const u = (i + 0.5) / spotCount;
    const topX = sL + (sR - sL) * u;
    const topY = sTop - 8;
    const botX = stgFrontL + 40 + (stgFrontR - stgFrontL - 80) * u;
    const cone = [
      [topX - 8, topY],
      [topX + 8, topY],
      [botX + 58, stgFrontY - 2],
      [botX - 58, stgFrontY - 2],
    ];
    c.fillPolyVGrad(cone, hex('#FFF0C2'), hex('#E8A84E'), 0.14);
    c.fillEllipse(topX, topY, 7, 3.5, hex('#FFF6D6'), 0.98);
    c.addRadialGlow(botX, stgFrontY - 10, 62, 16, hex('#FFE3A0'), 0.25);
  }

  // 6. Tiered rows of upholstered auditorium seating in foreground
  c.fillRectGradientV(0, stgFrontY + 22, width, height - (stgFrontY + 22), hex('#1B1614'), hex('#0F0D0C'), 1);

  const tierRows = [
    { y: 356, h: 24, count: 14, radius: 12 },
    { y: 386, h: 28, count: 12, radius: 14 },
    { y: 422, h: 34, count: 10, radius: 17 },
    { y: 466, h: 40, count: 8, radius: 20 },
  ];

  const aisle1Top = sL + (sR - sL) * 0.28;
  const aisle1Bot = width * 0.22;
  const aisle2Top = sL + (sR - sL) * 0.72;
  const aisle2Bot = width * 0.78;

  for (let rIdx = 0; rIdx < tierRows.length; rIdx += 1) {
    const row = tierRows[rIdx];
    const rt = rIdx / (tierRows.length - 1);
    const a1 = aisle1Top + (aisle1Bot - aisle1Top) * rt;
    const a2 = aisle2Top + (aisle2Bot - aisle2Top) * rt;

    // Warm aisle step indicator lights
    c.fillEllipse(a1, row.y + row.h * 0.6, 8, 3, hex('#F5B95A'), 0.85);
    c.fillEllipse(a2, row.y + row.h * 0.6, 8, 3, hex('#F5B95A'), 0.85);

    for (let s = 0; s < row.count; s += 1) {
      const u = (s + 0.5) / row.count;
      const sx = 24 + (width - 48) * u;
      if (Math.abs(sx - a1) < 24 || Math.abs(sx - a2) < 24) continue;
      const seatW = ((width - 80) / row.count) * 0.42;
      const seatTop = mixRgb(hex('#2F474E'), hex('#1F3036'), rt * 0.45);
      const seatBot = hex('#152126');
      c.fillPolyVGrad(
        [
          [sx - seatW * 0.86, row.y],
          [sx + seatW * 0.86, row.y],
          [sx + seatW, row.y + row.h],
          [sx - seatW, row.y + row.h],
        ],
        seatTop,
        seatBot,
        0.98,
      );
      // Warm timber top rail on auditorium seat back
      c.drawLine(sx - seatW * 0.82, row.y + 1, sx + seatW * 0.82, row.y + 1, 2.2, hex('#8C5A36'), 0.85);
    }
  }
}

/* ---- Scene 3: Co-working Floor & Quiet Pods (TRC-CW-01 & TRC-CW-02) ---- */

function drawMonitorOnDesk(c, cx, baseY, scale = 1, dual = true) {
  const offsets = dual ? [-26 * scale, 26 * scale] : [0];
  for (const dx of offsets) {
    const mx = cx + dx;
    const mw = 46 * scale;
    const mh = 28 * scale;
    const my = baseY - mh - 8 * scale;
    // Stand
    c.fillRect(mx - 3 * scale, baseY - 8 * scale, 6 * scale, 8 * scale, hex('#2B3338'), 1);
    c.fillRect(mx - 10 * scale, baseY - 2 * scale, 20 * scale, 3 * scale, hex('#2B3338'), 1);
    // Screen (#1E2933)
    c.fillRect(mx - mw * 0.5, my, mw, mh, hex('#1E2933'), 1);
    c.strokePoly(
      [[mx - mw * 0.5, my], [mx + mw * 0.5, my], [mx + mw * 0.5, my + mh], [mx - mw * 0.5, my + mh]],
      1.5 * scale,
      hex('#0F151A'),
      1,
      true,
    );
    // Subtle UI bars on monitor
    c.fillRect(mx - mw * 0.4, my + 4 * scale, mw * 0.35, 3 * scale, hex('#3C948B'), 0.85);
    c.fillRect(mx - mw * 0.4, my + 10 * scale, mw * 0.72, 2.5 * scale, hex('#7B909A'), 0.65);
    c.fillRect(mx - mw * 0.4, my + 15 * scale, mw * 0.55, 2.5 * scale, hex('#D9A257'), 0.7);
  }
}

function drawDomeLamp(c, cx, cableTopY, lampY, scale = 1) {
  c.addRadialGlow(cx, lampY + 22 * scale, 95 * scale, 48 * scale, hex('#FFE094'), 0.35);
  c.drawLine(cx, cableTopY, cx, lampY - 14 * scale, 1.6, hex('#22282B'), 0.9);
  // Dome shade
  c.fillPolyVGrad(
    [
      [cx - 10 * scale, lampY - 14 * scale],
      [cx + 10 * scale, lampY - 14 * scale],
      [cx + 32 * scale, lampY + 4 * scale],
      [cx - 32 * scale, lampY + 4 * scale],
    ],
    hex('#2A3439'),
    hex('#1A2125'),
    0.98,
  );
  // Warm brass/gold inner rim glow
  c.fillEllipse(cx, lampY + 4 * scale, 30 * scale, 5.5 * scale, hex('#F5C16C'), 0.95);
}

function renderCoworkingScene(c, width, height, spaceCode, variant) {
  const isPods = spaceCode === 'TRC-CW-02';
  const vxL = variant === 0 ? 175 : 145;
  const vxR = variant === 0 ? 635 : 615;
  const vyTop = 94;
  const vyBot = 332;

  // 1. Exposed architectural concrete ceiling (#D8D3CB) & warm birch/plaster interior (#EAE4DC)
  c.fillPolyVGrad(
    [[0, 0], [width, 0], [vxR, vyTop], [vxL, vyTop]],
    hex('#CFCAC2'),
    hex('#DED9D1'),
    1,
  );
  // Exposed concrete ceiling beams
  for (let b = 1; b <= 3; b += 1) {
    const t = b / 4;
    const y = vyTop * t;
    c.drawLine(vxL * t, y, width - (width - vxR) * t, y, 5 * (1 - t * 0.3), hex('#B8B2A8'), 0.85);
  }

  // Walls (#EAE4DC)
  c.fillPolyHGrad([[0, 0], [vxL, vyTop], [vxL, vyBot], [0, 434]], hex('#EAE4DC'), hex('#DDD5C8'), 1);
  c.fillPolyVGrad([[vxL, vyTop], [vxR, vyTop], [vxR, vyBot], [vxL, vyBot]], hex('#EFEAE2'), hex('#E2DBD0'), 1);
  c.fillPolyHGrad([[vxR, vyTop], [width, 0], [width, 434], [vxR, vyBot]], hex('#E0D8CA'), hex('#D4CABB'), 1);

  if (!isPods) {
    // Co-working Floor (TRC-CW-01): warm polished concrete + oak studio floor
    c.fillPolyVGrad(
      [[0, 434], [vxL, vyBot], [vxR, vyBot], [width, 434], [width, height], [0, height]],
      hex('#C9B69C'),
      hex('#A38D72'),
      1,
    );

    // Left studio window with greenery
    drawWindowWithGreenery(
      c,
      [[18, 38], [vxL - 16, vyTop + 14], [vxL - 16, vyBot - 18], [18, 392]],
      { mullionsX: 2, mullionsY: 3, warmSky: variant === 1 },
    );

    // Back wall industrial-chic black-framed Crittall glass partition
    const partQuad = [[vxL + 22, vyTop + 18], [vxR - 22, vyTop + 18], [vxR - 22, vyBot - 8], [vxL + 22, vyBot - 8]];
    c.fillPolyVGrad(partQuad, hex('#D6E3E5'), hex('#C2D3D6'), 0.75);
    const cols = 5;
    for (let i = 0; i <= cols; i += 1) {
      const gx = vxL + 22 + ((vxR - vxL - 44) * i) / cols;
      c.drawLine(gx, vyTop + 18, gx, vyBot - 8, 2.8, hex('#1E2428'), 0.92);
    }
    c.drawLine(vxL + 22, vyTop + 92, vxR - 22, vyTop + 92, 2.6, hex('#1E2428'), 0.92);
    c.drawLine(vxL + 22, vyTop + 168, vxR - 22, vyTop + 168, 2.6, hex('#1E2428'), 0.92);
    c.strokePoly(partQuad, 3.6, hex('#1E2428'), 0.96, true);

    // Right wall warm birch bookshelf unit with curated books & objects
    const shQuad = [[vxR + 22, vyTop + 26], [width - 24, 66], [width - 24, 356], [vxR + 22, vyBot - 16]];
    c.fillPolyVGrad(shQuad, hex('#C89F70'), hex('#9E764B'), 0.96);
    const bookPalette = ['#2B5B54', '#C87D4B', '#D9A85B', '#394B54', '#E6DEC8'];
    for (let s = 1; s <= 4; s += 1) {
      const t = s / 5;
      const yL = (vyTop + 26) + (vyBot - 42 - vyTop) * t;
      const yR = 66 + (356 - 66) * t;
      // Books resting on shelf s
      for (let bk = 0; bk < 4; bk += 1) {
        const u0 = 0.12 + bk * 0.18;
        const u1 = u0 + 0.11;
        const bx0 = (vxR + 22) + (width - 24 - (vxR + 22)) * u0;
        const bx1 = (vxR + 22) + (width - 24 - (vxR + 22)) * u1;
        const by0 = yL + (yR - yL) * u0;
        const by1 = yL + (yR - yL) * u1;
        const bh = 16 + ((s + bk) % 3) * 5;
        c.fillPoly(
          [[bx0, by0 - bh], [bx1, by1 - bh], [bx1, by1 - 2], [bx0, by0 - 2]],
          hex(bookPalette[(s + bk) % bookPalette.length]),
          0.92,
        );
      }
      c.drawLine(vxR + 22, yL, width - 24, yR, 3.2, hex('#6B4A2B'), 0.9);
    }
    c.strokePoly(shQuad, 3.0, hex('#6B4A2B'), 0.92, true);

    // Daylight beam from studio windows
    c.fillPoly([[18, 165], [vxL - 16, 195], [610, 445], [160, 495]], hex('#FFFDF4'), 0.16);

    // Hanging dome lamps
    drawDomeLamp(c, 315, 22, 118, 0.95);
    drawDomeLamp(c, 495, 22, 118, 0.95);

    // Background & foreground planters (#2F5E46 in terracotta pots)
    drawPlanter(c, vxL + 34, vyBot - 2, 0.86);
    drawPlanter(c, vxR - 28, vyBot - 2, 0.86);

    // Long shared oak workbench island in perspective with dual monitors (#1E2933)
    const wbTopL = variant === 0 ? 235 : 210;
    const wbTopR = variant === 0 ? 565 : 540;
    const wbBotL = variant === 0 ? 120 : 105;
    const wbBotR = variant === 0 ? 680 : 665;
    const wbY0 = 294;
    const wbY1 = 416;

    // Far-side ergonomic task chairs
    drawChair(c, wbTopL + 75, wbY0 - 8, 0.82, '#242F36', 'front');
    drawChair(c, (wbTopL + wbTopR) * 0.5, wbY0 - 8, 0.82, '#242F36', 'front');
    drawChair(c, wbTopR - 75, wbY0 - 8, 0.82, '#242F36', 'front');

    // Black steel A-frame workbench legs
    c.drawLine(wbBotL + 42, wbY1 + 10, wbBotL + 24, 492, 7, hex('#1E2428'), 0.96);
    c.drawLine(wbBotR - 42, wbY1 + 10, wbBotR - 24, 492, 7, hex('#1E2428'), 0.96);

    // Oak workbench surface (#8C6239 -> #6B4726)
    c.fillPolyVGrad(
      [[wbTopL, wbY0], [wbTopR, wbY0], [wbBotR, wbY1], [wbBotL, wbY1]],
      hex('#9C6F44'),
      hex('#744E2B'),
      1,
    );
    c.fillRect(wbBotL, wbY1, wbBotR - wbBotL, 12, hex('#4F331A'), 1);

    // Center acoustic privacy divider & dual monitors along workbench
    const midY = (wbY0 + wbY1) * 0.48;
    c.fillRect(wbTopL + 15, midY - 14, wbTopR - wbTopL - 30, 14, hex('#4F5D63'), 0.9);
    drawMonitorOnDesk(c, wbTopL + 78, midY + 4, 0.82, true);
    drawMonitorOnDesk(c, (wbTopL + wbTopR) * 0.5, midY + 4, 0.82, true);
    drawMonitorOnDesk(c, wbTopR - 78, midY + 4, 0.82, true);

    // Foreground task chairs & architectural planter
    drawChair(c, wbBotL + 135, wbY1 + 32, 1.08, '#1F292E', 'back');
    drawChair(c, (wbBotL + wbBotR) * 0.5, wbY1 + 34, 1.1, '#1F292E', 'back');
    drawChair(c, wbBotR - 135, wbY1 + 32, 1.08, '#1F292E', 'back');
    drawPlanter(c, 68, 486, 1.18);
  } else {
    // Quiet Pods — Focus Desks (TRC-CW-02): acoustic timber-lined focus booths with glass doors & warm desk lamp glow
    c.fillPolyVGrad(
      [[0, 434], [vxL, vyBot], [vxR, vyBot], [width, 434], [width, height], [0, height]],
      hex('#5A6266'),
      hex('#3E4548'),
      1,
    );

    // Left library shelving & acoustic wall paneling with book spines
    const libQuad = [[22, 58], [vxL - 18, vyTop + 20], [vxL - 18, vyBot - 14], [22, 396]];
    c.fillPolyVGrad(libQuad, hex('#B8895A'), hex('#875F39'), 0.95);
    const libBooks = ['#264E48', '#D49B54', '#B55D3D', '#E6DEC8', '#334650'];
    for (let s = 1; s <= 4; s += 1) {
      const t = s / 5;
      const y0 = 58 + 338 * t;
      const y1 = (vyTop + 20) + (vyBot - 34 - vyTop) * t;
      for (let bk = 0; bk < 4; bk += 1) {
        const u0 = 0.14 + bk * 0.18;
        const u1 = u0 + 0.10;
        const bx0 = 22 + (vxL - 40) * u0;
        const bx1 = 22 + (vxL - 40) * u1;
        const by0 = y0 + (y1 - y0) * u0;
        const by1 = y0 + (y1 - y0) * u1;
        const bh = 15 + ((s + bk) % 3) * 4;
        c.fillPoly(
          [[bx0, by0 - bh], [bx1, by1 - bh], [bx1, by1 - 2], [bx0, by0 - 2]],
          hex(libBooks[(s + bk) % libBooks.length]),
          0.9,
        );
      }
      c.drawLine(22, y0, vxL - 18, y1, 3.0, hex('#54381F'), 0.9);
    }
    c.strokePoly(libQuad, 3.0, hex('#4A321C'), 0.92, true);

    // Row of 3 Acoustic Timber-Lined Focus Pods with black-framed glass doors
    const podCount = variant === 0 ? 3 : 2;
    const podAreaL = vxL + 10;
    const podAreaR = vxR - 10;
    const podSpan = (podAreaR - podAreaL) / podCount;

    for (let p = 0; p < podCount; p += 1) {
      const pL = podAreaL + p * podSpan + 8;
      const pR = podAreaL + (p + 1) * podSpan - 8;
      const pTop = vyTop + 10;
      const pBot = vyBot + 16;
      const pMidX = (pL + pR) * 0.5;

      // Pod interior acoustic timber lining (#C48E5A / #8C5C32)
      c.fillRectGradientV(pL, pTop, pR - pL, pBot - pTop, hex('#C8935E'), hex('#8E5D33'), 1);
      for (let sl = pL + 8; sl < pR - 6; sl += 9) {
        c.drawLine(sl, pTop + 4, sl, pBot - 4, 1.4, hex('#6B4220'), 0.55);
      }

      // Warm interior desk lamp & ceiling glow inside focus pod
      c.addRadialGlow(pMidX, pTop + 34, (pR - pL) * 0.48, 45, hex('#FFE299'), 0.55);
      c.addRadialGlow(pMidX + 22, pTop + 125, 48, 38, hex('#FFD478'), 0.65);

      // Standing focus desk (#5C3D28) + ultra-wide monitor (#1E2933) + warm desk lamp inside pod
      const deskY = pBot - 78;
      c.fillRect(pL + 14, deskY, pR - pL - 28, 9, hex('#5C3D28'), 1);
      c.drawLine(pL + 22, deskY + 9, pL + 22, pBot - 6, 3.0, hex('#23292D'), 0.95);
      c.drawLine(pR - 22, deskY + 9, pR - 22, pBot - 6, 3.0, hex('#23292D'), 0.95);
      drawMonitorOnDesk(c, pMidX + 4, deskY, 0.85, false);

      // Warm brass task lamp on focus desk
      c.drawLine(pMidX + 34, deskY, pMidX + 40, deskY - 24, 2.2, hex('#D9A253'), 0.95);
      c.fillEllipse(pMidX + 32, deskY - 24, 9, 4.5, hex('#FFE6A3'), 0.98);

      // Ergonomic focus chair inside booth
      drawChair(c, pMidX + 4, deskY + 26, 0.88, '#233438', 'back');

      // Glazed acoustic door & black steel framing (#1C2226)
      c.fillPoly(
        [[pL + 6, pTop + 8], [pL + 38, pTop + 8], [pL + 18, pBot - 8], [pL + 6, pBot - 8]],
        hex('#FFFFFF'),
        0.16,
      );
      c.strokePoly([[pL, pTop], [pR, pTop], [pR, pBot], [pL, pBot]], 4.5, hex('#1B2226'), 1, true);
      // Door mullion & handle
      const doorX = pL + (pR - pL) * 0.18;
      c.drawLine(doorX, pTop, doorX, pBot, 2.6, hex('#1B2226'), 0.95);
      c.drawLine(doorX + 6, pTop + 112, doorX + 6, pTop + 138, 2.6, hex('#D4A359'), 0.95);
    }

    // Lush architectural planters flanking the quiet pods
    drawPlanter(c, vxL - 4, vyBot + 24, 0.98);
    drawPlanter(c, vxR + 12, vyBot + 24, 0.98);
    drawPlanter(c, width - 78, 476, 1.15);

    // Foreground quiet reading / focus touchdown table on right
    c.fillPolyVGrad(
      [[260, 396], [540, 396], [590, 468], [210, 468]],
      hex('#7D5536'),
      hex('#593B24'),
      0.98,
    );
    drawChair(c, 330, 444, 1.05, '#25383B', 'back');
    drawChair(c, 470, 444, 1.05, '#25383B', 'back');
  }
}

function renderSpaceScenePng(width, height, spaceCode, variantIndex = 0) {
  const canvas = createSceneCanvas(width, height);
  const variant = variantIndex % 2;

  if (spaceCode === 'TRC-AUD-01') {
    renderAuditoriumScene(canvas, width, height, variant);
  } else if (spaceCode === 'TRC-CW-01' || spaceCode === 'TRC-CW-02') {
    renderCoworkingScene(canvas, width, height, spaceCode, variant);
  } else {
    renderMeetingRoomScene(canvas, width, height, spaceCode, variant);
  }

  canvas.applyArchitecturalFinish();
  const { buf } = canvas;
  return encodePng(width, height, (x, y) => {
    const idx = (y * width + x) * 3;
    return [buf[idx], buf[idx + 1], buf[idx + 2]];
  });
}

const SCENE_ALT_DESCRIPTIONS = {
  'TRC-MR-01': [
    'Baobab Meeting Room — interior view 1: 12-seat walnut boardroom table, mullioned garden window and presentation display',
    'Baobab Meeting Room — interior view 2: warm afternoon daylight across the conference table and glass whiteboard wall',
  ],
  'TRC-MR-02': [
    'Acacia Training Room — interior view 1: tiered oak classroom desks, presenter station and wide workshop display',
    'Acacia Training Room — interior view 2: sunlit workshop layout with floor-to-ceiling windows and glass whiteboard',
  ],
  'TRC-AUD-01': [
    'Grand Auditorium — interior view 1: raked auditorium seating, acoustic timber slat walls and illuminated 14-metre stage',
    'Grand Auditorium — interior view 2: angled perspective of the presenter lectern, stage spotlights and timber ribs',
  ],
  'TRC-CW-01': [
    'Co-working Floor — Desks — interior view 1: shared oak workbench desks with dual monitors, dome lamps and indoor planters',
    'Co-working Floor — Desks — interior view 2: sunlit studio workspace with industrial glass partitions and birch bookshelves',
  ],
  'TRC-CW-02': [
    'Quiet Pods — Focus Desks — interior view 1: acoustic timber-lined focus booths with glass doors and warm desk lamp glow',
    'Quiet Pods — Focus Desks — interior view 2: calm library-studio focus pods with standing desks and indoor greenery',
  ],
};

function seedImages(db, actor, spaceOrId, count = 2) {
  ensureUploadDir();
  const space = typeof spaceOrId === 'object' && spaceOrId !== null
    ? spaceOrId
    : db.prepare('SELECT id, code, name FROM space WHERE id = ?').get(spaceOrId);
  const spaceId = space?.id ?? spaceOrId;
  const spaceCode = space?.code ?? 'TRC-MR-01';
  const spaceName = space?.name ?? 'Space';

  for (let i = 0; i < count; i += 1) {
    const png = renderSpaceScenePng(800, 500, spaceCode, i);
    const storedName = `${Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}.png`;
    writeFileSync(join(uploadDir(), storedName), png, { mode: 0o640 });
    const altText = SCENE_ALT_DESCRIPTIONS[spaceCode]?.[i]
      ?? `${spaceName} — interior view ${i + 1}`;
    addImageRecord(db, {
      actor,
      spaceId,
      storedName,
      originalName: `${i === 0 ? 'cover' : `view-${i}`}.png`,
      mimeType: 'image/png',
      byteSize: png.length,
      altText,
    });
  }
}

/* ------------------------------------------------------------------ catalogue */

const SPACES = [
  {
    code: 'TRC-MR-01', name: 'Baobab Meeting Room', category: SPACE_CATEGORY.MEETING_ROOM,
    short_description: 'A bright 12-seat meeting room on the second floor.',
    description: 'Baobab is our most-requested meeting room: a quiet, naturally lit space for twelve people with a wall-mounted display, video conferencing and a full-height whiteboard. Ideal for client reviews, sprint planning and half-day workshops.',
    location: 'Trace Expert City, Block A', floor: '2nd floor', capacity: 12,
    pricing_unit: 'HOUR', min_duration_minutes: 60, max_duration_minutes: 600, buffer_minutes: 15,
    open_time: '08:00', close_time: '18:00',
    amenities: ['Projector', 'Display screen', 'Whiteboard', 'Video conferencing', 'High-speed internet', 'Air conditioning', 'Power outlets'],
    attributes: { layout_options: ['Boardroom', 'U-shape', 'Classroom'], display_size_inches: 65, has_projector: true, has_whiteboard: true, conferencing: 'Zoom Rooms', internet_note: 'Wired and Wi-Fi, 100 Mbps symmetric' },
    rates: [{ unit: 'HOUR', amount_cents: 150000 }, { unit: 'HALF_DAY', amount_cents: 525000 }, { unit: 'DAY', amount_cents: 900000 }],
  },
  {
    code: 'TRC-MR-02', name: 'Acacia Training Room', category: SPACE_CATEGORY.MEETING_ROOM,
    short_description: 'A 30-seat training room configured for workshops.',
    description: 'Acacia is built for training: thirty seats in classroom layout, two projectors, a presenter station and breakout space directly outside the door. Suitable for full-day courses, certification sessions and larger team offsites.',
    location: 'Trace Expert City, Block A', floor: '3rd floor', capacity: 30,
    pricing_unit: 'HOUR', min_duration_minutes: 120, max_duration_minutes: 600, buffer_minutes: 30,
    open_time: '08:00', close_time: '18:00',
    amenities: ['Projector', 'Whiteboard', 'High-speed internet', 'Air conditioning', 'Power outlets', 'Kitchenette', 'Accessible entrance'],
    attributes: { layout_options: ['Classroom', 'Theatre', 'Cabaret'], display_size_inches: 86, has_projector: true, has_whiteboard: true, conferencing: 'Microsoft Teams', internet_note: 'Wi-Fi 6' },
    rates: [{ unit: 'HOUR', amount_cents: 220000 }, { unit: 'DAY', amount_cents: 1400000 }],
  },
  {
    code: 'TRC-AUD-01', name: 'Grand Auditorium', category: SPACE_CATEGORY.AUDITORIUM,
    short_description: 'A 420-seat auditorium with stage, lighting and full audio.',
    description: 'The Grand Auditorium seats 420 in raked seating with a 14-metre stage, professional stage lighting, a full sound system and six wireless microphones. It is used for conferences, product launches, graduations and public lectures. A technician is included for the first hour of every booking.',
    location: 'Trace Expert City, Main Hall', floor: 'Ground floor', capacity: 420,
    pricing_unit: 'HOUR', min_duration_minutes: 120, max_duration_minutes: 720, buffer_minutes: 60,
    open_time: '07:00', close_time: '21:00',
    amenities: ['Stage', 'Stage lighting', 'Sound system', 'Microphones', 'Podium', 'Projector', 'Air conditioning', 'Accessible entrance', 'Parking', 'Reception service'],
    attributes: { seating_capacity: 420, stage_width_m: 14, has_stage: true, has_lighting: true, has_audio: true, microphone_count: 6, projection: 'Dual 10k lumen', technician_included: true },
    rates: [{ unit: 'HOUR', amount_cents: 950000 }, { unit: 'HALF_DAY', amount_cents: 3200000 }, { unit: 'DAY', amount_cents: 5600000 }],
  },
  {
    code: 'TRC-CW-01', name: 'Co-working Floor — Desks', category: SPACE_CATEGORY.COWORKING,
    short_description: 'Twenty independent desks on the open co-working floor.',
    description: 'Our open co-working floor has twenty individually bookable desks with ergonomic chairs, lockable storage and access to the shared kitchenette. Book a single desk for a day, a week or a month — each reservation is allocated a specific desk so two people are never sent to the same seat.',
    location: 'Trace Expert City, Block B', floor: '1st floor', capacity: 20, desk_count: 20,
    pricing_unit: 'DAY', min_duration_minutes: 240, max_duration_minutes: 129600, buffer_minutes: 0,
    open_time: '07:00', close_time: '20:00',
    amenities: ['High-speed internet', 'Power outlets', 'Ergonomic chair', 'Locker', 'Kitchenette', 'Natural light', 'Air conditioning'],
    attributes: { desk_type: 'Hot desk', facilities: 'Lockable storage, shared kitchenette, printing on request', access_hours: '07:00–20:00, Monday to Saturday', desk_count: 20 },
    rates: [{ unit: 'DAY', amount_cents: 45000 }, { unit: 'WEEK', amount_cents: 225000 }, { unit: 'MONTH', amount_cents: 800000 }],
  },
  {
    code: 'TRC-CW-02', name: 'Quiet Pods — Focus Desks', category: SPACE_CATEGORY.COWORKING,
    short_description: 'Eight quiet-pod desks for focused individual work.',
    description: 'Eight desks inside glazed quiet pods, separated from the open floor. Booked the same way as the main co-working floor, with day, week and month rates. Best for deep-focus work and confidential calls.',
    location: 'Trace Expert City, Block B', floor: '1st floor', capacity: 8, desk_count: 8,
    pricing_unit: 'DAY', min_duration_minutes: 240, max_duration_minutes: 129600, buffer_minutes: 0,
    open_time: '07:00', close_time: '20:00',
    amenities: ['High-speed internet', 'Power outlets', 'Ergonomic chair', 'Standing desk', 'Air conditioning', 'Lockable storage'],
    attributes: { desk_type: 'Quiet pod desk', facilities: 'Acoustic lining, standing-desk converter, lockable storage', access_hours: '07:00–20:00, Monday to Saturday', desk_count: 8 },
    rates: [{ unit: 'DAY', amount_cents: 60000 }, { unit: 'WEEK', amount_cents: 300000 }, { unit: 'MONTH', amount_cents: 1050000 }],
  },
];

export function seedCatalogue(db, { actor, withImages = true } = {}) {
  const created = [];
  for (const definition of SPACES) {
    const existing = getSpaceByCode(db, definition.code);
    if (existing) { created.push({ space: existing, existed: true }); continue; }
    const space = createSpace(db, { actor, payload: definition });
    if (withImages) seedImages(db, actor, space, 2);
    const published = publishSpace(db, { actor, spaceId: space.id });
    created.push({ space: published, existed: false });
  }
  return created;
}

/* ------------------------------------------------------------------- demo data */

export function seedDemoContent(db, { actor } = {}) {
  if (db.prepare('SELECT COUNT(*) AS c FROM reservation').get().c > 0) {
    return { skipped: true, reason: 'reservations already exist' };
  }

  const customers = [
    { full_name: 'Hanna Bekele', email: 'hanna.bekele@example.com', phone: '+251 911 204 118', organization: 'Addis Digital Labs' },
    { full_name: 'Samuel Girma', email: 'samuel.girma@example.com', phone: '+251 911 887 340', organization: 'Ethio Cloud Services' },
    { full_name: 'Marta Tesfaye', email: 'marta.tesfaye@example.com', phone: '+251 922 556 703', organization: 'Trace Skills Institute' },
    { full_name: 'Yonas Alemu', email: 'yonas.alemu@example.com', phone: '+251 913 992 641', organization: 'Independent' },
    { full_name: 'Liya Haile', email: 'liya.haile@example.com', phone: '+251 944 118 205', organization: 'Nile Consult' },
  ].map((payload) => createCustomer(db, { actor, payload }));

  const todayKey = businessDateKey(Date.now());
  const plusDays = (days) => {
    const base = startOfBusinessDay(Date.now());
    return businessDateKey(base + days * 86400000);
  };

  const room = getSpaceByCode(db, 'TRC-MR-01');
  const training = getSpaceByCode(db, 'TRC-MR-02');
  const auditorium = getSpaceByCode(db, 'TRC-AUD-01');
  const desks = getSpaceByCode(db, 'TRC-CW-01');

  const bookings = [
    { space: room, customer: customers[0], date: todayKey, from: '09:00', to: '11:00', purpose: 'Sprint review', attendees: 9 },
    { space: room, customer: customers[1], date: todayKey, from: '14:00', to: '16:00', purpose: 'Client discovery session', attendees: 6 },
    { space: training, customer: customers[2], date: plusDays(1), from: '09:00', to: '16:00', purpose: 'Data fundamentals training', attendees: 26, billingUnit: 'DAY' },
    { space: auditorium, customer: customers[4], date: plusDays(3), from: '09:00', to: '18:00', purpose: 'Nile Consult annual conference', attendees: 380, billingUnit: 'DAY' },
    { space: room, customer: customers[3], date: plusDays(2), from: '10:00', to: '12:00', purpose: 'Vendor negotiation', attendees: 4 },
    { space: desks, customer: customers[1], date: plusDays(1), from: '07:00', to: '20:00', purpose: 'Team hot-desking — 4 desks', unitCount: 4, billingUnit: 'DAY' },
  ];

  const made = [];
  for (const entry of bookings) {
    const result = createReservation(db, {
      actor,
      spaceId: entry.space.id,
      customerId: entry.customer.id,
      startAt: businessLocalToEpoch(entry.date, entry.from),
      endAt: businessLocalToEpoch(entry.date, entry.to),
      unitCount: entry.unitCount ?? 1,
      attendees: entry.attendees ?? null,
      purpose: entry.purpose,
      billingUnit: entry.billingUnit ?? null,
    });
    made.push(result.reservation);
  }

  // A completed booking in the past, to exercise the COMPLETED status path.
  const pastDate = plusDays(-7);
  const past = createReservation(db, {
    actor,
    spaceId: room.id,
    customerId: customers[0].id,
    startAt: businessLocalToEpoch(pastDate, '09:00'),
    endAt: businessLocalToEpoch(pastDate, '11:00'),
    attendees: 7,
    purpose: 'Retrospective',
  });

  // Maintenance: the auditorium is dark for rigging next week.
  createMaintenanceBlock(db, {
    actor,
    spaceId: auditorium.id,
    startAt: businessLocalToEpoch(plusDays(7), '07:00'),
    endAt: businessLocalToEpoch(plusDays(7), '21:00'),
    reason: 'Stage rigging inspection and lighting service',
  });

  // An open inquiry, and one whose notification could not be delivered.
  const inquiryRows = [
    {
      space: auditorium, name: 'Dawit Mekonnen', email: 'dawit.mekonnen@example.com',
      phone: '+251 911 665 220', organization: 'Rift Valley Media',
      start: businessLocalToEpoch(plusDays(10), '09:00'), end: businessLocalToEpoch(plusDays(10), '17:00'),
      attendees: 300, message: 'We would like to host a product launch for around 300 guests. Please advise on staging and AV support.',
      status: 'NEW', emailStatus: 'NOT_CONFIGURED',
    },
    {
      space: room, name: 'Selam Abebe', email: 'selam.abebe@example.com',
      phone: '+251 922 401 887', organization: 'Bright Path Consulting',
      start: businessLocalToEpoch(plusDays(4), '13:00'), end: businessLocalToEpoch(plusDays(4), '15:00'),
      attendees: 10, message: 'Half-day strategy session. We need a whiteboard and video conferencing.',
      status: 'CONTACTED', emailStatus: 'NOT_CONFIGURED',
    },
  ];

  withWriteTransaction(db, () => {
    for (const row of inquiryRows) {
      const reference = nextReference(db, 'inquiry');
      const now = Date.now();
      db.prepare(`INSERT INTO inquiry
          (reference, space_id, customer_name, email, email_normalized, phone, organization,
           requested_start_at, requested_end_at, attendees, desk_quantity, message, status,
           withdraw_token_hash, email_status, email_error, email_attempted_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          reference, row.space.id, row.name, row.email, row.email.toLowerCase(), row.phone,
          row.organization, row.start, row.end, row.attendees, null, row.message, row.status,
          hashTokenForSeed(randomToken(24)), row.emailStatus,
          row.emailStatus === 'NOT_CONFIGURED' ? 'SMTP is not configured (SMTP_HOST is unset).' : null,
          now, now, now,
        );
    }
  });

  return { skipped: false, reservations: made.length + 1, pastReservation: past.reservation.reference, customers: customers.length };
}

function hashTokenForSeed(token) {
  // Same derivation as inquiryService: sha256 of the raw token.
  return createHash('sha256').update(String(token)).digest('hex');
}

/* ---------------------------------------------------------------------- main */

export function maybeSeedDemoData(db) {
  const existingSpaces = db.prepare('SELECT COUNT(*) AS c FROM space').get().c;
  if (existingSpaces > 0) {
    console.log('[seed] spaces already present; demo seed skipped');
    return { skipped: true };
  }
  const actor = ensureSeedActor(db);
  seedCatalogue(db, { actor });
  seedDemoContent(db, { actor });
  console.log('[seed] demo catalogue, customers, reservations and inquiries created');
  return { skipped: false };
}

function ensureSeedActor(db) {
  const existing = db.prepare("SELECT * FROM admin_user WHERE role = 'ADMIN' ORDER BY id LIMIT 1").get();
  if (existing) return { id: existing.id, label: `${existing.display_name} (${existing.role})`, role: existing.role };

  const email = process.env.NAGARO_DEMO_ADMIN_EMAIL ?? 'admin@nagaro.local';
  const password = process.env.NAGARO_DEMO_ADMIN_PASSWORD ?? 'NagaroDemo2026';
  const now = Date.now();
  const info = db.prepare(`INSERT INTO admin_user
      (email, password_hash, display_name, role, is_active, created_at, updated_at)
      VALUES (?,?,?,'ADMIN',1,?,?)`)
    .run(email, hashPassword(password), 'Demo Administrator', now, now);
  const id = Number(info.lastInsertRowid);
  recordAudit(db, {
    actorAdminUserId: id, actorLabel: 'seed',
    action: 'admin_user.created', entityType: 'admin_user', entityId: id,
    summary: `Seeded demonstration administrator ${email}`,
  });
  console.log(`[seed] created demonstration administrator ${email}`);
  return { id, label: 'Demo Administrator (ADMIN)', role: 'ADMIN' };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/seed.js');
if (invokedDirectly) {
  const db = getDb();
  applyMigrations(db);
  const actor = ensureSeedActor(db);
  const catalogue = seedCatalogue(db, { actor });
  const published = catalogue.filter((c) => c.space.status === SPACE_STATUS.PUBLISHED).length;
  console.log(`Catalogue ready: ${catalogue.length} spaces (${published} published).`);
  if (process.argv.includes('--demo')) {
    const demo = seedDemoContent(db, { actor });
    console.log(demo.skipped ? `Demo reservations skipped: ${demo.reason}` : `Demo content: ${demo.reservations} reservations, ${demo.customers} customers.`);
  }
  console.log(`Database: ${process.env.NAGARO_DB_PATH ?? 'data/nagaro.db'}`);
  closeDb();
}

export { encodePng, gradientPng, renderSpaceScenePng, existsSync, mkdirSync };
