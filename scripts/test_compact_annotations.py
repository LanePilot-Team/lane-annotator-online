import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("compact_annotations.py")


class CompactAnnotationsCliTest(unittest.TestCase):
    def run_compactor(self, root):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--queue-dir",
                str(root / "annotations"),
                "--reviews-queue-dir",
                str(root / "intersection-reviews"),
                "--jsonl",
                str(root / "exports" / "annotations.jsonl"),
                "--reviews-jsonl",
                str(root / "exports" / "intersection_reviews.jsonl"),
                "--delete-merged",
            ],
            capture_output=True,
            text=True,
        )

    def test_compacts_latest_annotation_and_preserves_invalid_queue_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "annotations").mkdir()
            (root / "intersection-reviews").mkdir()
            (root / "exports").mkdir()
            original = {"object_identity": {"nav_context_key": "way/1/forward"}, "value": "old"}
            updated = {"object_identity": {"nav_context_key": "way/1/forward"}, "value": "new"}
            (root / "exports" / "annotations.jsonl").write_text(json.dumps(original) + "\n", encoding="utf-8")
            valid = root / "annotations" / "way_1__20260715T010000Z__anna.json"
            valid.write_text(json.dumps(updated), encoding="utf-8")
            invalid = root / "annotations" / "broken.json"
            invalid.write_text("{", encoding="utf-8")

            result = self.run_compactor(root)

            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in (root / "exports" / "annotations.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(rows, [updated])
            self.assertFalse(valid.exists())
            self.assertTrue(invalid.exists())

    def test_applies_review_events_in_filename_timestamp_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "annotations").mkdir()
            (root / "intersection-reviews").mkdir()
            (root / "exports").mkdir()
            checked = {
                "review_key": "way/1@node/2",
                "nav_segment_key": "way/1",
                "nav_intersection_key": "node/2",
                "checked": True,
            }
            unchecked = dict(checked, checked=False)
            (root / "intersection-reviews" / "review__20260715T010000Z__anna__on.json").write_text(json.dumps(checked), encoding="utf-8")
            (root / "intersection-reviews" / "review__20260715T020000Z__anna__off.json").write_text(json.dumps(unchecked), encoding="utf-8")

            result = self.run_compactor(root)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "exports" / "intersection_reviews.jsonl").read_text(encoding="utf-8"), "")
            self.assertEqual(list((root / "intersection-reviews").glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
