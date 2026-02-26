import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

// DXF parser (CDN)
import DxfParser from "https://esm.sh/dxf-parser@1.1.2";

// ---------------------------
// Scene / camera / renderer
// ---------------------------
const container = document.getElementById("viewport");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500000);
camera.position.set(180, 160, 180);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(200, 300, 150);
scene.add(dir);

// Grid / axes
const grid = new THREE.GridHelper(500, 50, 0x334155, 0x1f2937);
grid.position.y = 0;
scene.add(grid);

const axes = new THREE.AxesHelper(80);
scene.add(axes);

// Orbit controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

// Transform controls (move selected part)
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode("translate");
scene.add(transformControls);

// ---------------------------
// Parts state
// ---------------------------
const partsGroup = new THREE.Group();
scene.add(partsGroup);

const bboxAll = new THREE.Box3();
const tempBox = new THREE.Box3();
const tempVec = new THREE.Vector3();

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const layoutProbeBox = new THREE.Box3();
const layoutChildBox = new THREE.Box3();

let selectedPart = null;
let selectionOutline = null;
let pointerDownX = 0;
let pointerDownY = 0;
let pointerMoved = false;

const LAYOUT_CELL_XY = 30;
const LAYOUT_CELL_Z = 26;
const LAYOUT_COLUMNS = 5;
const LAYOUT_ROWS_PER_LAYER = 2;
const LAYOUT_LAYER_SIZE = LAYOUT_COLUMNS * LAYOUT_ROWS_PER_LAYER;
const LAYOUT_COLLISION_MARGIN = 1;
const LAYOUT_PUSH_STEP = 18;
const EPS = 1e-6;

function alternatingOffset(index) {
  if (index === 0) return 0;
  const step = Math.ceil(index / 2);
  return index % 2 === 1 ? step : -step;
}

function getUpperSquareSlot(index) {
  const layer = Math.floor(index / LAYOUT_LAYER_SIZE);
  const localIndex = index % LAYOUT_LAYER_SIZE;
  const row = Math.floor(localIndex / LAYOUT_COLUMNS);
  const colIndex = localIndex % LAYOUT_COLUMNS;

  return {
    x: alternatingOffset(colIndex),
    y: row,
    z: -layer
  };
}

function placeGroupInLayout(localGroup, index) {
  const slot = getUpperSquareSlot(index);
  localGroup.position.x += slot.x * LAYOUT_CELL_XY;
  localGroup.position.y += slot.y * LAYOUT_CELL_XY;
  localGroup.position.z += slot.z * LAYOUT_CELL_Z;

  const pushDir = new THREE.Vector3(
    slot.x === 0 ? 0 : Math.sign(slot.x),
    slot.y === 0 ? 1 : Math.sign(slot.y),
    slot.z < 0 ? -0.35 : 0
  );
  if (pushDir.lengthSq() < 1e-9) pushDir.set(1, 1, 0);
  pushDir.normalize();

  for (let i = 0; i < 160; i++) {
    localGroup.updateMatrixWorld(true);
    layoutProbeBox.setFromObject(localGroup);
    layoutProbeBox.expandByScalar(LAYOUT_COLLISION_MARGIN);

    let collided = false;
    for (const child of partsGroup.children) {
      layoutChildBox.setFromObject(child);
      layoutChildBox.expandByScalar(LAYOUT_COLLISION_MARGIN);
      if (layoutProbeBox.intersectsBox(layoutChildBox)) {
        collided = true;
        break;
      }
    }

    if (!collided) break;

    localGroup.position.addScaledVector(pushDir, LAYOUT_PUSH_STEP);
    if ((i + 1) % 30 === 0) localGroup.position.y += LAYOUT_PUSH_STEP;
  }
}

function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", onResize);
onResize();

transformControls.addEventListener("dragging-changed", (event) => {
  controls.enabled = !event.value;
});

transformControls.addEventListener("objectChange", () => {
  updateGlobalBounds();
});

function disposeObject3D(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (!node.material) return;

    if (Array.isArray(node.material)) {
      for (const mat of node.material) mat.dispose();
    } else {
      node.material.dispose();
    }
  });
}

function clearSelection() {
  transformControls.detach();

  if (selectionOutline) {
    if (selectionOutline.parent) selectionOutline.parent.remove(selectionOutline);
    const disposedMaterials = new Set();
    selectionOutline.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (!node.material) return;
      if (Array.isArray(node.material)) {
        for (const mat of node.material) {
          if (mat && !disposedMaterials.has(mat)) {
            mat.dispose();
            disposedMaterials.add(mat);
          }
        }
      } else if (!disposedMaterials.has(node.material)) {
        node.material.dispose();
        disposedMaterials.add(node.material);
      }
    });
    selectionOutline = null;
  }

  selectedPart = null;
}

