#!/usr/bin/env python3
"""Private production-build acceptance; no fixture route is added to the source tree."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
REPORT_PARENT = Path(os.environ.get("EDU08_REPORT_DIR", tempfile.gettempdir())).resolve()
REPORT_PARENT.mkdir(parents=True, exist_ok=True)
OUT = Path(tempfile.mkdtemp(prefix="editor-acceptance-", dir=REPORT_PARENT))
WORK = Path(tempfile.mkdtemp(prefix="edu08-source-"))
SOURCE = WORK / "source"
SOURCE.mkdir()
HOME = OUT / "home"
HOME.mkdir()
ENV = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ", "SystemRoot") if key in os.environ}
ENV.update(HOME=str(HOME), USERPROFILE=str(HOME), XDG_CONFIG_HOME=str(HOME / "config"), XDG_CACHE_HOME=str(HOME / "cache"), NEXT_TELEMETRY_DISABLED="1", CI="1", VERCEL="1")
if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    ENV["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["PLAYWRIGHT_BROWSERS_PATH"]
NODE = shutil.which("node")
if not NODE:
    raise RuntimeError("Node is required")

# Explicit owned untracked files support the local pre-commit gate; CI uses the
# same tracked files. Never copy arbitrary untracked files or environment files.
EXTRAS = ["e2e/fixtures/editor-matrix-runtime.tsx", "e2e/acceptance/editor-persistence-matrix.spec.ts", "scripts/test-editor-acceptance.py"]
SELECTED = ["tests/classroom-interaction.spec.ts", "tests/stage-cross-tab.spec.ts", "acceptance/editor-persistence-matrix.spec.ts"]
summary = {"status": "incomplete", "source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "phases": {}, "browserExpected": 20, "unitExpected": 9, "buildMode": "production client; existing VERCEL=1 non-standalone configuration (not packaging acceptance)"}


def stop(child):
    if child.poll() is not None:
        return
    # Only the process/group created by this invocation; no ambient PID/profile.
    if os.name == "posix":
        os.killpg(child.pid, signal.SIGTERM)
    else:
        child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(child.pid, signal.SIGKILL)
        else:
            child.kill()
        child.wait(timeout=5)


def run(label, args, timeout):
    start = time.monotonic()
    with (OUT / (label + ".log")).open("w") as log:
        child = subprocess.Popen(args, cwd=SOURCE, env=ENV, stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name == "posix")
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            summary["phases"][label] = {"timeout": True, "durationSeconds": time.monotonic() - start}
            raise
        finally:
            stop(child)
    summary["phases"][label] = {"exitCode": code, "durationSeconds": time.monotonic() - start}
    if code != 0:
        raise RuntimeError(label + " failed; see phase log")


def verify_junit(path, expected):
    tree = ET.parse(path).getroot()
    cases = tree.findall(".//testcase")
    if len(cases) != expected or any(case.find(tag) is not None for case in cases for tag in ("failure", "error", "skipped")):
        raise RuntimeError("JUnit count/failure/skip mismatch")


server = None
try:
    files = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    manifest = {}
    for name in sorted(set(files + EXTRAS)):
        if not name or any(part.startswith(".env") for part in Path(name).parts):
            continue
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError("Expected regular tracked source: " + name)
        target = SOURCE / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    dependencies = (ROOT / "node_modules").resolve(strict=True)
    lock = ROOT / "pnpm-lock.yaml"
    dependency_lock = dependencies.parent / "pnpm-lock.yaml"
    if not dependency_lock.is_file() or dependency_lock.read_bytes() != lock.read_bytes():
        raise RuntimeError("Dependency source lock differs from the selected repository")
    (SOURCE / "node_modules").symlink_to(dependencies, target_is_directory=True)
    route = SOURCE / "app/edu08-editor-matrix/page.tsx"
    if route.exists():
        raise RuntimeError("Fixture route must not already be a product route")
    route.parent.mkdir(parents=True)
    route.write_text("'use client';\nexport { default } from '@/e2e/fixtures/editor-matrix-runtime';\n")
    (OUT / "source-hashes.json").write_text(json.dumps(manifest, indent=2) + "\n")
    summary["lockSha256"] = hashlib.sha256(lock.read_bytes()).hexdigest()
    summary["nodeVersion"] = subprocess.check_output([NODE, "--version"], text=True).strip()
    run("unit", [NODE, str(SOURCE / "node_modules/vitest/vitest.mjs"), "run", "tests/store/richtext-ownership.test.tsx", "tests/store/richtext-scene-owner.test.tsx", "--reporter=json", "--reporter=junit", "--outputFile.json=" + str(OUT / "unit.json"), "--outputFile.junit=" + str(OUT / "unit.xml")], 90)
    unit = json.loads((OUT / "unit.json").read_text())
    if not unit["success"] or unit["numTotalTests"] != 9 or unit["numPassedTests"] != 9:
        raise RuntimeError("Unit report count/status mismatch")
    verify_junit(OUT / "unit.xml", 9)
    run("build", [NODE, str(SOURCE / "node_modules/next/dist/bin/next"), "build", "--webpack"], 360)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    base = "http://127.0.0.1:" + str(port)
    config = {"testDir": str(SOURCE / "e2e"), "testMatch": ["**/" + name for name in SELECTED], "forbidOnly": True, "retries": 0, "workers": 1, "timeout": 30000, "reporter": [["json", {"outputFile": str(OUT / "browser.json")}], ["junit", {"outputFile": str(OUT / "browser.xml")}]], "outputDir": str(OUT / "artifacts"), "use": {"baseURL": base, "headless": True, "browserName": "chromium", "screenshot": "only-on-failure", "trace": "retain-on-failure", "launchOptions": {"args": ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"]}}}
    config_path = OUT / "playwright.config.cjs"
    config_path.write_text("module.exports=" + json.dumps(config))
    with (OUT / "server.log").open("w") as server_log:
        server = subprocess.Popen([NODE, str(SOURCE / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", str(port)], cwd=SOURCE, env=ENV, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=os.name == "posix")
        ready = False
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("Owned server exited before readiness")
            try:
                with urllib.request.urlopen(base + "/edu08-editor-matrix", timeout=1) as response:
                    ready = response.status == 200
            except (OSError, TimeoutError):
                pass
            if ready:
                break
            time.sleep(0.1)
        if not ready or server.poll() is not None:
            raise RuntimeError("Owned server readiness failed")
        run("browser", [NODE, str(SOURCE / "node_modules/@playwright/test/cli.js"), "test", "--config", str(config_path)], 600)
    browser = json.loads((OUT / "browser.json").read_text())
    if browser.get("errors") or browser["stats"]["expected"] != 20 or any(browser["stats"][key] != 0 for key in ("unexpected", "flaky", "skipped")):
        raise RuntimeError("Browser report count/status mismatch")
    verify_junit(OUT / "browser.xml", 20)
    summary["status"] = "passed"
except Exception as error:
    summary["failureType"] = type(error).__name__
    summary["failureReason"] = str(error)
    raise
finally:
    if server is not None:
        stop(server)
    shutil.rmtree(WORK)
    summary["privateSourceRemoved"] = not WORK.exists()
    (OUT / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(OUT, flush=True)
