from __future__ import annotations

import asyncio
import hashlib
import math
import multiprocessing
import os
import pickle
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import ezdxf
import numpy as np
from ezdxf import recover
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


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

        # Keep CUDA directories at the beginning so nvrtc is always resolvable.
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
PARSER_VERSION = "cef-backend-parse-v3-max"
CACHE_SCHEMA = 2

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
CACHE_DIR = BASE_DIR / ".cache" / "parsed"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _env_int(name: str, default: int, min_value: int = 1, max_value: int | None = None) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except Exception:
        value = int(default)
    value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def _env_float(name: str, default: float, min_value: float, max_value: float) -> float:
    try:
        value = float(str(os.getenv(name, default)).strip())
    except Exception:
        value = float(default)
    return max(min_value, min(max_value, value))


def _total_ram_bytes() -> int:
    try:
        import psutil  # type: ignore

        total = int(psutil.virtual_memory().total)
        if total > 0:
            return total
    except Exception:
        pass

    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return int(stat.ullTotalPhys)
    except Exception:
        pass

    return 8 * 1024 * 1024 * 1024


CPU_COUNT = max(1, os.cpu_count() or 1)
CPU_POOL_WORKERS = _env_int("DXF_CPU_WORKERS", CPU_COUNT, min_value=1)
CUDA_POOL_WORKERS = _env_int(
    "DXF_CUDA_WORKERS",
    CPU_COUNT,
    min_value=1,
)
RAM_CACHE_FRACTION = _env_float("DXF_CACHE_RAM_FRACTION", 0.85, 0.05, 0.95)
RAM_CACHE_MIN_MB = _env_int("DXF_CACHE_RAM_MIN_MB", 512, min_value=64)
TOTAL_RAM_BYTES = _total_ram_bytes()
RAM_CACHE_BYTES = max(RAM_CACHE_MIN_MB * 1024 * 1024, int(TOTAL_RAM_BYTES * RAM_CACHE_FRACTION))

_IS_MAIN_PROCESS = multiprocessing.current_process().name == "MainProcess"
CPU_PARSE_POOL: ProcessPoolExecutor | None = None
CUDA_PARSE_POOL: ProcessPoolExecutor | None = None
_EXECUTOR_LOCK = threading.Lock()


class _LruParsedCache:
    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max(1, int(max_bytes))
        self.total_bytes = 0
        self._store: OrderedDict[str, tuple[dict[str, Any], int]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            item = self._store.get(key)
            if item is None:
                return None
            self._store.move_to_end(key)
            return item[0]

    def put(self, key: str, value: dict[str, Any], approx_bytes: int) -> None:
        size = max(1, int(approx_bytes))
        with self._lock:
            old = self._store.pop(key, None)
            if old is not None:
                self.total_bytes -= old[1]

            self._store[key] = (value, size)
            self.total_bytes += size
            self._store.move_to_end(key)

            while self.total_bytes > self.max_bytes and self._store:
                _, (_, removed_size) = self._store.popitem(last=False)
                self.total_bytes -= removed_size

            if self.total_bytes < 0:
                self.total_bytes = 0

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "entries": len(self._store),
                "bytes": int(self.total_bytes),
                "maxBytes": int(self.max_bytes),
            }


PARSED_RAM_CACHE = _LruParsedCache(RAM_CACHE_BYTES)


def _ensure_executors() -> None:
    global CPU_PARSE_POOL, CUDA_PARSE_POOL
    if not _IS_MAIN_PROCESS:
        return

    with _EXECUTOR_LOCK:
        if CPU_PARSE_POOL is None:
            CPU_PARSE_POOL = ProcessPoolExecutor(max_workers=CPU_POOL_WORKERS)
        if CUDA_PARSE_POOL is None:
            CUDA_PARSE_POOL = ProcessPoolExecutor(max_workers=CUDA_POOL_WORKERS)


def _shutdown_executors() -> None:
    global CPU_PARSE_POOL, CUDA_PARSE_POOL
    with _EXECUTOR_LOCK:
        if CPU_PARSE_POOL is not None:
            CPU_PARSE_POOL.shutdown(wait=False, cancel_futures=True)
            CPU_PARSE_POOL = None
        if CUDA_PARSE_POOL is not None:
            CUDA_PARSE_POOL.shutdown(wait=False, cancel_futures=True)
            CUDA_PARSE_POOL = None


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _bulge_points(
    p1: tuple[float, float],
    p2: tuple[float, float],
    bulge: float,
    chord_tol: float = 0.8,
) -> list[tuple[float, float]]:
    if abs(bulge) < 1e-12:
        return [p1, p2]

    chord = _dist(p1, p2)
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
    cx = mid_x + normal_x * offset * sign
    cy = mid_y + normal_y * offset * sign
    start = math.atan2(p1[1] - cy, p1[0] - cx)
    steps = max(2, math.ceil((abs(theta) * radius) / max(chord_tol, 0.05)))

    pts = [p1]
    for i in range(1, steps + 1):
        a = start + theta * (i / steps)
        pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    pts[-1] = p2
    return pts