function buildSelectionOutline(part) {
  const outline = new THREE.Group();
  outline.name = "__selectionOutline";
  outline.renderOrder = 1000;

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    toneMapped: false
  });

  part.traverse((node) => {
    if (!(node && node.isMesh && node.geometry)) return;
    const edgesGeo = new THREE.EdgesGeometry(node.geometry, 1);
    if (!edgesGeo || edgesGeo.attributes.position.count < 2) {
      if (edgesGeo) edgesGeo.dispose();
      return;
    }
    const edgeLines = new THREE.LineSegments(edgesGeo, lineMaterial);
    edgeLines.matrixAutoUpdate = false;
    edgeLines.matrix.copy(node.matrix);
    edgeLines.matrixWorldNeedsUpdate = true;
    edgeLines.raycast = () => {};
    outline.add(edgeLines);
  });

  if (outline.children.length === 0) {
    lineMaterial.dispose();
    return null;
  }
  return outline;
}

function setSelectedPart(part) {
  if (selectedPart === part) return;

  clearSelection();
  if (!part) return;

  selectedPart = part;
  transformControls.attach(selectedPart);

  selectionOutline = buildSelectionOutline(selectedPart);
  if (selectionOutline) selectedPart.add(selectionOutline);
}

function partFromIntersectionObject(object) {
  let current = object;
  while (current && current.parent) {
    if (current.parent === partsGroup) return current;
    current = current.parent;
  }
  return null;
}

function pickPartAtPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(partsGroup.children, true);

  if (hits.length === 0) {
    setSelectedPart(null);
    return;
  }

  const part = partFromIntersectionObject(hits[0].object);
  setSelectedPart(part);
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
  pointerMoved = false;
});

renderer.domElement.addEventListener("pointermove", (event) => {
  if (Math.abs(event.clientX - pointerDownX) > 3 || Math.abs(event.clientY - pointerDownY) > 3) {
    pointerMoved = true;
  }
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (pointerMoved) return;
  if (transformControls.dragging) return;
  if (transformControls.axis) return;
  pickPartAtPointer(event);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearSelection();
    return;
  }

  const isDelete = event.key === "Delete" || event.key === "Backspace";
  if (!isDelete || !selectedPart) return;

  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  event.preventDefault();
  const part = selectedPart;
  clearSelection();
  partsGroup.remove(part);
  disposeObject3D(part);
  updateGlobalBounds();
});

// ---------------------------
// DXF -> 3D mesh
// Supports: LWPOLYLINE / POLYLINE / LINE+ARC loops / CIRCLE
// ---------------------------
function bulgeSegmentPoints(p1, p2, bulge, chordTol = 0.8) {
  if (!(p1 instanceof THREE.Vector2) || !(p2 instanceof THREE.Vector2)) return [];
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-12) return [p1.clone(), p2.clone()];

  const chord = p1.distanceTo(p2);
  if (chord < 1e-9) return [p1.clone(), p2.clone()];

  const theta = 4.0 * Math.atan(bulge);
  const sinHalf = Math.sin(Math.abs(theta) / 2.0);
  if (Math.abs(sinHalf) < 1e-12) return [p1.clone(), p2.clone()];

  const radius = chord / (2.0 * sinHalf);
  const midX = (p1.x + p2.x) * 0.5;
  const midY = (p1.y + p2.y) * 0.5;
  const normalX = -(p2.y - p1.y) / chord;
  const normalY = (p2.x - p1.x) / chord;
  const offset = Math.sqrt(Math.max(radius * radius - (chord * 0.5) ** 2, 0));
  const sign = bulge > 0 ? 1.0 : -1.0;
  const cx = midX + normalX * offset * sign;
  const cy = midY + normalY * offset * sign;
  const start = Math.atan2(p1.y - cy, p1.x - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * radius) / Math.max(chordTol, 0.05)));

  const pts = [p1.clone()];
  for (let i = 1; i <= steps; i += 1) {
    const a = start + theta * (i / steps);
    pts.push(new THREE.Vector2(
      cx + radius * Math.cos(a),
      cy + radius * Math.sin(a)
    ));
  }
  pts[pts.length - 1] = p2.clone();
  return pts;
}

function polylineVertices(entity) {
  const src = Array.isArray(entity?.vertices) ? entity.vertices : [];
  const out = [];
  for (const v of src) {
    const x = Number(v?.x);
    const y = Number(v?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const bulge = Number(v?.bulge || 0);
    out.push({
      point: new THREE.Vector2(x, y),
      bulge: Number.isFinite(bulge) ? bulge : 0
    });
  }
  return out;
}

function polylineToPoints(entity) {
  if (entity?.type !== "LWPOLYLINE" && entity?.type !== "POLYLINE") return null;

  const verts = polylineVertices(entity);
  if (verts.length < 2) return null;

  const closed = entity.type === "LWPOLYLINE"
    ? (!!entity.shape || !!entity.closed || isClosedByGeometry(verts.map((v) => v.point)))
    : (!!entity.closed || isClosedByGeometry(verts.map((v) => v.point)));

  const segCount = closed ? verts.length : verts.length - 1;
  const pts = [verts[0].point.clone()];
  for (let i = 0; i < segCount; i += 1) {
    const n = (i + 1) % verts.length;
    const segPts = bulgeSegmentPoints(verts[i].point, verts[n].point, verts[i].bulge, 0.8);
    for (let k = 1; k < segPts.length; k += 1) pts.push(segPts[k]);
  }
  if (closed && pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) <= 1e-6) pts.pop();
  return { pts, closed };
}

