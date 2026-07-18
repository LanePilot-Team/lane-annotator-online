import argparse
import json
import shutil
from pathlib import Path


NANZI = "area/4212599"
NEIGHBOURS = ["area/4212533", "area/4212683", "area/4213913", "area/4213947", "area/4217243"]
INCLUDED = [NANZI, *NEIGHBOURS]


def main():
    parser = argparse.ArgumentParser(description="Copy the Nanzi annotation area and its adjacent district shards into docs/data.")
    parser.add_argument("--source-data", type=Path, required=True)
    parser.add_argument("--target-data", type=Path, required=True)
    args = parser.parse_args()

    source_manifest = json.loads((args.source_data / "region_manifest.json").read_text(encoding="utf-8"))
    source_regions = {item["area_id"]: item for item in source_manifest["regions"]}
    missing = [area_id for area_id in INCLUDED if area_id not in source_regions]
    if missing:
        raise SystemExit(f"missing source regions: {', '.join(missing)}")

    args.target_data.mkdir(parents=True, exist_ok=True)
    target_regions = []
    for area_id in INCLUDED:
        region = dict(source_regions[area_id])
        if area_id == NANZI:
            region["context_area_ids"] = NEIGHBOURS
        source_dir = args.source_data / "regions" / region["shard_id"]
        target_dir = args.target_data / "regions" / region["shard_id"]
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)
        target_regions.append(region)

    manifest = {
        "format": source_manifest["format"],
        "dataset_version": source_manifest["dataset_version"],
        "region_count": len(target_regions),
        "regions": target_regions,
        "unassigned": source_manifest.get("unassigned", {}),
    }
    (args.target_data / "region_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
