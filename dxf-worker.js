"use strict";

const EPS = 1e-6;

function parseNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function distArray(a, b) {
  const ax = Number(a?.[0]);
  const ay = Number(a?.[1]);
  const bx = Number(b?.[0]);
  const by = Number(b?.[1]);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return Infinity;
  return Math.hypot(ax - bx, ay - by);
}

function arcPointsArray(center, radius, startDeg, endDeg, chordTol = 0.8) {
  if (radius <= 0) return [];
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360.0;
  const steps = Math.max(8, Math.ceil((Math.PI * sweep / 180.0 * radius) / Math.max(chordTol, 0.05)));
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (startDeg + sweep * (i / steps)) * Math.PI / 180.0;
    pts.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return pts;
}

function bulgePointsArray(p1, p2, bulge, chordTol = 0.8) {
  if (Math.abs(bulge) < 1e-12) return [p1, p2];
  const chord = distArray(p1, p2);
  if (chord < EPS) return [p1, p2];
  const theta = 4.0 * Math.atan(bulge);
  const sinHalf = Math.sin(Math.abs(theta) / 2.0);
  if (Math.abs(sinHalf) < EPS) return [p1, p2];
  const radius = chord / (2.0 * sinHalf);
  const midX = (p1[0] + p2[0]) * 0.5;
  const midY = (p1[1] + p2[1]) * 0.5;
  const normalX = -(p2[1] - p1[1]) / chord;
  const normalY = (p2[0] - p1[0]) / chord;
  const offset = Math.sqrt(Math.max(radius * radius - (chord * 0.5) ** 2, 0));
  const sign = bulge > 0 ? 1.0 : -1.0;
  const cx = midX + normalX * offset * sign;
  const cy = midY + normalY * offset * sign;
  const start = Math.atan2(p1[1] - cy, p1[0] - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * radius) / Math.max(chordTol, 0.05)));
  const pts = [p1];
  for (let i = 1; i <= steps; i += 1) {
    const a = start + theta * (i / steps);
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  pts[pts.length - 1] = p2;
  return pts;
}

function contourPolylineLengthArray(points, closed = false) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i += 1) len += distArray(points[i - 1], points[i]);
  if (closed && points.length > 2) len += distArray(points[points.length - 1], points[0]);
  return len;
}