function lineToPoints(entity) {
  if (entity.type !== "LINE") return null;

  if (Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
    return {
      a: new THREE.Vector2(entity.vertices[0].x, entity.vertices[0].y),
      b: new THREE.Vector2(entity.vertices[1].x, entity.vertices[1].y)
    };
  }

  if (entity.start && entity.end) {
    return {
      a: new THREE.Vector2(entity.start.x, entity.start.y),
      b: new THREE.Vector2(entity.end.x, entity.end.y)
    };
  }

  return null;
}

function toRadiansFromDxfDegrees(angle) {
  if (!Number.isFinite(angle)) return NaN;
  return THREE.MathUtils.degToRad(angle);
}

function arcToPolylinePoints(entity, maxSagitta = 0.35) {
  if (entity.type !== "ARC" || !entity.center) return null;

  const radius = Number(entity.radius);
  let start = toRadiansFromDxfDegrees(Number(entity.startAngle));
  let end = toRadiansFromDxfDegrees(Number(entity.endAngle));

  if (!Number.isFinite(radius) || radius <= 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  while (end <= start) end += Math.PI * 2;
  const sweep = end - start;
  if (sweep <= 1e-9) return null;

  const center = new THREE.Vector2(entity.center.x, entity.center.y);
  const sagitta = Math.min(Math.max(maxSagitta, 0.05), radius * 0.5);
  const acosArg = THREE.MathUtils.clamp(1 - (sagitta / radius), -1, 1);
  const idealStepAngle = 2 * Math.acos(acosArg);
  const fallbackStepAngle = THREE.MathUtils.degToRad(3);
  const stepAngle = Number.isFinite(idealStepAngle) && idealStepAngle > 1e-6
    ? idealStepAngle
    : fallbackStepAngle;
  const steps = THREE.MathUtils.clamp(
    Math.ceil(sweep / stepAngle),
    6,
    2048
  );
  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = start + (sweep * t);
    pts.push(new THREE.Vector2(
      center.x + (Math.cos(a) * radius),
      center.y + (Math.sin(a) * radius)
    ));
  }

  return pts;
}

function circleToShapeInfo(entity) {
  if (entity.type !== "CIRCLE" || !entity.center) return null;

  const radius = Number(entity.radius);
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const center = new THREE.Vector2(entity.center.x, entity.center.y);
  return { center, radius };
}

function isClosedByGeometry(pts, eps = 1e-6) {
  if (!pts || pts.length < 3) return false;
  return pts[0].distanceTo(pts[pts.length - 1]) <= eps;
}

function buildClosedPointList(pts) {
  const cleaned = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.distanceTo(p) > 1e-9) cleaned.push(p);
  }

  if (cleaned.length < 3) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first.distanceTo(last) > 1e-9) cleaned.push(first.clone());

  return cleaned;
}

function buildShapeInfoFromPoints(pts) {
  const closedPts = buildClosedPointList(pts);
  if (!closedPts) return null;

  return {
    shape: new THREE.Shape(closedPts),
    outline: closedPts
  };
}

function appendSegmentsFromPointList(pts, outSegments) {
  if (!Array.isArray(pts) || pts.length < 2 || !Array.isArray(outSegments)) return;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!(a instanceof THREE.Vector2) || !(b instanceof THREE.Vector2)) continue;
    if (a.distanceTo(b) <= 1e-9) continue;
    outSegments.push({ a, b });
  }
}

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
    }
    i = rec.next;
  }

  return normalizeContoursCnc(contours) || normalizeContoursSimple(contours);
}

function pointKey(point, eps = 1e-4) {
  return `${Math.round(point.x / eps)}_${Math.round(point.y / eps)}`;
}