def _arc_points(
    center: tuple[float, float],
    radius: float,
    start_deg: float,
    end_deg: float,
    chord_tol: float = 0.8,
    compute_mode: str = "cpu",
) -> list[tuple[float, float]]:
    if radius <= 0:
        return []

    sweep = end_deg - start_deg
    while sweep <= 0:
        sweep += 360.0

    steps = max(8, math.ceil((math.pi * sweep / 180.0 * radius) / max(chord_tol, 0.05)))

    if compute_mode == "cuda" and CUDA_AVAILABLE and cp is not None:
        angles = cp.linspace(
            math.radians(start_deg),
            math.radians(start_deg + sweep),
            steps + 1,
            dtype=cp.float64,
        )
        xs = center[0] + radius * cp.cos(angles)
        ys = center[1] + radius * cp.sin(angles)
        arr = cp.stack((xs, ys), axis=1).get()
    else:
        angles = np.linspace(
            math.radians(start_deg),
            math.radians(start_deg + sweep),
            steps + 1,
            dtype=np.float64,
        )
        xs = center[0] + radius * np.cos(angles)
        ys = center[1] + radius * np.sin(angles)
        arr = np.column_stack((xs, ys))

    return [(float(x), float(y)) for x, y in arr]


def _clean_points(points: list[tuple[float, float]], tol: float = 1e-7) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in points:
        if not out or _dist(out[-1], p) > tol:
            out.append(p)
    return out


def _polyline_contour(entity: Any) -> tuple[list[tuple[float, float]], bool] | None:
    etype = entity.dxftype()
    if etype not in {"LWPOLYLINE", "POLYLINE"}:
        return None

    if etype == "LWPOLYLINE":
        raw = list(entity.get_points("xyb"))
        verts = [(float(v[0]), float(v[1]), float(v[2] if len(v) > 2 else 0.0)) for v in raw]
        closed = bool(entity.closed)
    else:
        verts = []
        for v in entity.vertices:
            loc = getattr(v.dxf, "location", None)
            if loc is None:
                continue
            bulge = float(getattr(v.dxf, "bulge", 0.0) or 0.0)
            verts.append((float(loc[0]), float(loc[1]), bulge))
        closed = bool(entity.is_closed)

    if len(verts) < 2:
        return None

    seg_count = len(verts) if closed else len(verts) - 1
    pts: list[tuple[float, float]] = [(verts[0][0], verts[0][1])]

    for i in range(seg_count):
        n = (i + 1) % len(verts)
        p1 = (verts[i][0], verts[i][1])
        p2 = (verts[n][0], verts[n][1])
        seg_pts = _bulge_points(p1, p2, verts[i][2], 0.8)
        pts.extend(seg_pts[1:])

    pts = _clean_points(pts, 1e-7)
    if closed and len(pts) > 1 and _dist(pts[0], pts[-1]) <= 1e-6:
        pts.pop()

    return pts, closed


def _spline_contour(entity: Any) -> tuple[list[tuple[float, float]], bool] | None:
    if entity.dxftype() != "SPLINE":
        return None

    pts3d: list[Any]
    try:
        pts3d = list(entity.flattening(distance=0.8))
    except Exception:
        pts3d = []

    if len(pts3d) < 2:
        cps = list(getattr(entity, "control_points", []))
        if len(cps) >= 2:
            pts3d = cps

    if len(pts3d) < 2:
        return None

    pts: list[tuple[float, float]] = []
    for p in pts3d:
        pt = (float(p[0]), float(p[1]))
        if not pts or _dist(pts[-1], pt) > 1e-7:
            pts.append(pt)

    closed = bool(entity.closed)
    if closed and len(pts) > 1 and _dist(pts[0], pts[-1]) <= 1e-6:
        pts.pop()

    return pts, closed


