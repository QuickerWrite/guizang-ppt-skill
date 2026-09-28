#!/usr/bin/env python3
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

seven_zip = shutil.which("7z") or shutil.which("7zz")
if not seven_zip:
    raise SystemExit("7z is required to verify engine bundles")

for argument in sys.argv[1:]:
    archive = pathlib.Path(argument)
    with tempfile.TemporaryDirectory(prefix="qw-engine-verify-") as temporary:
        root = pathlib.Path(temporary)
        subprocess.run([seven_zip, "x", "-y", f"-o{root}", str(archive)], check=True, stdout=subprocess.DEVNULL)
        manifest_path = root / "engine-manifest.json"
        if not manifest_path.is_file():
            raise SystemExit(f"{archive}: missing engine-manifest.json")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("format") != "quickerwrite-ppt-engine-bundle/v1" or manifest.get("engine", {}).get("api_version") != "qw-ppt-engine/v1":
            raise SystemExit(f"{archive}: unsupported manifest contract")
        declared = {"engine-manifest.json"}
        for item in manifest.get("files", []):
            name = item["path"]
            path = root / name
            if name in declared or not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                raise SystemExit(f"{archive}: invalid manifest entry {name}")
            data = path.read_bytes()
            if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise SystemExit(f"{archive}: checksum mismatch {name}")
            declared.add(name)
        names = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
        extra = names - declared
        if extra:
            raise SystemExit(f"{archive}: undeclared files: {sorted(extra)[:5]}")
        if manifest["runtime"]["entrypoint"] not in names:
            raise SystemExit(f"{archive}: missing runtime entrypoint")
    print(f"verified {archive}")