function extractClosedLoopsFromSegments(segments, eps = 1e-4) {
  const edges = [];
  const adjacency = new Map();

  function addAdj(key, edgeIndex) {
    const list = adjacency.get(key);
    if (list) list.push(edgeIndex);
    else adjacency.set(key, [edgeIndex]);
  }

  for (const seg of segments) {
    if (!seg || !seg.a || !seg.b) continue;
    if (seg.a.distanceTo(seg.b) <= 1e-9) continue;

    const aKey = pointKey(seg.a, eps);
    const bKey = pointKey(seg.b, eps);
    if (aKey === bKey) continue;

    const edgeIndex = edges.length;
    edges.push({ a: seg.a, b: seg.b, aKey, bKey });
    addAdj(aKey, edgeIndex);
    addAdj(bKey, edgeIndex);
  }

  const used = new Array(edges.length).fill(false);
  const loops = [];

  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;

    used[i] = true;
    const firstEdge = edges[i];
    const startKey = firstEdge.aKey;
    let prevKey = firstEdge.aKey;
    let currentKey = firstEdge.bKey;
    const path = [firstEdge.a.clone(), firstEdge.b.clone()];
    let closed = currentKey === startKey;

    for (let guard = 0; !closed && guard < edges.length + 2; guard++) {
      const candidates = (adjacency.get(currentKey) || []).filter((idx) => !used[idx]);
      if (candidates.length === 0) break;

      let nextEdgeIndex = candidates[0];
      if (candidates.length > 1) {
        const preferred = candidates.find((idx) => {
          const e = edges[idx];
          const nextKey = e.aKey === currentKey ? e.bKey : e.aKey;
          return nextKey !== prevKey;
        });
        if (preferred !== undefined) nextEdgeIndex = preferred;
      }

      used[nextEdgeIndex] = true;
      const nextEdge = edges[nextEdgeIndex];
      const nextKey = nextEdge.aKey === currentKey ? nextEdge.bKey : nextEdge.aKey;
      const nextPoint = nextEdge.aKey === currentKey ? nextEdge.b : nextEdge.a;

      path.push(nextPoint.clone());
      prevKey = currentKey;
      currentKey = nextKey;
      closed = currentKey === startKey;
    }

    if (closed && path.length >= 3) loops.push(path);
  }

  return loops;
}

function compactLoopPoints(points, tol) {
  const out = [];
  for (const raw of (points || [])) {
    if (!(raw instanceof THREE.Vector2)) continue;
    if (!out.length || out[out.length - 1].distanceTo(raw) > tol) {
      out.push(raw.clone());
    }
  }
  if (out.length > 1 && out[0].distanceTo(out[out.length - 1]) <= tol) out.pop();
  return out;
}