def _collect_contours(doc: Any, compute_mode: str = "cpu") -> list[dict[str, Any]]:
    contours: list[dict[str, Any]] = []
    msp = doc.modelspace()

    for ent in msp:
        etype = ent.dxftype()

        if etype in {"LWPOLYLINE", "POLYLINE"}:
            res = _polyline_contour(ent)
            if res is not None:
                pts, closed = res
                contours.append({"points": pts, "closed": bool(closed)})
            continue

        if etype == "LINE":
            s = getattr(ent.dxf, "start", None)
            e = getattr(ent.dxf, "end", None)
            if s is None or e is None:
                continue
            contours.append(
                {
                    "points": [(float(s[0]), float(s[1])), (float(e[0]), float(e[1]))],
                    "closed": False,
                }
            )
            continue

        if etype == "ARC":
            center = getattr(ent.dxf, "center", None)
            radius = float(getattr(ent.dxf, "radius", 0.0) or 0.0)
            start = float(getattr(ent.dxf, "start_angle", 0.0) or 0.0)
            end = float(getattr(ent.dxf, "end_angle", 0.0) or 0.0)
            if center is None or radius <= 0:
                continue
            pts = _arc_points(
                (float(center[0]), float(center[1])),
                radius,
                start,
                end,
                0.8,
                compute_mode=compute_mode,
            )
            if len(pts) >= 2:
                contours.append({"points": pts, "closed": False})
            continue

        if etype == "CIRCLE":
            center = getattr(ent.dxf, "center", None)
            radius = float(getattr(ent.dxf, "radius", 0.0) or 0.0)
            if center is None or radius <= 0:
                continue
            pts = _arc_points(
                (float(center[0]), float(center[1])),
                radius,
                0.0,
                360.0,
                0.8,
                compute_mode=compute_mode,
            )
            if len(pts) > 1 and _dist(pts[0], pts[-1]) <= 1e-6:
                pts.pop()
            if len(pts) >= 3:
                contours.append({"points": pts, "closed": True})
            continue

        if etype == "SPLINE":
            res = _spline_contour(ent)
            if res is not None:
                pts, closed = res
                if len(pts) >= (3 if closed else 2):
                    contours.append({"points": pts, "closed": bool(closed)})
            continue

    return contours


def _normalize_points_cpu(raw_pts: list[tuple[float, float]] | list[list[float]]) -> np.ndarray:
    if not raw_pts:
        return np.empty((0, 2), dtype=np.float64)

    arr = np.asarray(raw_pts, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] < 2:
        return np.empty((0, 2), dtype=np.float64)
    arr = arr[:, :2]

    finite = np.isfinite(arr).all(axis=1)
    arr = arr[finite]
    if arr.shape[0] == 0:
        return arr

    if arr.shape[0] > 1:
        delta = np.diff(arr, axis=0)
        dist2 = np.einsum("ij,ij->i", delta, delta)
        keep = np.ones(arr.shape[0], dtype=bool)
        keep[1:] = dist2 > 1e-10
        arr = arr[keep]

    return arr


def _normalize_points_cuda(raw_pts: list[tuple[float, float]] | list[list[float]]) -> np.ndarray:
    if not raw_pts or cp is None or not CUDA_AVAILABLE:
        return _normalize_points_cpu(raw_pts)

    arr = cp.asarray(raw_pts, dtype=cp.float64)
    if arr.ndim != 2 or arr.shape[1] < 2:
        return np.empty((0, 2), dtype=np.float64)
    arr = arr[:, :2]

    finite = cp.isfinite(arr).all(axis=1)
    arr = arr[finite]
    if int(arr.shape[0]) == 0:
        return np.empty((0, 2), dtype=np.float64)

    if int(arr.shape[0]) > 1:
        delta = cp.diff(arr, axis=0)
        dist2 = cp.sum(delta * delta, axis=1)
        keep = cp.concatenate((cp.array([True]), dist2 > 1e-10))
        arr = arr[keep]

    return cp.asnumpy(arr)


