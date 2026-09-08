#!/bin/bash
# Fine-tune yolo11m.pt (local MPS, small batch/imgsz for 8 GB Mac).
# Fallback: if yolo11m OOMs, re-run with yolo11s (smaller backbone).
set -euo pipefail
VENV="/Users/s.jyothirmayudu/live_proctor/venv/bin/python"
DATA="/Users/s.jyothirmayudu/Downloads/exam-platform/training/datasets/exam_proctor/data.yaml"
MODEL="/Users/s.jyothirmayudu/Downloads/exam-platform/src/proctoring/model/yolo11m.pt"
OUT="/Users/s.jyothirmayudu/Downloads/exam-platform/training/runs/"

echo "=== YOLO11 MPS fine-tune (batch=4 imgsz=640 epochs=15) ==="
$VENV -m ultralytics.engine.train \
  model="$MODEL" \
  data="$DATA" \
  epochs=15 \
  imgsz=640 \
  batch=4 \
  device=mps \
  project="${OUT}" \
  name="exam_phone_earbuds" \
  exist_ok=True 2>&1 | tee /tmp/yolo_train_11m.log || {
    echo "=== yolo11m OOM or error — falling back to yolo11s ==="
    $VENV -m ultralytics.engine.train \
      model="yolo11s.pt" \
      data="$DATA" \
      epochs=15 \
      imgsz=640 \
      batch=4 \
      device=mps \
      project="${OUT}" \
      name="exam_phone_earbuds_s_fallback" \
      exist_ok=True 2>&1 | tee /tmp/yolo_train_11s.log
  }
echo "=== Train finished. Best weights: ${OUT}exam_phone_earbuds/weights/best.pt ==="
