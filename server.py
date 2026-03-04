from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import struct
import tempfile
import threading
import time
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import ezdxf

try:
    import cadquery as cq
except Exception:
    cq = None


def _configure_cuda_env() -> str:
    candidates: list[Path] = []

    env_cuda = str(os.environ.get("CUDA_PATH", "")).strip()
    if env_cuda:
        candidates.append(Path(env_cuda))

    base = Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA")
    if base.exists():
        try:
            versions = sorted(
                [p for p in base.iterdir() if p.is_dir() and p.name.lower().startswith("v")],
                key=lambda p: p.name.lower(),
                reverse=True,
            )
            candidates.extend(versions)
        except Exception:
            pass

    seen: set[str] = set()
    ordered: list[Path] = []
    for c in candidates:
        key = str(c).lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(c)

    current_path = os.environ.get("PATH", "")
    path_parts = [p for p in current_path.split(os.pathsep) if p]

    for root in ordered:
        bin_dir = root / "bin"
        libnvvp_dir = root / "libnvvp"
        if not bin_dir.exists():
            continue

        root_s = str(root)
        bin_s = str(bin_dir)
        lib_s = str(libnvvp_dir)

        new_path_parts: list[str] = []
        if bin_s not in path_parts:
            new_path_parts.append(bin_s)
        if libnvvp_dir.exists() and lib_s not in path_parts:
            new_path_parts.append(lib_s)
        new_path_parts.extend(path_parts)
        os.environ["PATH"] = os.pathsep.join(new_path_parts)

        if not env_cuda:
            os.environ["CUDA_PATH"] = root_s
        return root_s

    return ""


CUDA_PATH_DETECTED = _configure_cuda_env()

try:
    import cupy as cp  # type: ignore

    _cuda_ok = False
    try:
        _cuda_ok = cp.cuda.runtime.getDeviceCount() > 0
    except Exception:
        _cuda_ok = False
    CUDA_AVAILABLE = bool(_cuda_ok)
except Exception:
    cp = None
    CUDA_AVAILABLE = False

EPS = 1e-6
CHORD_TOL = 0.8

PARSED_CACHE_MAX_ENTRIES = 64
PARSED_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
PARSED_CACHE_LOCK = threading.Lock()


def dist(a: list[float], b: list[float]) -> float:
    return math.hypot(float(a[0]) - float(b[0]), float(a[1]) - float(b[1]))


def parse_num(value: Any, fallback: float = 0.0) -> float:
    try:
        n = float(value)
        return n if math.isfinite(n) else fallback
    except Exception:
        return fallback


def normalize_compute_mode(raw_mode: Any) -> str:
    mode = str(raw_mode or "cpu").strip().lower()
    if mode not in {"cpu", "cuda"}:
        mode = "cpu"
    if mode == "cuda" and not CUDA_AVAILABLE:
        return "cpu"
    return mode


def arc_points(
    center: list[float],
    radius: float,
    start_deg: float,
    end_deg: float,
    chord_tol: float = CHORD_TOL,
    compute_mode: str = "cpu",
) -> list[list[float]]:
    if radius <= 0:
        return []
    sweep = end_deg - start_deg
    while sweep <= 0:
        sweep += 360.0
    steps = max(8, math.ceil((math.pi * sweep / 180.0 * radius) / max(chord_tol, 0.05)))
    mode = normalize_compute_mode(compute_mode)

    if mode == "cuda" and cp is not None and CUDA_AVAILABLE:
        angles = cp.linspace(
            math.radians(start_deg),
            math.radians(start_deg + sweep),
            steps + 1,
            dtype=cp.float64,
        )
        xs = center[0] + radius * cp.cos(angles)
        ys = center[1] + radius * cp.sin(angles)
        arr = cp.stack((xs, ys), axis=1).get()
        return [[float(v[0]), float(v[1])] for v in arr]

    points: list[list[float]] = []
    for i in range(steps + 1):
        angle = (start_deg + sweep * (i / steps)) * math.pi / 180.0
        points.append([center[0] + radius * math.cos(angle), center[1] + radius * math.sin(angle)])
    return points


