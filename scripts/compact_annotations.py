import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def storage_key(record):
    identity = record.get("object_identity", {})
    return identity.get("nav_context_key") or identity.get("nav_segment_key")


def load_jsonl_latest(path, key_fn):
    latest = {}
    order = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            key = key_fn(record)
            if not key:
                continue
            if key not in latest:
                order.append(key)
            latest[key] = record
    return latest, order


def read_queue(queue_dir):
    rows = []
    skipped = []
    files = sorted(queue_dir.glob("*.json")) if queue_dir.exists() else []
    for queue_file in files:
        try:
            rows.append((queue_file, json.loads(queue_file.read_text(encoding="utf-8"))))
        except json.JSONDecodeError as error:
            skipped.append(f"{queue_file.name}: invalid json ({error})")
    return rows, skipped


def file_stamp(queue_file):
    parts = queue_file.name.split("__")
    return parts[1] if len(parts) > 1 else ""


def write_jsonl(path, keys, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        for key in keys:
            output.write(json.dumps(records[key], ensure_ascii=False) + "\n")


def merge_annotations(jsonl_path, queue_rows):
    latest, order = load_jsonl_latest(jsonl_path, storage_key)
    merged_files = []
    skipped = []
    for queue_file, record in queue_rows:
        key = storage_key(record)
        if not key:
            skipped.append(f"{queue_file.name}: missing storage key")
            continue
        if key not in latest:
            order.append(key)
        latest[key] = record
        merged_files.append(queue_file)
    write_jsonl(jsonl_path, order, latest)
    return merged_files, skipped, len(order)


def merge_reviews(reviews_path, annotation_rows, review_rows):
    reviews, _ = load_jsonl_latest(reviews_path, lambda row: row.get("review_key"))
    operations = []
    for queue_file, record in annotation_rows:
        identity = record.get("object_identity", {})
        if identity.get("context_scope") != "intersection_approach":
            continue
        segment = identity.get("nav_segment_key")
        intersection = identity.get("applies_to_intersection_key")
        if not segment or not intersection:
            continue
        metadata = record.get("annotation_metadata", {})
        key = f"{segment}@{intersection}"
        operations.append((file_stamp(queue_file), queue_file.name, key, {
            "object_type": "intersection_review",
            "review_key": key,
            "nav_segment_key": segment,
            "nav_intersection_key": intersection,
            "status": "checked",
            "checked_by": metadata.get("verified_by") or "unknown",
            "checked_at": metadata.get("verified_at") or "",
        }))

    merged_files = []
    skipped = []
    for queue_file, record in review_rows:
        key = record.get("review_key")
        segment = record.get("nav_segment_key")
        intersection = record.get("nav_intersection_key")
        if not key or not segment or not intersection:
            skipped.append(f"{queue_file.name}: missing review fields")
            continue
        row = {key: value for key, value in record.items() if key != "checked"} if record.get("checked") else None
        operations.append((file_stamp(queue_file), queue_file.name, key, row))
        merged_files.append(queue_file)

    for _, _, key, row in sorted(operations, key=lambda operation: (operation[0], operation[1])):
        if row is None:
            reviews.pop(key, None)
        else:
            reviews[key] = row
    write_jsonl(reviews_path, sorted(reviews), reviews)
    return merged_files, skipped, len(reviews)


def main():
    parser = argparse.ArgumentParser(description="Compact public annotation queues into canonical JSONL exports.")
    parser.add_argument("--queue-dir", type=Path, default=REPO_ROOT / "annotations")
    parser.add_argument("--reviews-queue-dir", type=Path, default=REPO_ROOT / "intersection-reviews")
    parser.add_argument("--jsonl", type=Path, default=REPO_ROOT / "exports" / "annotations.jsonl")
    parser.add_argument("--reviews-jsonl", type=Path, default=REPO_ROOT / "exports" / "intersection_reviews.jsonl")
    parser.add_argument("--delete-merged", action="store_true")
    args = parser.parse_args()

    annotation_rows, invalid_annotations = read_queue(args.queue_dir)
    review_rows, invalid_reviews = read_queue(args.reviews_queue_dir)
    merged_annotations, skipped_annotations, annotation_count = merge_annotations(args.jsonl, annotation_rows)
    merged_set = set(merged_annotations)
    merged_reviews, skipped_reviews, review_count = merge_reviews(
        args.reviews_jsonl,
        [(path, record) for path, record in annotation_rows if path in merged_set],
        review_rows,
    )

    if args.delete_merged:
        for queue_file in merged_annotations + merged_reviews:
            queue_file.unlink()

    print(f"annotations merged: {len(merged_annotations)}, total: {annotation_count}")
    print(f"review events merged: {len(merged_reviews)}, total: {review_count}")
    for message in invalid_annotations + skipped_annotations + invalid_reviews + skipped_reviews:
        print(f"skipped {message}")


if __name__ == "__main__":
    main()
