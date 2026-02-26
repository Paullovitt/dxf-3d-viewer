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
let selectionBox = null;
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
  if (selectionBox) selectionBox.update();
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

  if (selectionBox) {
    scene.remove(selectionBox);
    selectionBox.geometry.dispose();
    selectionBox.material.dispose();
    selectionBox = null;
  }

  selectedPart = null;
}

function setSelectedPart(part) {
  if (selectedPart === part) return;

  clearSelection();
  if (!part) return;

  selectedPart = part;
  transformControls.attach(selectedPart);

  selectionBox = new THREE.BoxHelper(selectedPart, 0x22d3ee);
  scene.add(selectionBox);
  selectionBox.update();
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
function polylineToPoints(entity) {
  if (entity.type === "LWPOLYLINE") {
    const pts = entity.vertices.map((v) => new THREE.Vector2(v.x, v.y));
    const closed = !!entity.shape || !!entity.closed || isClosedByGeometry(pts);
    return { pts, closed };
  }

  if (entity.type === "POLYLINE") {
    const pts = (entity.vertices || []).map((v) => new THREE.Vector2(v.x, v.y));
    const closed = !!entity.closed || isClosedByGeometry(pts);
    return { pts, closed };
  }

  return null;
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

function arcToPolylinePoints(entity, segmentsPerCircle = 96) {
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
  const steps = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * segmentsPerCircle));
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
  const shape = new THREE.Shape();
  shape.absarc(center.x, center.y, radius, 0, Math.PI * 2, false);

  return { shape, center, radius, usedAsHole: false };
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

function polygonAreaAbs(closedPts) {
  if (!closedPts || closedPts.length < 4) return 0;

  let area = 0;
  for (let i = 0; i < closedPts.length - 1; i++) {
    const a = closedPts[i];
    const b = closedPts[i + 1];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return Math.abs(area * 0.5);
}

function pointInPolygon(point, closedPts) {
  if (!closedPts || closedPts.length < 4) return false;

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

function assignCircularHoles(polygonShapeInfos, circles) {
  if (polygonShapeInfos.length === 0 || circles.length === 0) return;

  const polygonWithArea = polygonShapeInfos.map((info) => ({
    ...info,
    area: polygonAreaAbs(info.outline)
  }));

  for (const circle of circles) {
    const candidates = polygonWithArea
      .filter((poly) => poly.area > 0 && pointInPolygon(circle.center, poly.outline))
      .sort((a, b) => a.area - b.area);

    if (candidates.length === 0) continue;

    const target = candidates[0];
    const hole = new THREE.Path();
    hole.absarc(circle.center.x, circle.center.y, circle.radius, 0, Math.PI * 2, true);
    target.shape.holes.push(hole);
    circle.usedAsHole = true;
  }
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

function addDxfToScene(dxfText, filename, thickness, autoCenter = true, onIssue = null) {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    console.error("Erro ao parsear DXF:", filename, e);
    reportImportIssue(onIssue, `Erro ao parsear ${filename}. Veja o console (F12).`);
    return false;
  }

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.6, 0.55),
    metalness: 0.05,
    roughness: 0.85
  });

  const localGroup = new THREE.Group();
  localGroup.name = filename;

  const polygonShapeInfos = [];
  const circles = [];
  const fallbackOpenShapes = [];
  const lineEntities = [];
  const arcEntities = [];
  const entityTypeCount = new Map();

  for (const ent of (dxf.entities || [])) {
    const entityType = ent?.type || "UNKNOWN";
    entityTypeCount.set(entityType, (entityTypeCount.get(entityType) || 0) + 1);

    const circleInfo = circleToShapeInfo(ent);
    if (circleInfo) {
      circles.push(circleInfo);
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

    const shapeInfo = buildShapeInfoFromPoints(polyInfo.pts);
    if (!shapeInfo) continue;

    if (!polyInfo.closed) {
      fallbackOpenShapes.push(shapeInfo.shape);
      continue;
    }

    polygonShapeInfos.push(shapeInfo);
  }

  const segments = [];
  for (const ent of lineEntities) {
    const seg = lineToPoints(ent);
    if (seg) segments.push(seg);
  }

  for (const ent of arcEntities) {
    const arcPts = arcToPolylinePoints(ent);
    if (!arcPts || arcPts.length < 2) continue;
    for (let i = 0; i < arcPts.length - 1; i++) {
      segments.push({ a: arcPts[i], b: arcPts[i + 1] });
    }
  }

  let segmentLoops = extractClosedLoopsFromSegments(segments, 1e-4);
  if (segmentLoops.length === 0 && segments.length > 0) {
    // Some DXFs have tiny endpoint gaps; retry with relaxed snapping.
    segmentLoops = extractClosedLoopsFromSegments(segments, 1e-2);
  }
  for (const loopPts of segmentLoops) {
    const shapeInfo = buildShapeInfoFromPoints(loopPts);
    if (shapeInfo) polygonShapeInfos.push(shapeInfo);
  }

  assignCircularHoles(polygonShapeInfos, circles);

  const closedShapes = polygonShapeInfos.map((info) => info.shape);
  for (const circleInfo of circles) {
    if (!circleInfo.usedAsHole) closedShapes.push(circleInfo.shape);
  }

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
    const text = await f.text();
    const ok = addDxfToScene(text, f.name, thickness, autoCenter, (msg) => importIssues.push(msg));
    if (ok) importedCount += 1;
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
  if (selectionBox) selectionBox.update();
  renderer.render(scene, camera);
}
animate();