def bulge_points(p1: list[float], p2: list[float], bulge: float, chord_tol: float = CHORD_TOL) -> list[list[float]]:
    if abs(bulge) < 1e-12:
        return [p1, p2]
    chord = dist(p1, p2)
    if chord < EPS:
        return [p1, p2]
    theta = 4.0 * math.atan(bulge)
    sin_half = math.sin(abs(theta) / 2.0)
    if abs(sin_half) < EPS:
        return [p1, p2]
    radius = chord / (2.0 * sin_half)
    mid_x = (p1[0] + p2[0]) * 0.5
    mid_y = (p1[1] + p2[1]) * 0.5
    normal_x = -(p2[1] - p1[1]) / chord
    normal_y = (p2[0] - p1[0]) / chord
    offset = math.sqrt(max(radius * radius - (chord * 0.5) ** 2, 0.0))
    sign = 1.0 if bulge > 0 else -1.0
    center_x = mid_x + normal_x * offset * sign
    center_y = mid_y + normal_y * offset * sign
    start_angle = math.atan2(p1[1] - center_y, p1[0] - center_x)
    steps = max(2, math.ceil((abs(theta) * radius) / max(chord_tol, 0.05)))
    points = [p1]
    for i in range(1, steps + 1):
        a = start_angle + theta * (i / steps)
        points.append([center_x + radius * math.cos(a), center_y + radius * math.sin(a)])
    points[-1] = p2
    return points


def polyline_length(points: list[list[float]], closed: bool = False) -> float:
    if len(points) < 2:
        return 0.0
    length = 0.0
    for i in range(1, len(points)):
        length += dist(points[i - 1], points[i])
    if closed and len(points) > 2:
        length += dist(points[-1], points[0])
    return length


def compact_loop_points(points: list[list[float]], tol: float) -> list[list[float]]:
    out: list[list[float]] = []
    for raw in points:
        x = parse_num(raw[0])
        y = parse_num(raw[1])
        if not out or dist(out[-1], [x, y]) > tol:
            out.append([x, y])
    if len(out) > 1 and dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def contour_bounds(points: list[list[float]]) -> dict[str, float] | None:
    if not points:
        return None
    xs = [parse_num(p[0]) for p in points]
    ys = [parse_num(p[1]) for p in points]
    return {
        "minX": min(xs),
        "minY": min(ys),
        "maxX": max(xs),
        "maxY": max(ys),
    }


def bboxes_near(a: dict[str, float] | None, b: dict[str, float] | None, gap: float) -> bool:
    if not a or not b:
        return False
    return not (
        a["maxX"] + gap < b["minX"]
        or b["maxX"] + gap < a["minX"]
        or a["maxY"] + gap < b["minY"]
        or b["maxY"] + gap < a["minY"]
    )