function contourBoundsArray(points) {
  if (!Array.isArray(points) || points.length < 1) return null;
  let minX = Number(points[0]?.[0]);
  let minY = Number(points[0]?.[1]);
  let maxX = minX;
  let maxY = minY;
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  for (const p of points) {
    const x = Number(p?.[0]);
    const y = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function bboxesNearArray(a, b, gap) {
  if (!a || !b) return false;
  const g = Number.isFinite(gap) ? gap : 0;
  return !(
    a.maxX + g < b.minX ||
    b.maxX + g < a.minX ||
    a.maxY + g < b.minY ||
    b.maxY + g < a.minY
  );
}

function compactLoopPointsArray(points, tol) {
  const out = [];
  for (const raw of (points || [])) {
    const px = Number(raw && raw[0]);
    const py = Number(raw && raw[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (!out.length || distArray(out[out.length - 1], [px, py]) > tol) {
      out.push([px, py]);
    }
  }
  if (out.length > 1 && distArray(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

function cleanImportedContoursCnc(contours) {
  const cleaned = [];
  for (const contour of (contours || [])) {
    const rawPts = contour?.points || [];
    const pts = [];
    for (const raw of rawPts) {
      const x = Number(raw && raw[0]);
      const y = Number(raw && raw[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!pts.length || distArray(pts[pts.length - 1], [x, y]) > 1e-5) {
        pts.push([x, y]);
      }
    }
    const closed = !!contour?.closed;
    if (closed && pts.length > 2 && distArray(pts[0], pts[pts.length - 1]) <= 1e-5) pts.pop();
    const minPts = closed ? 3 : 2;
    if (pts.length < minPts) continue;
    const len = contourPolylineLengthArray(pts, closed);
    if (!Number.isFinite(len) || len <= 0.10) continue;
    cleaned.push({ points: pts, closed });
  }
  if (cleaned.length < 2) return cleaned;

  function stitchContoursForContinuity(inputContours, joinTol, closeTol) {
    const out = [];
    const openPool = [];
    const dedupTol = Math.max(1e-5, Math.min(joinTol * 0.35, 0.08));

    for (const contour of (inputContours || [])) {
      const pts = compactLoopPointsArray((contour?.points || []), dedupTol);
      if (pts.length < 2) continue;
      let closed = !!contour?.closed;
      if (!closed && pts.length >= 3 && distArray(pts[0], pts[pts.length - 1]) <= closeTol) closed = true;
      if (closed) {
        if (pts.length > 2 && distArray(pts[0], pts[pts.length - 1]) <= closeTol) pts.pop();
        if (pts.length >= 3) out.push({ points: pts, closed: true });
      } else {
        openPool.push(pts);
      }
    }

    while (openPool.length > 0) {
      let chain = openPool.pop();
      let grew = true;
      while (grew) {
        grew = false;
        const cStart = chain[0];
        const cEnd = chain[chain.length - 1];
        let best = null;
        for (let i = 0; i < openPool.length; i += 1) {
          const pts = openPool[i];
          if (!pts || pts.length < 2) continue;
          const pStart = pts[0];
          const pEnd = pts[pts.length - 1];
          const options = [
            { d: distArray(cEnd, pStart), attachEnd: true, reverse: false, idx: i },
            { d: distArray(cEnd, pEnd), attachEnd: true, reverse: true, idx: i },
            { d: distArray(cStart, pEnd), attachEnd: false, reverse: false, idx: i },
            { d: distArray(cStart, pStart), attachEnd: false, reverse: true, idx: i },
          ];
          for (const opt of options) {
            if (opt.d > joinTol) continue;
            if (!best || opt.d < best.d) best = opt;
          }
        }
        if (!best) break;
        const picked = openPool.splice(best.idx, 1)[0];
        const seg = best.reverse ? [...picked].reverse() : [...picked];
        if (best.attachEnd) {
          if (seg.length && distArray(chain[chain.length - 1], seg[0]) <= joinTol) seg.shift();
          chain = chain.concat(seg);
        } else {
          if (seg.length && distArray(seg[seg.length - 1], chain[0]) <= joinTol) seg.pop();
          chain = seg.concat(chain);
        }
        grew = true;
      }
      const closed = chain.length >= 3 && distArray(chain[0], chain[chain.length - 1]) <= closeTol;
      if (closed) chain.pop();
      if (chain.length >= (closed ? 3 : 2)) out.push({ points: chain, closed });
    }
    return out;
  }

  const bounds = cleaned.map((c) => contourBoundsArray(c.points));
  let minX = 1e30;
  let minY = 1e30;
  let maxX = -1e30;
  let maxY = -1e30;
  for (const b of bounds) {
    if (!b) continue;
    minX = Math.min(minX, Number(b.minX));
    minY = Math.min(minY, Number(b.minY));
    maxX = Math.max(maxX, Number(b.maxX));
    maxY = Math.max(maxY, Number(b.maxY));
  }
  if (!(maxX > minX + EPS && maxY > minY + EPS)) return cleaned;
  const spanW = maxX - minX;
  const spanH = maxY - minY;
  const minSide = Math.max(1.0, Math.min(spanW, spanH));
  const stitchJoin = Math.max(0.03, Math.min(0.45, minSide * 0.0018));
  const stitchClose = Math.max(stitchJoin * 1.35, 0.05);
  const stitched = stitchContoursForContinuity(cleaned, stitchJoin, stitchClose);
  const merged = stitched.length ? stitched : cleaned;
  if (merged.length < 2) return merged;

  const mBounds = merged.map((c) => contourBoundsArray(c.points));
  minX = 1e30;
  minY = 1e30;
  maxX = -1e30;
  maxY = -1e30;
  for (const b of mBounds) {
    if (!b) continue;
    minX = Math.min(minX, Number(b.minX));
    minY = Math.min(minY, Number(b.minY));
    maxX = Math.max(maxX, Number(b.maxX));
    maxY = Math.max(maxY, Number(b.maxY));
  }
  if (!(maxX > minX + EPS && maxY > minY + EPS)) return merged;
  const mSpanW = maxX - minX;
  const mSpanH = maxY - minY;
  const mMinSide = Math.max(1.0, Math.min(mSpanW, mSpanH));
  const joinGap = Math.max(0.5, Math.min(20.0, mMinSide * 0.05));

  const used = new Array(merged.length).fill(false);
  const groups = [];
  for (let i = 0; i < merged.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const stack = [i];
    const idxs = [];
    let gMinX = 1e30;
    let gMinY = 1e30;
    let gMaxX = -1e30;
    let gMaxY = -1e30;
    let totalLen = 0.0;

    while (stack.length) {
      const idx = stack.pop();
      idxs.push(idx);
      const b = mBounds[idx];
      const c = merged[idx];
      totalLen += contourPolylineLengthArray(c.points, c.closed);
      gMinX = Math.min(gMinX, Number(b.minX));
      gMinY = Math.min(gMinY, Number(b.minY));
      gMaxX = Math.max(gMaxX, Number(b.maxX));
      gMaxY = Math.max(gMaxY, Number(b.maxY));

      for (let j = 0; j < merged.length; j += 1) {
        if (used[j]) continue;
        if (!bboxesNearArray(mBounds[idx], mBounds[j], joinGap)) continue;
        used[j] = true;
        stack.push(j);
      }
    }
    const area = Math.max(EPS, (gMaxX - gMinX) * (gMaxY - gMinY));
    groups.push({ idxs, area, score: totalLen * Math.sqrt(area) });
  }
  if (groups.length < 2) return merged;
  groups.sort((a, b) => Number(b.score) - Number(a.score));
  const main = groups[0];
  const alt = groups[1];
  const areaAll = Math.max(EPS, mSpanW * mSpanH);
  const keepOnlyMain = (
    (Number(main.score) > Number(alt.score) * 2.4 && Number(main.area) > Number(alt.area) * 1.8) ||
    (areaAll > Number(main.area) * 1.45 && Number(main.score) > Number(alt.score) * 1.6)
  );
  if (!keepOnlyMain) return merged;
  return main.idxs.map((idx) => merged[idx]);
}

function normalizeContoursCnc(contours) {
  const filtered = cleanImportedContoursCnc(contours);
  const all = [];
  for (const c of filtered) for (const p of (c.points || [])) all.push(p);
  if (!all.length) return null;
  let minX = all[0][0];
  let minY = all[0][1];
  let maxX = all[0][0];
  let maxY = all[0][1];
  for (const p of all) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const shifted = filtered.map((c) => ({
    closed: !!c.closed,
    points: (c.points || []).map((p) => [p[0] - minX, p[1] - minY]),
  }));
  return {
    contours: shifted,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function normalizeContoursSimple(contours) {
  const valid = [];
  for (const contour of (contours || [])) {
    const pts = [];
    for (const p of (contour?.points || [])) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    const closed = !!contour?.closed && pts.length >= 3;
    valid.push({ points: pts, closed });
  }
  if (!valid.length) return null;

  const all = [];
  for (const c of valid) for (const p of (c.points || [])) all.push(p);
  if (!all.length) return null;
  let minX = all[0][0];
  let minY = all[0][1];
  let maxX = all[0][0];
  let maxY = all[0][1];
  for (const p of all) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }

  return {
    contours: valid.map((c) => ({
      closed: !!c.closed,
      points: c.points.map((p) => [p[0] - minX, p[1] - minY]),
    })),
    width: maxX - minX,
    height: maxY - minY,
  };
}

function entityField(fields, code, fallback = "") {
  for (const item of fields) {
    if (item[0] === code) return item[1];
  }
  return fallback;
}

function readRecord(pairs, start) {
  const type = String(pairs[start][1] || "").toUpperCase();
  let i = start + 1;
  const fields = [];
  while (i < pairs.length && pairs[i][0] !== "0") {
    fields.push(pairs[i]);
    i += 1;
  }
  return { type, fields, next: i };
}

function parseDxfAsciiCnc(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([lines[i].trim(), lines[i + 1].trim()]);
  }
  let inEntities = false;
  let i = 0;
  const contours = [];

  while (i < pairs.length) {
    const code = pairs[i][0];
    const value = String(pairs[i][1] || "").toUpperCase();
    if (code === "0" && value === "SECTION") {
      const next = pairs[i + 1];
      if (next && next[0] === "2" && String(next[1] || "").toUpperCase() === "ENTITIES") {
        inEntities = true;
      }
      i += 1;
      continue;
    }
    if (!inEntities) {
      i += 1;
      continue;
    }
    if (code !== "0") {
      i += 1;
      continue;
    }
    if (value === "ENDSEC") {
      inEntities = false;
      i += 1;
      continue;
    }

    if (value === "POLYLINE") {
      const poly = readRecord(pairs, i);
      const closed = (parseInt(entityField(poly.fields, "70", "0"), 10) & 1) === 1;
      const vertices = [];
      let j = poly.next;
      while (j < pairs.length) {
        if (pairs[j][0] !== "0") {
          j += 1;
          continue;
        }
        const rec = readRecord(pairs, j);
        if (rec.type === "VERTEX") {
          vertices.push({
            x: parseNum(entityField(rec.fields, "10", "0")),
            y: parseNum(entityField(rec.fields, "20", "0")),
            bulge: parseNum(entityField(rec.fields, "42", "0")),
          });
          j = rec.next;
          continue;
        }
        if (rec.type === "SEQEND") {
          j = rec.next;
          break;
        }
        break;
      }
      if (vertices.length >= 2) {
        const segCount = closed ? vertices.length : vertices.length - 1;
        const pts = [[vertices[0].x, vertices[0].y]];
        for (let k = 0; k < segCount; k += 1) {
          const n = (k + 1) % vertices.length;
          const p1 = [vertices[k].x, vertices[k].y];
          const p2 = [vertices[n].x, vertices[n].y];
          const segPts = bulgePointsArray(p1, p2, vertices[k].bulge, 0.8);
          for (let s = 1; s < segPts.length; s += 1) pts.push(segPts[s]);
        }
        if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
        contours.push({ points: pts, closed });
      }
      i = j;
      continue;
    }

    const rec = readRecord(pairs, i);
    if (value === "LINE") {
      const x1 = parseNum(entityField(rec.fields, "10", "0"));
      const y1 = parseNum(entityField(rec.fields, "20", "0"));
      const x2 = parseNum(entityField(rec.fields, "11", "0"));
      const y2 = parseNum(entityField(rec.fields, "21", "0"));
      contours.push({ points: [[x1, y1], [x2, y2]], closed: false });
    } else if (value === "ARC") {
      const cx = parseNum(entityField(rec.fields, "10", "0"));
      const cy = parseNum(entityField(rec.fields, "20", "0"));
      const radius = parseNum(entityField(rec.fields, "40", "0"));
      const startA = parseNum(entityField(rec.fields, "50", "0"));
      const endA = parseNum(entityField(rec.fields, "51", "0"));
      const pts = arcPointsArray([cx, cy], radius, startA, endA, 0.8);
      if (pts.length > 1) contours.push({ points: pts, closed: false });
    } else if (value === "CIRCLE") {
      const cx = parseNum(entityField(rec.fields, "10", "0"));
      const cy = parseNum(entityField(rec.fields, "20", "0"));
      const radius = parseNum(entityField(rec.fields, "40", "0"));
      const pts = arcPointsArray([cx, cy], radius, 0.0, 360.0, 0.8);
      if (pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
      if (pts.length >= 3) contours.push({ points: pts, closed: true });
    } else if (value === "LWPOLYLINE") {
      const closed = (parseInt(entityField(rec.fields, "70", "0"), 10) & 1) === 1;
      const vertices = [];
      let current = null;
      for (const f of rec.fields) {
        if (f[0] === "10") {
          if (current) vertices.push(current);
          current = { x: parseNum(f[1]), y: 0.0, bulge: 0.0 };
        } else if (f[0] === "20" && current) {
          current.y = parseNum(f[1]);
        } else if (f[0] === "42" && current) {
          current.bulge = parseNum(f[1]);
        }
      }
      if (current) vertices.push(current);
      if (vertices.length >= 2) {
        const segCount = closed ? vertices.length : vertices.length - 1;
        const pts = [[vertices[0].x, vertices[0].y]];
        for (let k = 0; k < segCount; k += 1) {
          const n = (k + 1) % vertices.length;
          const p1 = [vertices[k].x, vertices[k].y];
          const p2 = [vertices[n].x, vertices[n].y];
          const segPts = bulgePointsArray(p1, p2, vertices[k].bulge, 0.8);
          for (let s = 1; s < segPts.length; s += 1) pts.push(segPts[s]);
        }
        if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
        contours.push({ points: pts, closed });
      }
    } else if (value === "SPLINE") {
      const closed = (parseInt(entityField(rec.fields, "70", "0"), 10) & 1) === 1;
      const controlPoints = [];
      const fitPoints = [];
      let currentControl = null;
      let currentFit = null;

      for (const f of rec.fields) {
        if (f[0] === "10") {
          if (currentControl) controlPoints.push(currentControl);
          currentControl = [parseNum(f[1]), 0.0];
        } else if (f[0] === "20" && currentControl) {
          currentControl[1] = parseNum(f[1]);
        } else if (f[0] === "11") {
          if (currentFit) fitPoints.push(currentFit);
          currentFit = [parseNum(f[1]), 0.0];
        } else if (f[0] === "21" && currentFit) {
          currentFit[1] = parseNum(f[1]);
        }
      }
      if (currentControl) controlPoints.push(currentControl);
      if (currentFit) fitPoints.push(currentFit);

      const source = controlPoints.length >= 2 ? controlPoints : fitPoints;
      if (source.length >= 2) {
        const pts = [];
        for (const p of source) {
          const x = parseNum(p[0]);
          const y = parseNum(p[1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (!pts.length || distArray(pts[pts.length - 1], [x, y]) > 1e-7) {
            pts.push([x, y]);
          }
        }
        if (pts.length >= 2) {
          if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
          contours.push({ points: pts, closed });
        }
      }
    }
    i = rec.next;
  }

  return normalizeContoursCnc(contours) || normalizeContoursSimple(contours);
}

self.onmessage = (event) => {
  const data = event?.data || {};
  if (data.type !== "parse") return;

  const id = Number(data.id);
  try {
    const parsed = parseDxfAsciiCnc(String(data.text || ""));
    if (!parsed || !Array.isArray(parsed.contours) || parsed.contours.length < 1) {
      throw new Error("Nenhum contorno valido encontrado no DXF.");
    }
    self.postMessage({ ok: true, id, parsed });
  } catch (error) {
    self.postMessage({
      ok: false,
      id,
      error: String(error?.message || error || "Falha no parse DXF")
    });
  }
};