function stitchClosedLoopsFromOpenContours(openContours, tol) {
  const pool = [];
  for (const contour of (openContours || [])) {
    const pts = compactLoopPoints(contour, tol * 0.5);
    if (pts.length >= 2) pool.push({ points: pts, used: false });
  }
  const loops = [];

  for (let baseIdx = 0; baseIdx < pool.length; baseIdx += 1) {
    if (pool[baseIdx].used) continue;
    pool[baseIdx].used = true;
    let chain = [...pool[baseIdx].points];

    while (true) {
      if (chain.length >= 3 && chain[0].distanceTo(chain[chain.length - 1]) <= tol) break;

      const start = chain[0];
      const end = chain[chain.length - 1];
      let best = null;

      for (let i = 0; i < pool.length; i += 1) {
        const item = pool[i];
        if (item.used) continue;
        const pts = item.points;
        if (pts.length < 2) continue;
        const a = pts[0];
        const b = pts[pts.length - 1];

        const candidates = [
          { d: end.distanceTo(a), prepend: false, reverse: false },
          { d: end.distanceTo(b), prepend: false, reverse: true },
          { d: start.distanceTo(b), prepend: true, reverse: false },
          { d: start.distanceTo(a), prepend: true, reverse: true },
        ];
        for (const c of candidates) {
          if (c.d > tol) continue;
          if (!best || c.d < best.d) {
            best = { idx: i, d: c.d, prepend: c.prepend, reverse: c.reverse };
          }
        }
      }

      if (!best) break;
      const pick = pool[best.idx];
      pick.used = true;
      let pts = pick.points;
      if (best.reverse) pts = [...pts].reverse();

      if (best.prepend) {
        const add = [...pts];
        if (add.length && add[add.length - 1].distanceTo(chain[0]) <= tol) add.pop();
        chain = add.concat(chain);
      } else {
        const add = [...pts];
        if (add.length && chain[chain.length - 1].distanceTo(add[0]) <= tol) add.shift();
        chain = chain.concat(add);
      }
    }

    const loop = compactLoopPoints(chain, tol * 0.5);
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

function polygonAreaSigned(openPts) {
  if (!Array.isArray(openPts) || openPts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < openPts.length; i += 1) {
    const a = openPts[i];
    const b = openPts[(i + 1) % openPts.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area * 0.5;
}

function pointOnSegment(point, a, b, eps = 1e-8) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const cross = Math.abs(abx * apy - aby * apx);
  if (cross > eps) return false;
  const dot = (apx * abx) + (apy * aby);
  if (dot < -eps) return false;
  const lenSq = (abx * abx) + (aby * aby);
  if (dot - lenSq > eps) return false;
  return true;
}

function pointInPolygonStrict(point, closedPts) {
  if (!closedPts || closedPts.length < 4) return false;
  for (let i = 0; i < closedPts.length - 1; i += 1) {
    if (pointOnSegment(point, closedPts[i], closedPts[i + 1])) return false;
  }

  let inside = false;
  const count = closedPts.length - 1;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const pi = closedPts[i];
    const pj = closedPts[j];
    const intersect =
      ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || Number.EPSILON) + pi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

function bboxContainsPoint(bbox, point, eps = 1e-6) {
  return (
    point.x >= bbox.minX - eps &&
    point.x <= bbox.maxX + eps &&
    point.y >= bbox.minY - eps &&
    point.y <= bbox.maxY + eps
  );
}

function polygonCentroid(openPts) {
  if (!Array.isArray(openPts) || openPts.length < 3) return null;
  let areaAcc = 0;
  let cxAcc = 0;
  let cyAcc = 0;
  for (let i = 0; i < openPts.length; i += 1) {
    const a = openPts[i];
    const b = openPts[(i + 1) % openPts.length];
    const cross = (a.x * b.y) - (b.x * a.y);
    areaAcc += cross;
    cxAcc += (a.x + b.x) * cross;
    cyAcc += (a.y + b.y) * cross;
  }
  const area = areaAcc * 0.5;
  if (Math.abs(area) <= 1e-9) return null;
  return new THREE.Vector2(cxAcc / (6 * area), cyAcc / (6 * area));
}

function pickSampleInside(openPts, closedPts) {
  const candidates = [];
  const centroid = polygonCentroid(openPts);
  if (centroid) candidates.push(centroid);

  let sx = 0;
  let sy = 0;
  for (const p of openPts) {
    sx += p.x;
    sy += p.y;
  }
  if (openPts.length) candidates.push(new THREE.Vector2(sx / openPts.length, sy / openPts.length));
  if (openPts.length >= 2) {
    candidates.push(new THREE.Vector2(
      (openPts[0].x + openPts[1].x) * 0.5,
      (openPts[0].y + openPts[1].y) * 0.5
    ));
  }
  if (openPts.length) candidates.push(openPts[0].clone());

  for (const candidate of candidates) {
    if (pointInPolygonStrict(candidate, closedPts)) return candidate;
  }
  return candidates[candidates.length - 1] || new THREE.Vector2(0, 0);
}

function orientLoop(points, clockwise) {
  const copy = [...points];
  if (copy.length < 3) return [];
  const isClockwise = polygonAreaSigned(copy) < 0;
  if ((clockwise && !isClockwise) || (!clockwise && isClockwise)) {
    copy.reverse();
  }
  return copy;
}

function convexHullFromPoints(points) {
  const pts = (points || [])
    .map((p) => new THREE.Vector2(Number(p?.x), Number(p?.y)))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return [];

  const cross = (o, a, b) => ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : [];
}

function circleToLoopPoints(center, radius, segments = 72) {
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector2(
      center.x + Math.cos(a) * radius,
      center.y + Math.sin(a) * radius
    ));
  }
  return pts;
}

function buildShapesFromClosedLoops(closedLoops, allPoints, options = {}) {
  const allowHullFallback = options.allowHullFallback !== false;
  const loops = [];
  for (const loop of (closedLoops || [])) {
    const closedPts = buildClosedPointList(loop);
    if (!closedPts || closedPts.length < 4) continue;
    const openPts = closedPts.slice(0, -1);
    const areaAbs = Math.abs(polygonAreaSigned(openPts));
    if (!(areaAbs > 1e-8)) continue;

    let minX = openPts[0].x;
    let minY = openPts[0].y;
    let maxX = openPts[0].x;
    let maxY = openPts[0].y;
    for (const p of openPts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    loops.push({
      openPts,
      closedPts,
      areaAbs,
      bbox: { minX, minY, maxX, maxY },
      sample: pickSampleInside(openPts, closedPts),
      parent: -1,
      depth: -1
    });
  }
  if (!loops.length) return [];

  const sourcePts = (allPoints || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (allowHullFallback && sourcePts.length >= 3) {
    let minX = sourcePts[0].x;
    let minY = sourcePts[0].y;
    let maxX = sourcePts[0].x;
    let maxY = sourcePts[0].y;
    for (const p of sourcePts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const bboxArea = Math.max(1e-8, (maxX - minX) * (maxY - minY));
    const maxLoopArea = Math.max(...loops.map((x) => x.areaAbs));
    const hasLikelyOuter = loops.some((x) => x.areaAbs > bboxArea * 0.05);
    if (!hasLikelyOuter || !(maxLoopArea > bboxArea * 0.01)) {
      const hull = convexHullFromPoints(sourcePts);
      if (hull.length >= 3) {
        const closedHull = buildClosedPointList(hull);
        if (closedHull && closedHull.length >= 4) {
          const hullOpen = closedHull.slice(0, -1);
          loops.push({
            openPts: hullOpen,
            closedPts: closedHull,
            areaAbs: Math.abs(polygonAreaSigned(hullOpen)),
            bbox: { minX, minY, maxX, maxY },
            sample: pickSampleInside(hullOpen, closedHull),
            parent: -1,
            depth: -1
          });
        }
      }
    }
  }

  for (let i = 0; i < loops.length; i += 1) {
    const loop = loops[i];
    let bestParent = -1;
    for (let j = 0; j < loops.length; j += 1) {
      if (i === j) continue;
      const candidate = loops[j];
      if (!(candidate.areaAbs > loop.areaAbs + 1e-8)) continue;
      if (!bboxContainsPoint(candidate.bbox, loop.sample)) continue;
      if (!pointInPolygonStrict(loop.sample, candidate.closedPts)) continue;
      if (bestParent === -1 || candidate.areaAbs < loops[bestParent].areaAbs) bestParent = j;
    }
    loop.parent = bestParent;
  }

  function resolveDepth(idx) {
    if (loops[idx].depth >= 0) return loops[idx].depth;
    const parent = loops[idx].parent;
    loops[idx].depth = parent < 0 ? 0 : resolveDepth(parent) + 1;
    return loops[idx].depth;
  }
  for (let i = 0; i < loops.length; i += 1) resolveDepth(i);

  const childrenByParent = new Map();
  for (let i = 0; i < loops.length; i += 1) {
    const parent = loops[i].parent;
    if (parent < 0) continue;
    const list = childrenByParent.get(parent) || [];
    list.push(i);
    childrenByParent.set(parent, list);
  }

  const shapes = [];
  for (let i = 0; i < loops.length; i += 1) {
    const loop = loops[i];
    if (loop.depth % 2 !== 0) continue;
    const outerPts = orientLoop(loop.openPts, false);
    if (outerPts.length < 3) continue;
    const shape = new THREE.Shape(outerPts);

    const children = childrenByParent.get(i) || [];
    for (const childIdx of children) {
      const child = loops[childIdx];
      if (child.depth % 2 !== 1) continue;
      const holePts = orientLoop(child.openPts, true);
      if (holePts.length < 3) continue;
      shape.holes.push(new THREE.Path(holePts));
    }
    shapes.push(shape);
  }
  return shapes;
}

function importWithCncContours(dxfText, filename, thickness, material, localGroup, onIssue = null, preParsed = null) {
  let parsed = preParsed;
  if (!parsed) {
    try {
      parsed = parseDxfAsciiCnc(dxfText);
    } catch (error) {
      console.warn("Falha no parser ASCII CNC para:", filename, error);
      return false;
    }
  }
  if (!parsed || !Array.isArray(parsed.contours) || parsed.contours.length < 1) return false;
  if (!(Number(parsed.width) > EPS && Number(parsed.height) > EPS)) return false;

  const closedLoops = [];
  const allPoints = [];
  const segments = [];
  const fallbackOpenShapes = [];
  const openContours = [];

  for (const contour of parsed.contours) {
    const pts = (contour?.points || [])
      .map((pt) => new THREE.Vector2(Number(pt?.[0]), Number(pt?.[1])))
      .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (pts.length < 2) continue;
    allPoints.push(...pts);

    if (contour.closed) {
      const shapeInfo = buildShapeInfoFromPoints(pts);
      if (shapeInfo) closedLoops.push(shapeInfo.outline.slice(0, -1));
    } else {
      openContours.push(pts);
      appendSegmentsFromPointList(pts, segments);
      const shapeInfo = buildShapeInfoFromPoints(pts);
      if (shapeInfo) fallbackOpenShapes.push(shapeInfo.shape);
    }
  }

  let segmentLoops = extractClosedLoopsFromSegments(segments, 1e-4);
  if (segmentLoops.length === 0 && segments.length > 0) {
    segmentLoops = extractClosedLoopsFromSegments(segments, 1e-2);
  }
  if (segmentLoops.length === 0 && segments.length > 0) {
    segmentLoops = extractClosedLoopsFromSegments(segments, 5e-2);
  }
  if (segmentLoops.length === 0 && openContours.length > 0) {
    const minSide = Math.max(1.0, Math.min(Number(parsed.width), Number(parsed.height)));
    const stitchTol = Math.max(0.05, Math.min(0.6, minSide * 0.005));
    segmentLoops = stitchClosedLoopsFromOpenContours(openContours, stitchTol);
  }
  for (const loopPts of segmentLoops) {
    const shapeInfo = buildShapeInfoFromPoints(loopPts);
    if (shapeInfo) closedLoops.push(shapeInfo.outline.slice(0, -1));
  }

  const closedShapes = buildShapesFromClosedLoops(
    closedLoops,
    allPoints,
    { allowHullFallback: true }
  );
  for (const shape of closedShapes) {
    const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
    localGroup.add(mesh);
  }

  if (localGroup.children.length === 0 && fallbackOpenShapes.length > 0) {
    for (const shape of fallbackOpenShapes) {
      const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
      localGroup.add(mesh);
    }
    console.warn("Polylines abertas foram fechadas automaticamente em:", filename);
    reportImportIssue(
      onIssue,
      `Nenhuma entidade marcada como fechada em ${filename}. ` +
      "As polylines abertas foram fechadas automaticamente."
    );
  }

  return localGroup.children.length > 0;
}

function makeExtrudedMeshFromShape(shape, thickness, material) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 16,
    steps: 1
  });

  geo.translate(0, 0, -thickness / 2);
  geo.computeVertexNormals();

  return new THREE.Mesh(geo, material);
}

function reportImportIssue(onIssue, message) {
  if (typeof onIssue === "function") onIssue(message);
  else alert(message);
}

function finalizeImportedGroup(localGroup, autoCenter) {
  localGroup.updateMatrixWorld(true);
  tempBox.setFromObject(localGroup);
  if (autoCenter) {
    tempBox.getCenter(tempVec);
    localGroup.position.sub(tempVec);
  }
  placeGroupInLayout(localGroup, partsGroup.children.length);
  partsGroup.add(localGroup);
  updateGlobalBounds();
  return true;
}

function addDxfToScene(dxfText, filename, thickness, autoCenter = true, onIssue = null) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.6, 0.55),
    metalness: 0.05,
    roughness: 0.85
  });

  const localGroup = new THREE.Group();
  localGroup.name = filename;

  // Prefer the CNC contour pipeline first (same logic used in the CNC flow).
  // It is lighter and handles many malformed/open contour cases better.
  try {
    const okCnc = importWithCncContours(
      dxfText,
      filename,
      thickness,
      material,
      localGroup,
      onIssue
    );
    if (okCnc) return finalizeImportedGroup(localGroup, autoCenter);
  } catch (error) {
    console.warn("Fallback para parser DXF padrao em:", filename, error);
  }

  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    console.error("Erro ao parsear DXF:", filename, e);
    reportImportIssue(onIssue, `Erro ao parsear ${filename}. Veja o console (F12).`);
    return false;
  }

  const closedLoops = [];
  const allPoints = [];
  const segments = [];
  const openContoursForStitch = [];
  const fallbackOpenShapes = [];
  const lineEntities = [];
  const arcEntities = [];
  const entityTypeCount = new Map();

  for (const ent of (dxf.entities || [])) {
    const entityType = ent?.type || "UNKNOWN";
    entityTypeCount.set(entityType, (entityTypeCount.get(entityType) || 0) + 1);

    const circleInfo = circleToShapeInfo(ent);
    if (circleInfo) {
      const loopPts = circleToLoopPoints(circleInfo.center, circleInfo.radius, 72);
      if (loopPts.length >= 3) {
        closedLoops.push(loopPts);
        allPoints.push(...loopPts);
      }
      continue;
    }

    if (ent?.type === "LINE") {
      lineEntities.push(ent);
      continue;
    }

    if (ent?.type === "ARC") {
      arcEntities.push(ent);
      continue;
    }

    const polyInfo = polylineToPoints(ent);
    if (!polyInfo) continue;
    allPoints.push(...polyInfo.pts);

    const shapeInfo = buildShapeInfoFromPoints(polyInfo.pts);
    if (!shapeInfo) continue;

    if (!polyInfo.closed) {
      openContoursForStitch.push(polyInfo.pts);
      appendSegmentsFromPointList(polyInfo.pts, segments);
      fallbackOpenShapes.push(shapeInfo.shape);
      continue;
    }

    closedLoops.push(shapeInfo.outline.slice(0, -1));
  }

  for (const ent of lineEntities) {
    const seg = lineToPoints(ent);
    if (seg) {
      segments.push(seg);
      allPoints.push(seg.a, seg.b);
    }
  }

  for (const ent of arcEntities) {
    const arcPts = arcToPolylinePoints(ent);
    if (!arcPts || arcPts.length < 2) continue;
    allPoints.push(...arcPts);
    for (let i = 0; i < arcPts.length - 1; i++) {
      segments.push({ a: arcPts[i], b: arcPts[i + 1] });
    }
  }

  let segmentLoops = extractClosedLoopsFromSegments(segments, 1e-4);
  if (segmentLoops.length === 0 && segments.length > 0) {
    // Some DXFs have tiny endpoint gaps; retry with relaxed snapping.
    segmentLoops = extractClosedLoopsFromSegments(segments, 1e-2);
  }
  if (segmentLoops.length === 0 && segments.length > 0) {
    // Fallback adicional para DXF com gap maior entre segmentos de borda.
    segmentLoops = extractClosedLoopsFromSegments(segments, 5e-2);
  }
  if (segmentLoops.length === 0 && openContoursForStitch.length > 0) {
    const stitchTol = Math.max(0.05, Math.min(0.6, Math.sqrt(Math.max(1.0, allPoints.length)) * 0.03));
    segmentLoops = stitchClosedLoopsFromOpenContours(openContoursForStitch, stitchTol);
  }
  for (const loopPts of segmentLoops) {
    const shapeInfo = buildShapeInfoFromPoints(loopPts);
    if (shapeInfo) closedLoops.push(shapeInfo.outline.slice(0, -1));
  }

  const closedShapes = buildShapesFromClosedLoops(
    closedLoops,
    allPoints,
    { allowHullFallback: true }
  );

  for (const shape of closedShapes) {
    const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
    localGroup.add(mesh);
  }

  if (localGroup.children.length === 0 && fallbackOpenShapes.length > 0) {
    for (const shape of fallbackOpenShapes) {
      const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
      localGroup.add(mesh);
    }

    console.warn("Polylines abertas foram fechadas automaticamente em:", filename);
    reportImportIssue(
      onIssue,
      `Nenhuma entidade marcada como fechada em ${filename}. ` +
      "As polylines abertas foram fechadas automaticamente."
    );
  }

  if (localGroup.children.length === 0) {
    const typesSummary = [...entityTypeCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");

    console.warn("Nenhuma entidade fechada encontrada em:", filename);
    if (typesSummary) console.warn("Tipos de entidade encontrados:", typesSummary);

    reportImportIssue(
      onIssue,
      `Nenhuma entidade fechada encontrada em ${filename}. ` +
      `Tipos no arquivo: ${typesSummary || "n/a"}. ` +
      "(Suporta LWPOLYLINE/POLYLINE, CIRCLE e loops de LINE/ARC)"
    );
    return false;
  }
  return finalizeImportedGroup(localGroup, autoCenter);
}

