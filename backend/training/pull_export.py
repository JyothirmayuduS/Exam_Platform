#!/usr/bin/env python
"""
Pull a phone + earbuds/headphones detection subset from Open Images V7 and
export it in YOLO format for fine-tuning yolo11.

Design notes
------------
* Only two YOLO classes are trained: phone, earbuds. (no_face / multiple_faces /
  head pose / gaze stay in the MediaPipe path — a bbox can't express them.)
* We pull from the *validation* and *test* splits, NOT *train*. The OIv7 train
  bbox CSV is ~2.2 GB; validation/test metadata is tens of MB. We then re-split
  the merged set 85/15 into YOLO train/val. This keeps disk + download small.
* "Mobile phone" -> phone, "Headphones" -> earbuds. The app already labels the
  earbuds class "earbuds/headphones" (labels.ts:kindName), so Headphones is the
  correct source, not a hack.
"""
import os
import sys
import fiftyone as fo
import fiftyone.zoo as foz
import fiftyone.utils.random as four

OI_CLASSES = ["Mobile phone", "Headphones"]
MAPPING = {"mobile phone": "phone", "headphones": "earbuds"}
YOLO_NAMES = ["phone", "earbuds"]

EXPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "datasets", "exam_proctor")

# Bounded pulls so download + train stay tractable on an 8 GB Mac.
PULLS = [("validation", 3000), ("test", 2000)]


def find_detection_field(ds):
    """Return the name of the Detections-typed field (OIv7 uses 'ground_truth'
    in recent fiftyone, 'detections' in older). Auto-detect to be robust."""
    schema = ds.get_field_schema()
    for name, field in schema.items():
        doc_type = getattr(field, "document_type", None)
        if doc_type is fo.Detections:
            return name
    # Fallback: common names
    for cand in ("ground_truth", "detections"):
        if cand in schema:
            return cand
    raise RuntimeError(f"No Detections field found. Schema: {list(schema)}")


def main():
    merged = fo.Dataset(name="oiv7_phone_earbuds", overwrite=True)

    det_field = None
    for split, n in PULLS:
        print(f"\n=== Loading Open Images V7 [{split}] max_samples={n} ===",
              flush=True)
        ds = foz.load_zoo_dataset(
            "open-images-v7",
            split=split,
            label_types=["detections"],
            classes=OI_CLASSES,
            max_samples=n,
            seed=51,
            dataset_name=f"oiv7_pe_{split}",
        )
        if det_field is None:
            det_field = find_detection_field(ds)
            print(f"Detection field detected: '{det_field}'", flush=True)
        # copy samples into the merged dataset
        merged.add_samples([s.copy() for s in ds.iter_samples(progress=True)])
        # free the per-split dataset from disk registry (images stay cached)
        fo.delete_dataset(f"oiv7_pe_{split}")

    print(f"\nMerged sample count (raw): {len(merged)}", flush=True)

    # Remap + filter labels into a clean 'gt' field with only phone/earbuds.
    kept_counts = {"phone": 0, "earbuds": 0}
    empty = 0
    for sample in merged.iter_samples(progress=True, autosave=True):
        dets = sample[det_field]
        kept = []
        if dets is not None:
            for d in dets.detections:
                key = (d.label or "").strip().lower()
                if key in MAPPING:
                    d.label = MAPPING[key]
                    kept.append(d)
                    kept_counts[d.label] += 1
        sample["gt"] = fo.Detections(detections=kept)
        if not kept:
            empty += 1

    print(f"Instances -> phone={kept_counts['phone']} "
          f"earbuds={kept_counts['earbuds']}", flush=True)

    # Drop images that ended up with no target boxes.
    keep_view = merged.match(fo.ViewField("gt.detections").length() > 0)
    clean = merged.clone(name="oiv7_pe_clean")
    clean.delete_samples(
        [s.id for s in merged.iter_samples()
         if s["gt"] is None or len(s["gt"].detections) == 0]
    ) if False else None  # (handled via view below)

    # Simpler: build a fresh dataset from the non-empty view.
    fo.delete_dataset("oiv7_pe_clean")
    clean = fo.Dataset(name="oiv7_pe_clean", overwrite=True)
    clean.add_samples([s.copy() for s in keep_view.iter_samples(progress=True)])
    print(f"Images with >=1 target box: {len(clean)} (dropped {empty})",
          flush=True)

    if len(clean) == 0:
        print("ERROR: no labeled images pulled. Aborting.", file=sys.stderr)
        sys.exit(2)

    # 85/15 train/val split via sample tags.
    four.random_split(clean, {"train": 0.85, "val": 0.15}, seed=51)

    # Export YOLOv5 format (images/<split>, labels/<split>, dataset.yaml).
    if os.path.isdir(EXPORT_DIR):
        import shutil
        shutil.rmtree(EXPORT_DIR)
    os.makedirs(EXPORT_DIR, exist_ok=True)

    for split in ("train", "val"):
        view = clean.match_tags(split)
        print(f"Exporting {split}: {len(view)} images", flush=True)
        view.export(
            export_dir=EXPORT_DIR,
            dataset_type=fo.types.YOLOv5Dataset,
            label_field="gt",
            split=split,
            classes=YOLO_NAMES,
        )

    print(f"\nDONE. Export dir: {EXPORT_DIR}", flush=True)
    print("dataset.yaml written by fiftyone; will normalize for ultralytics.",
          flush=True)


if __name__ == "__main__":
    main()