def _normalize_contours(contours: list[dict[str, Any]], compute_mode: str = "cpu") -> dict[str, Any] | None:
    mode = (compute_mode or "cpu").strip().lower()
    use_cuda = mode == "cuda" and CUDA_AVAILABLE and cp is not None

    valid: list[dict[str, Any]] = []
    blocks: list[np.ndarray] = []

    for c in contours:
        raw_pts = c.get("points") or []
        arr = _normalize_points_cuda(raw_pts) if use_cuda else _normalize_points_cpu(raw_pts)
        if arr.shape[0] == 0:
            continue

        closed = bool(c.get("closed")) and arr.shape[0] >= 3
        if closed and arr.shape[0] > 1:
            if math.hypot(float(arr[0, 0] - arr[-1, 0]), float(arr[0, 1] - arr[-1, 1])) <= 1e-5:
                arr = arr[:-1]

        min_pts = 3 if closed else 2
        if arr.shape[0] < min_pts:
            continue

        valid.append({"closed": closed, "arr": arr})
        blocks.append(arr)

    if not valid or not blocks:
        return None

    all_pts = np.vstack(blocks)
    if all_pts.shape[0] == 0:
        return None

    if use_cuda and cp is not None:
        pts_gpu = cp.asarray(all_pts)
        min_xy = cp.min(pts_gpu, axis=0).get()
        max_xy = cp.max(pts_gpu, axis=0).get()
        min_x = float(min_xy[0])
        min_y = float(min_xy[1])
        max_x = float(max_xy[0])
        max_y = float(max_xy[1])
    else:
        min_xy = np.min(all_pts, axis=0)
        max_xy = np.max(all_pts, axis=0)
        min_x = float(min_xy[0])
        min_y = float(min_xy[1])
        max_x = float(max_xy[0])
        max_y = float(max_xy[1])

    width = max_x - min_x
    height = max_y - min_y
    if not (width > EPS and height > EPS):
        return None

    out_contours: list[dict[str, Any]] = []
    for c in valid:
        arr = c["arr"].copy()
        arr[:, 0] -= min_x
        arr[:, 1] -= min_y
        out_contours.append(
            {
                "closed": bool(c["closed"]),
                "points": arr.tolist(),
            }
        )

    return {
        "contours": out_contours,
        "width": width,
        "height": height,
    }


def _parse_dxf_bytes(data: bytes, compute_mode: str = "cpu") -> dict[str, Any]:
    if not data:
        raise ValueError("Arquivo DXF vazio.")

    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".dxf") as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            doc = ezdxf.readfile(tmp_path)
        except Exception:
            doc, _auditor = recover.readfile(tmp_path)

        contours = _collect_contours(doc, compute_mode=compute_mode)
        normalized = _normalize_contours(contours, compute_mode=compute_mode)
        if not normalized:
            raise ValueError("Nenhum contorno valido encontrado no DXF.")
        return normalized
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _cache_file_for_hash(file_hash: str, mode: str) -> Path:
    return CACHE_DIR / f"{file_hash}-{mode}.pkl"


def _ram_cache_key(file_hash: str, mode: str) -> str:
    return f"{CACHE_SCHEMA}:{PARSER_VERSION}:{file_hash}:{mode}"


def _is_valid_parsed(parsed: Any) -> bool:
    if not isinstance(parsed, dict):
        return False
    contours = parsed.get("contours")
    width = parsed.get("width")
    height = parsed.get("height")
    return (
        isinstance(contours, list)
        and len(contours) > 0
        and isinstance(width, (int, float))
        and isinstance(height, (int, float))
        and float(width) > 0
        and float(height) > 0
    )


def _estimate_parsed_bytes(parsed: dict[str, Any]) -> int:
    try:
        return len(pickle.dumps(parsed, protocol=pickle.HIGHEST_PROTOCOL))
    except Exception:
        return max(1, len(str(parsed)))


def _load_parsed_from_disk(file_hash: str, mode: str) -> dict[str, Any] | None:
    cache_file = _cache_file_for_hash(file_hash, mode)
    if not cache_file.exists():
        return None

    try:
        with cache_file.open("rb") as fh:
            payload = pickle.load(fh)
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    if int(payload.get("schema", -1)) != CACHE_SCHEMA:
        return None
    if str(payload.get("version", "")) != PARSER_VERSION:
        return None
    parsed = payload.get("parsed")
    if not _is_valid_parsed(parsed):
        return None
    return parsed


def _save_parsed_to_disk(file_hash: str, mode: str, parsed: dict[str, Any]) -> None:
    cache_file = _cache_file_for_hash(file_hash, mode)
    payload = {
        "schema": CACHE_SCHEMA,
        "version": PARSER_VERSION,
        "parsed": parsed,
    }

    tmp_file = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, dir=str(CACHE_DIR), suffix=".tmp") as fh:
            pickle.dump(payload, fh, protocol=pickle.HIGHEST_PROTOCOL)
            tmp_file = Path(fh.name)
        os.replace(str(tmp_file), str(cache_file))
    finally:
        if tmp_file is not None and tmp_file.exists():
            try:
                tmp_file.unlink()
            except OSError:
                pass