def clean_imported_contours(contours: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for contour in contours:
        pts: list[list[float]] = []
        for raw in contour.get("points", []):
            x = parse_num(raw[0])
            y = parse_num(raw[1])
            if not pts or dist(pts[-1], [x, y]) > 1e-5:
                pts.append([x, y])
        closed = bool(contour.get("closed"))
        if closed and len(pts) > 2 and dist(pts[0], pts[-1]) <= 1e-5:
            pts.pop()
        min_pts = 3 if closed else 2
        if len(pts) < min_pts:
            continue
        if polyline_length(pts, closed) <= 0.10:
            continue
        cleaned.append({"points": pts, "closed": closed})

    if len(cleaned) < 2:
        return cleaned

    def stitch_contours_for_continuity(input_contours: list[dict[str, Any]], join_tol: float, close_tol: float) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        open_pool: list[list[list[float]]] = []
        dedup_tol = max(1e-5, min(join_tol * 0.35, 0.08))

        for contour in input_contours:
            pts = compact_loop_points(contour.get("points", []), dedup_tol)
            if len(pts) < 2:
                continue
            closed = bool(contour.get("closed"))
            if not closed and len(pts) >= 3 and dist(pts[0], pts[-1]) <= close_tol:
                closed = True
            if closed:
                if len(pts) > 2 and dist(pts[0], pts[-1]) <= close_tol:
                    pts.pop()
                if len(pts) >= 3:
                    out.append({"points": pts, "closed": True})
            else:
                open_pool.append(pts)

        while open_pool:
            chain = open_pool.pop()
            grew = True
            while grew:
                grew = False
                c_start = chain[0]
                c_end = chain[-1]
                best: dict[str, Any] | None = None
                for i, pts in enumerate(open_pool):
                    if len(pts) < 2:
                        continue
                    p_start = pts[0]
                    p_end = pts[-1]
                    options = [
                        {"d": dist(c_end, p_start), "attach_end": True, "reverse": False, "idx": i},
                        {"d": dist(c_end, p_end), "attach_end": True, "reverse": True, "idx": i},
                        {"d": dist(c_start, p_end), "attach_end": False, "reverse": False, "idx": i},
                        {"d": dist(c_start, p_start), "attach_end": False, "reverse": True, "idx": i},
                    ]
                    for opt in options:
                        if opt["d"] > join_tol:
                            continue
                        if best is None or opt["d"] < best["d"]:
                            best = opt
                if not best:
                    break
                picked = open_pool.pop(best["idx"])
                seg = list(reversed(picked)) if best["reverse"] else list(picked)
                if best["attach_end"]:
                    if seg and dist(chain[-1], seg[0]) <= join_tol:
                        seg = seg[1:]
                    chain = chain + seg
                else:
                    if seg and dist(seg[-1], chain[0]) <= join_tol:
                        seg = seg[:-1]
                    chain = seg + chain
                grew = True

            closed = len(chain) >= 3 and dist(chain[0], chain[-1]) <= close_tol
            if closed:
                chain = chain[:-1]
            if len(chain) >= (3 if closed else 2):
                out.append({"points": chain, "closed": closed})

        return out

    bounds = [contour_bounds(c["points"]) for c in cleaned]
    min_x = min(b["minX"] for b in bounds if b)
    min_y = min(b["minY"] for b in bounds if b)
    max_x = max(b["maxX"] for b in bounds if b)
    max_y = max(b["maxY"] for b in bounds if b)
    if not (max_x > min_x + EPS and max_y > min_y + EPS):
        return cleaned

    span_w = max_x - min_x
    span_h = max_y - min_y
    min_side = max(1.0, min(span_w, span_h))
    stitch_join = max(0.03, min(0.45, min_side * 0.0018))
    stitch_close = max(stitch_join * 1.35, 0.05)
    stitched = stitch_contours_for_continuity(cleaned, stitch_join, stitch_close)
    merged = stitched if stitched else cleaned
    if len(merged) < 2:
        return merged

    m_bounds = [contour_bounds(c["points"]) for c in merged]
    min_x = min(b["minX"] for b in m_bounds if b)
    min_y = min(b["minY"] for b in m_bounds if b)
    max_x = max(b["maxX"] for b in m_bounds if b)
    max_y = max(b["maxY"] for b in m_bounds if b)
    if not (max_x > min_x + EPS and max_y > min_y + EPS):
        return merged

    m_span_w = max_x - min_x
    m_span_h = max_y - min_y
    m_min_side = max(1.0, min(m_span_w, m_span_h))
    join_gap = max(0.5, min(20.0, m_min_side * 0.05))

    used = [False] * len(merged)
    groups: list[dict[str, Any]] = []
    for i in range(len(merged)):
        if used[i]:
            continue
        used[i] = True
        stack = [i]
        idxs: list[int] = []
        g_min_x = 1e30
        g_min_y = 1e30
        g_max_x = -1e30
        g_max_y = -1e30
        total_len = 0.0
        while stack:
            idx = stack.pop()
            idxs.append(idx)
            b = m_bounds[idx]
            c = merged[idx]
            total_len += polyline_length(c["points"], bool(c["closed"]))
            g_min_x = min(g_min_x, b["minX"])
            g_min_y = min(g_min_y, b["minY"])
            g_max_x = max(g_max_x, b["maxX"])
            g_max_y = max(g_max_y, b["maxY"])
            for j in range(len(merged)):
                if used[j]:
                    continue
                if not bboxes_near(m_bounds[idx], m_bounds[j], join_gap):
                    continue
                used[j] = True
                stack.append(j)
        area = max(EPS, (g_max_x - g_min_x) * (g_max_y - g_min_y))
        groups.append({"idxs": idxs, "area": area, "score": total_len * math.sqrt(area)})

    if len(groups) < 2:
        return merged

    groups.sort(key=lambda x: x["score"], reverse=True)
    main = groups[0]
    alt = groups[1]
    area_all = max(EPS, m_span_w * m_span_h)
    keep_only_main = (
        (main["score"] > alt["score"] * 2.4 and main["area"] > alt["area"] * 1.8)
        or (area_all > main["area"] * 1.45 and main["score"] > alt["score"] * 1.6)
    )
    if not keep_only_main:
        return merged
    return [merged[idx] for idx in main["idxs"]]


def normalize_contours(contours: list[dict[str, Any]]) -> dict[str, Any] | None:
    cleaned = clean_imported_contours(contours)
    if not cleaned:
        cleaned = contours

    all_points = [p for contour in cleaned for p in contour.get("points", [])]
    if not all_points:
        return None

    min_x = min(parse_num(p[0]) for p in all_points)
    min_y = min(parse_num(p[1]) for p in all_points)
    max_x = max(parse_num(p[0]) for p in all_points)
    max_y = max(parse_num(p[1]) for p in all_points)

    shifted = []
    for contour in cleaned:
        pts = contour.get("points", [])
        shifted.append(
            {
                "closed": bool(contour.get("closed")),
                "points": [[parse_num(p[0]) - min_x, parse_num(p[1]) - min_y] for p in pts],
            }
        )

    return {"contours": shifted, "width": max_x - min_x, "height": max_y - min_y}


def _parsed_cache_get(key: str) -> dict[str, Any] | None:
    with PARSED_CACHE_LOCK:
        value = PARSED_CACHE.get(key)
        if value is None:
            return None
        PARSED_CACHE.move_to_end(key)
        return value


def _parsed_cache_put(key: str, parsed: dict[str, Any]) -> None:
    with PARSED_CACHE_LOCK:
        old = PARSED_CACHE.pop(key, None)
        if old is not None:
            pass
        PARSED_CACHE[key] = parsed
        PARSED_CACHE.move_to_end(key)
        while len(PARSED_CACHE) > PARSED_CACHE_MAX_ENTRIES:
            PARSED_CACHE.popitem(last=False)


def parse_dxf_text(text: str, compute_mode: str = "cpu") -> dict[str, Any]:
    mode = normalize_compute_mode(compute_mode)
    normalized_text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    doc = ezdxf.read(io.StringIO(normalized_text))
    contours: list[dict[str, Any]] = []

    for entity in doc.modelspace():
        etype = entity.dxftype()
        if etype == "LINE":
            start = entity.dxf.start
            end = entity.dxf.end
            contours.append(
                {
                    "points": [[float(start.x), float(start.y)], [float(end.x), float(end.y)]],
                    "closed": False,
                }
            )
        elif etype == "ARC":
            center = entity.dxf.center
            points = arc_points(
                [float(center.x), float(center.y)],
                float(entity.dxf.radius),
                float(entity.dxf.start_angle),
                float(entity.dxf.end_angle),
                CHORD_TOL,
                compute_mode=mode,
            )
            if len(points) > 1:
                contours.append({"points": points, "closed": False})
        elif etype == "CIRCLE":
            center = entity.dxf.center
            points = arc_points(
                [float(center.x), float(center.y)],
                float(entity.dxf.radius),
                0.0,
                360.0,
                CHORD_TOL,
                compute_mode=mode,
            )
            if points and dist(points[0], points[-1]) < 1e-6:
                points.pop()
            if len(points) >= 3:
                contours.append({"points": points, "closed": True})
        elif etype == "LWPOLYLINE":
            raw = [(float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 0.0) for p in entity.get_points("xyb")]
            if len(raw) < 2:
                continue
            closed = bool(entity.closed)
            seg_count = len(raw) if closed else len(raw) - 1
            points = [[raw[0][0], raw[0][1]]]
            for i in range(seg_count):
                j = (i + 1) % len(raw)
                p1 = [raw[i][0], raw[i][1]]
                p2 = [raw[j][0], raw[j][1]]
                points.extend(bulge_points(p1, p2, raw[i][2], CHORD_TOL)[1:])
            if closed and dist(points[0], points[-1]) < 1e-6:
                points.pop()
            contours.append({"points": points, "closed": closed})
        elif etype == "POLYLINE":
            raw = []
            for vertex in entity.vertices:
                loc = vertex.dxf.location
                raw.append(
                    (
                        float(loc.x),
                        float(loc.y),
                        float(getattr(vertex.dxf, "bulge", 0.0)),
                    )
                )
            if len(raw) < 2:
                continue
            closed = bool(entity.is_closed)
            seg_count = len(raw) if closed else len(raw) - 1
            points = [[raw[0][0], raw[0][1]]]
            for i in range(seg_count):
                j = (i + 1) % len(raw)
                p1 = [raw[i][0], raw[i][1]]
                p2 = [raw[j][0], raw[j][1]]
                points.extend(bulge_points(p1, p2, raw[i][2], CHORD_TOL)[1:])
            if closed and dist(points[0], points[-1]) < 1e-6:
                points.pop()
            contours.append({"points": points, "closed": closed})

    parsed = normalize_contours(contours)
    if not parsed:
        raise ValueError("Nenhum contorno valido encontrado no DXF.")
    return parsed


def parse_dxf_text_cached(text: str, compute_mode: str = "cpu") -> tuple[dict[str, Any], bool, str]:
    mode = normalize_compute_mode(compute_mode)
    cache_key = hashlib.sha1((mode + "\n" + text).encode("utf-8", "ignore")).hexdigest()
    cached = _parsed_cache_get(cache_key)
    if cached is not None:
        return cached, True, mode

    parsed = parse_dxf_text(text, compute_mode=mode)
    _parsed_cache_put(cache_key, parsed)
    return parsed, False, mode


def parse_step_text_to_stl_base64(text: str, filename: str = "arquivo.step") -> dict[str, Any]:
    if cq is None:
        raise RuntimeError("STEP parser indisponivel no servidor local")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Campo 'text' vazio.")

    safe_stem = Path(str(filename or "arquivo.step")).stem or "arquivo"
    temp_step_path: Path | None = None
    temp_stl_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".step",
            prefix=f"step_import_{safe_stem}_",
            delete=False,
            encoding="utf-8",
            newline="\n",
        ) as tmp_step:
            tmp_step.write(text)
            temp_step_path = Path(tmp_step.name)

        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=".stl",
            prefix=f"step_mesh_{safe_stem}_",
            delete=False,
        ) as tmp_stl:
            temp_stl_path = Path(tmp_stl.name)

        model = cq.importers.importStep(str(temp_step_path))
        cq.exporters.export(model, str(temp_stl_path))

        stl_bytes = temp_stl_path.read_bytes()
        if not stl_bytes:
            raise ValueError("Falha ao gerar STL a partir do STEP.")

        triangle_count = 0
        if len(stl_bytes) >= 84:
            triangle_count = int(struct.unpack("<I", stl_bytes[80:84])[0])

        return {
            "format": "stl_base64",
            "data": base64.b64encode(stl_bytes).decode("ascii"),
            "triangle_count": triangle_count,
        }
    finally:
        if temp_step_path and temp_step_path.exists():
            try:
                os.remove(temp_step_path)
            except Exception:
                pass
        if temp_stl_path and temp_stl_path.exists():
            try:
                os.remove(temp_stl_path)
            except Exception:
                pass