function updateGlobalBounds() {
  bboxAll.makeEmpty();
  for (const child of partsGroup.children) {
    tempBox.setFromObject(child);
    bboxAll.union(tempBox);
  }
}

function fitToScene(padding = 1.25) {
  if (bboxAll.isEmpty()) return;

  const size = new THREE.Vector3();
  bboxAll.getSize(size);
  const center = new THREE.Vector3();
  bboxAll.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (maxDim / 2) / Math.tan(fov / 2);

  const dirVec = new THREE.Vector3(1, 1, 1).normalize();
  camera.position.copy(center.clone().add(dirVec.multiplyScalar(dist * padding)));

  controls.target.copy(center);
  controls.update();
}

// ---------------------------
// UI
// ---------------------------
const fileInput = document.getElementById("fileInput");
const thicknessEl = document.getElementById("thickness");
const autoCenterEl = document.getElementById("autoCenter");
const fitBtn = document.getElementById("fitBtn");
const clearBtn = document.getElementById("clearBtn");

fileInput.addEventListener("change", async (ev) => {
  const files = [...(ev.target.files || [])];
  if (files.length === 0) return;

  const thickness = Number(thicknessEl.value || 5);
  const autoCenter = !!autoCenterEl.checked;
  const importIssues = [];
  let importedCount = 0;

  for (const f of files) {
    let text = await f.text();
    if (text.includes("\u0000")) {
      try {
        const buf = await f.arrayBuffer();
        text = new TextDecoder("utf-16le").decode(buf);
      } catch (decodeUtf16Error) {
        console.warn("Falha no decode utf-16le para:", f?.name, decodeUtf16Error);
      }
    }

    if (!/SECTION/i.test(String(text).slice(0, 1200))) {
      try {
        const buf = await f.arrayBuffer();
        text = new TextDecoder("latin1").decode(buf);
      } catch (decodeError) {
        console.warn("Falha no decode latin1 para:", f?.name, decodeError);
      }
    }
    text = String(text || "").replace(/\u0000/g, "");
    try {
      const ok = addDxfToScene(
        text,
        f.name,
        thickness,
        autoCenter,
        (msg) => importIssues.push(msg)
      );
      if (ok) importedCount += 1;
    } catch (error) {
      console.error("Falha inesperada ao importar:", f?.name, error);
      importIssues.push(`Falha inesperada ao importar ${f?.name || "arquivo"}. Veja o console (F12).`);
    }
  }

  if (importIssues.length > 0) {
    const uniqueIssues = [...new Set(importIssues)];
    for (const msg of uniqueIssues) console.warn("[Import warning]", msg);

    if (importedCount === 0) {
      const shownIssues = uniqueIssues.slice(0, 8);
      const moreCount = uniqueIssues.length - shownIssues.length;
      const body = shownIssues.map((msg, idx) => `${idx + 1}. ${msg}`).join("\n");
      const suffix = moreCount > 0 ? `\n... e mais ${moreCount} aviso(s).` : "";
      alert(`Nenhuma peca valida foi importada.\n\n${body}${suffix}`);
    } else {
      alert(
        `Importacao concluida: ${importedCount}/${files.length} arquivo(s) importado(s). ` +
        `${uniqueIssues.length} arquivo(s) com aviso foram ignorados.`
      );
    }
  }

  fitToScene();
  fileInput.value = "";
});
fitBtn.addEventListener("click", () => {
  updateGlobalBounds();
  fitToScene();
});

clearBtn.addEventListener("click", () => {
  clearSelection();
  while (partsGroup.children.length) {
    const child = partsGroup.children[0];
    partsGroup.remove(child);
    disposeObject3D(child);
  }
  updateGlobalBounds();
});

// ---------------------------
// Render loop
// ---------------------------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
