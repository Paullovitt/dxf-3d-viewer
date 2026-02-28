from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import uvicorn

from backend.server import app

HOST = "127.0.0.1"
PORT = 5173
URL = f"http://{HOST}:{PORT}"


def _maybe_relaunch_with_py39() -> None:
    if sys.version_info[:2] == (3, 9):
        return
    if os.getenv("DXF_RELAUNCHED_PY39") == "1":
        return

    py_launcher = shutil.which("py")
    if not py_launcher:
        return

    script = str(Path(__file__).resolve())
    env = os.environ.copy()
    env["DXF_RELAUNCHED_PY39"] = "1"

    try:
        code = subprocess.call([py_launcher, "-3.9", script], cwd=str(Path(__file__).resolve().parent), env=env)
    except Exception:
        return

    if code == 0:
        raise SystemExit(0)


def _wait_for_server(host: str, port: int, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _start_backend() -> tuple[uvicorn.Server, threading.Thread]:
    config = uvicorn.Config(app=app, host=HOST, port=PORT, log_level="warning", workers=1)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    return server, thread


def _run_cef(url: str) -> None:
    from cefpython3 import cefpython as cef

    sys.excepthook = cef.ExceptHook
    cache_path = Path(__file__).with_name(".cef_cache")
    cache_path.mkdir(parents=True, exist_ok=True)

    cef.Initialize(settings={"cache_path": str(cache_path), "persist_session_cookies": True})
    cef.CreateBrowserSync(url=url, window_title="DXF 3D Viewer - Native Backend")
    cef.MessageLoop()
    cef.Shutdown()


def _chrome_candidates() -> list[Path]:
    out: list[Path] = []
    local_app = os.getenv("LOCALAPPDATA", "")
    pf = os.getenv("PROGRAMFILES", "")
    pf86 = os.getenv("PROGRAMFILES(X86)", "")

    if local_app:
        out.append(Path(local_app) / "Google" / "Chrome" / "Application" / "chrome.exe")
    if pf:
        out.append(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe")
    if pf86:
        out.append(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe")

    for p in out:
        if p.exists():
            return [p]
    return []


def _run_google_chrome(url: str) -> None:
    candidates = _chrome_candidates()
    if not candidates:
        raise RuntimeError("Google Chrome nao encontrado.")

    chrome = candidates[0]
    proc = subprocess.Popen([str(chrome), f"--app={url}", "--disable-extensions"])
    proc.wait()


def _run_playwright(url: str) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        subprocess.run([sys.executable, "-m", "pip", "install", "playwright"], check=True)
        from playwright.sync_api import sync_playwright

    def _open_once() -> None:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=False,
                args=[f"--app={url}", "--disable-backgrounding-occluded-windows"],
            )
            context = browser.new_context(no_viewport=True)
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_event("close")
            context.close()
            browser.close()

    try:
        _open_once()
        return
    except Exception as exc:
        msg = str(exc).lower()
        needs_install = (
            "executable doesn't exist" in msg
            or "browser has not been downloaded" in msg
            or "playwright install" in msg
        )
        if not needs_install:
            raise

    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)
    _open_once()


def _run_desktop(url: str) -> None:
    engine = str(os.getenv("DXF_DESKTOP_ENGINE", "auto")).strip().lower()
    errors: list[str] = []

    try_chrome = engine in {"auto", "chrome"}
    if try_chrome:
        try:
            _run_google_chrome(url)
            return
        except Exception as exc:
            errors.append(f"Chrome: {exc}")
            if engine == "chrome":
                raise

    try_cef = engine in {"auto", "cef"}
    if try_cef:
        try:
            _run_cef(url)
            return
        except Exception as exc:
            errors.append(f"CEF: {exc}")
            if engine == "cef":
                raise

    try:
        _run_playwright(url)
        return
    except Exception as exc:
        errors.append(f"Playwright: {exc}")

    details = " | ".join(errors) if errors else "sem detalhes"
    raise RuntimeError(f"Falha ao abrir desktop embedded browser: {details}")


def main() -> None:
    _maybe_relaunch_with_py39()

    server, thread = _start_backend()
    if not _wait_for_server(HOST, PORT):
        server.should_exit = True
        thread.join(timeout=3.0)
        raise RuntimeError(f"Backend nao iniciou em {URL}")

    try:
        _run_desktop(URL)
    finally:
        server.should_exit = True
        thread.join(timeout=5.0)


if __name__ == "__main__":
    main()
