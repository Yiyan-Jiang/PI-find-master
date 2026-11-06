"""用户手动调用的 Desktop 开发插件安装辅助；不关闭桌面、不安装依赖。"""
import argparse
import datetime
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop-root", required=True, type=pathlib.Path)
    parser.add_argument("--plugin-root", required=True, type=pathlib.Path)
    parser.add_argument("--host", type=pathlib.Path, help="显式指定 host 可执行文件")
    parser.add_argument("--data-dir", type=pathlib.Path)
    parser.add_argument("--builtin-plugins-dir", type=pathlib.Path)
    return parser.parse_args()


def locate_host(desktop, explicit):
    if explicit:
        host = explicit.resolve(strict=True)
        if not host.is_file():
            raise RuntimeError("Host 必须是文件")
        return host
    names = ("pi-desktop-host-core.exe", "pi-desktop-host-core")
    for base in (desktop / "app/resources/bin", desktop / "resources/bin", desktop / "bin"):
        for name in names:
            candidate = base / name
            if candidate.is_file():
                return candidate.resolve()
    for name in names:
        candidate = shutil.which(name)
        if candidate:
            return pathlib.Path(candidate).resolve()
    raise RuntimeError("找不到 Desktop host，请用 --host 显式指定")


def main():
    args = arguments()
    desktop = args.desktop_root.resolve(strict=True)
    root = args.plugin_root.resolve(strict=True)
    if not (root / "manifest.json").is_file():
        raise RuntimeError("--plugin-root 缺少 manifest.json")
    data = (args.data_dir or desktop / "data").resolve(strict=True)
    builtin = (args.builtin_plugins_dir or desktop / "app/resources/plugins").resolve(strict=True)
    host = locate_host(desktop, args.host)
    database = data / "pi.sqlite"
    if not database.is_file():
        raise RuntimeError("找不到现有 pi.sqlite；不会创建新 Desktop 数据库")
    local = root / ".local"
    local.mkdir(exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = local / "desktop-backups" / stamp
    backup.mkdir(parents=True)
    # SQLite backup API 可一致地备份数据库；脚本不负责关闭运行中的桌面。
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(backup / "pi.sqlite") as target:
            source.backup(target)
    env = dict(os.environ, PI_DESKTOP_DATA_DIR=str(data),
               PI_DESKTOP_BUILTIN_PLUGINS_DIR=str(builtin))
    with (local / "desktop-install.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [str(host)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=log, text=True, encoding="utf-8", env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        sequence = 0

        def call(method, params):
            nonlocal sequence
            sequence += 1
            process.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": sequence,
                "method": method, "params": params}) + "\n")
            process.stdin.flush()
            while True:
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError("Host 已退出，详见 .local/desktop-install.log")
                value = json.loads(line)
                if value.get("id") == sequence:
                    if "error" in value:
                        raise RuntimeError(json.dumps(value["error"], ensure_ascii=False))
                    return value["result"]

        try:
            call("app.handshake", {"protocolVersion": 11})
            plugin = call("plugins.loadDev", {"path": str(root)})["plugin"]
            if not plugin.get("enabled") or "agent.extension" not in plugin.get("permissions", []):
                raise RuntimeError("插件未启用或缺少 agent.extension 权限")
            report = {key: plugin.get(key) for key in ("id", "version", "path", "enabled")}
            report.update(backup=str(backup), host=str(host), protocolVersion=11)
            (local / "desktop-installation.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=True))
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
