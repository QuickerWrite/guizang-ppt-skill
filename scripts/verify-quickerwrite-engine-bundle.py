#!/usr/bin/env python3
import hashlib, json, pathlib, sys, zipfile

for argument in sys.argv[1:]:
    archive = pathlib.Path(argument)
    with zipfile.ZipFile(archive) as bundle:
        names = {item.filename for item in bundle.infolist() if not item.is_dir()}
        if "engine-manifest.json" not in names:
            raise SystemExit(f"{archive}: missing engine-manifest.json")
        manifest = json.loads(bundle.read("engine-manifest.json"))
        if manifest.get("format") != "quickerwrite-ppt-engine-bundle/v1" or manifest.get("engine", {}).get("api_version") != "qw-ppt-engine/v1":
            raise SystemExit(f"{archive}: unsupported manifest contract")
        declared = {"engine-manifest.json"}
        for item in manifest.get("files", []):
            name = item["path"]
            if name in declared or name not in names:
                raise SystemExit(f"{archive}: invalid manifest entry {name}")
            data = bundle.read(name)
            if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise SystemExit(f"{archive}: checksum mismatch {name}")
            declared.add(name)
        extra = names - declared
        if extra:
            raise SystemExit(f"{archive}: undeclared files: {sorted(extra)[:5]}")
        if manifest["runtime"]["entrypoint"] not in names:
            raise SystemExit(f"{archive}: missing runtime entrypoint")
    print(f"verified {archive}")