class ViewerHandler(SimpleHTTPRequestHandler):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Allow", "GET,POST,OPTIONS")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path not in ("/api/parse-dxf", "/api/parse-step"):
            self.send_error(404, "Endpoint nao encontrado.")
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            self._send_json({"ok": False, "error": "JSON invalido."}, status=400)
            return

        text = payload.get("text")
        filename = str(payload.get("filename") or ("arquivo.step" if path == "/api/parse-step" else "arquivo.dxf"))
        if not isinstance(text, str) or not text.strip():
            self._send_json({"ok": False, "error": "Campo 'text' vazio."}, status=400)
            return

        if path == "/api/parse-step":
            try:
                mesh = parse_step_text_to_stl_base64(text, filename)
                self._send_json({"ok": True, "filename": filename, "mesh": mesh})
            except Exception as exc:
                self._send_json({"ok": False, "filename": filename, "error": str(exc)})
            return

        try:
            requested_mode = normalize_compute_mode(payload.get("compute_mode", "cpu"))
            parse_start = time.perf_counter()
            parsed, from_cache, used_mode = parse_dxf_text_cached(text, requested_mode)
            parse_ms = (time.perf_counter() - parse_start) * 1000.0
            self._send_json(
                {
                    "ok": True,
                    "filename": filename,
                    "parsed": parsed,
                    "requestedMode": requested_mode,
                    "usedMode": used_mode,
                    "fromCache": bool(from_cache),
                    "cudaAvailable": CUDA_AVAILABLE,
                    "cudaPath": CUDA_PATH_DETECTED,
                    "parseMs": round(parse_ms, 2),
                }
            )
        except Exception as exc:
            self._send_json({"ok": False, "filename": filename, "error": str(exc)})


def make_handler(directory: Path):
    class BoundHandler(ViewerHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

    return BoundHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="DXF/STEP 3D viewer server (static + Python parse APIs)")
    parser.add_argument("--host", default="127.0.0.1", help="Host para bind (padrao: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5173, help="Porta HTTP (padrao: 5173)")
    parser.add_argument("--dir", default=".", help="Diretorio raiz de arquivos estaticos")
    args = parser.parse_args()

    root = Path(args.dir).resolve()
    handler = make_handler(root)
    server = ThreadingHTTPServer((args.host, args.port), handler)

    print(f"Servidor ativo em http://{args.host}:{args.port}")
    print("API DXF Python: POST /api/parse-dxf")
    if CUDA_AVAILABLE:
        print(f"DXF CUDA: disponivel ({CUDA_PATH_DETECTED or 'CUDA_PATH'})")
    else:
        print("DXF CUDA: indisponivel (fallback CPU automatico)")
    if cq is None:
        print("API STEP Python: indisponivel (cadquery nao instalado)")
    else:
        print("API STEP Python: POST /api/parse-step")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