def parse_cached_worker(data: bytes, compute_mode: str = "cpu") -> tuple[dict[str, Any], bool, str, str]:
    requested_mode = (compute_mode or "cpu").strip().lower()
    if requested_mode not in {"cpu", "cuda"}:
        requested_mode = "cpu"

    used_mode = "cuda" if requested_mode == "cuda" and CUDA_AVAILABLE else "cpu"
    file_hash = hashlib.sha1(data).hexdigest()

    parsed = _load_parsed_from_disk(file_hash, used_mode)
    if parsed is not None:
        return parsed, True, file_hash, used_mode

    parsed = _parse_dxf_bytes(data, compute_mode=used_mode)
    _save_parsed_to_disk(file_hash, used_mode, parsed)
    return parsed, False, file_hash, used_mode


async def _parse_with_executor(data: bytes, compute_mode: str) -> tuple[dict[str, Any], bool, str, str]:
    _ensure_executors()
    loop = asyncio.get_running_loop()

    requested_mode = (compute_mode or "cpu").strip().lower()
    if requested_mode not in {"cpu", "cuda"}:
        requested_mode = "cpu"

    if requested_mode == "cuda":
        executor = CUDA_PARSE_POOL
    else:
        executor = CPU_PARSE_POOL

    if executor is None:
        return parse_cached_worker(data, requested_mode)

    return await loop.run_in_executor(executor, parse_cached_worker, data, requested_mode)


def create_app() -> FastAPI:
    app = FastAPI(title="DXF CEF Backend", version="1.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def _startup() -> None:
        _ensure_executors()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        _shutdown_executors()

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        ram = PARSED_RAM_CACHE.snapshot()
        return {
            "ok": True,
            "parser": PARSER_VERSION,
            "cudaAvailable": CUDA_AVAILABLE,
            "cudaPath": CUDA_PATH_DETECTED,
            "cpuCores": CPU_COUNT,
            "cpuWorkers": CPU_POOL_WORKERS,
            "cudaWorkers": CUDA_POOL_WORKERS,
            "ramCacheEntries": ram["entries"],
            "ramCacheMB": round(ram["bytes"] / (1024 * 1024), 2),
            "ramCacheMaxMB": round(ram["maxBytes"] / (1024 * 1024), 2),
            "cacheDir": str(CACHE_DIR),
        }

    @app.post("/api/parse-dxf")
    async def parse_dxf(
        file: UploadFile = File(...),
        compute_mode: str = Form("cpu"),
    ) -> dict[str, Any]:
        filename = file.filename or "arquivo.dxf"
        if not filename.lower().endswith(".dxf"):
            raise HTTPException(status_code=400, detail="Apenas arquivos .dxf sao suportados.")

        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Arquivo vazio.")

        requested_mode = (compute_mode or "cpu").strip().lower()
        if requested_mode not in {"cpu", "cuda"}:
            requested_mode = "cpu"
        used_mode_hint = "cuda" if requested_mode == "cuda" and CUDA_AVAILABLE else "cpu"

        file_hash = hashlib.sha1(data).hexdigest()
        ram_key = _ram_cache_key(file_hash, used_mode_hint)
        parse_start = time.perf_counter()

        parsed = PARSED_RAM_CACHE.get(ram_key)
        from_cache = parsed is not None
        cache_source = "memory" if parsed is not None else "none"
        used_mode = used_mode_hint

        if parsed is None:
            disk_parsed = _load_parsed_from_disk(file_hash, used_mode_hint)
            if disk_parsed is not None:
                parsed = disk_parsed
                from_cache = True
                cache_source = "disk"
                PARSED_RAM_CACHE.put(ram_key, parsed, _estimate_parsed_bytes(parsed))

        if parsed is None:
            try:
                parsed, worker_cache_hit, file_hash, used_mode = await _parse_with_executor(data, requested_mode)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Falha no parse DXF: {exc}") from exc

            ram_key = _ram_cache_key(file_hash, used_mode)
            PARSED_RAM_CACHE.put(ram_key, parsed, _estimate_parsed_bytes(parsed))

            from_cache = bool(worker_cache_hit)
            cache_source = "disk" if worker_cache_hit else "none"

        parse_ms = (time.perf_counter() - parse_start) * 1000.0
        ram = PARSED_RAM_CACHE.snapshot()

        return {
            "ok": True,
            "fileName": filename,
            "fileHash": file_hash,
            "fromCache": from_cache,
            "cacheSource": cache_source,
            "requestedMode": requested_mode,
            "usedMode": used_mode,
            "cudaAvailable": CUDA_AVAILABLE,
            "parseMs": round(parse_ms, 2),
            "ramCacheEntries": ram["entries"],
            "ramCacheMB": round(ram["bytes"] / (1024 * 1024), 2),
            "parsed": parsed,
        }

    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.server:app", host="127.0.0.1", port=5173, reload=False)
