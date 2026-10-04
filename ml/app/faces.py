"""Face detection + recognition, fully local (OpenCV Zoo YuNet detector + SFace recognizer, Apache-2.0).

Faces are biometric data, so they never leave this machine. Clustering is incremental: a new face
joins the person of its nearest known face when similarity clears FACE_MATCH_THRESHOLD, otherwise it
starts a new person. Users can then name and merge people.
"""

import logging
import threading
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)
MAX_SIDE = 1280  # detection runs on a downscaled copy; faces are tiny compared to the image budget


class FaceEngine:
    name = "yunet+sface"

    def __init__(self, model_dir: str, min_score: float = 0.85, min_size: int = 24):
        import cv2

        d = Path(model_dir)
        self.cv2 = cv2
        self.det = cv2.FaceDetectorYN.create(
            str(d / "face_detection_yunet_2023mar.onnx"), "", (320, 320), min_score, 0.3, 5000
        )
        self.rec = cv2.FaceRecognizerSF.create(str(d / "face_recognition_sface_2021dec.onnx"), "")
        self.min_size = min_size
        self._lock = threading.Lock()

    def detect(self, rgb) -> list[dict]:
        img = np.asarray(rgb)[:, :, ::-1].copy()  # RGB → BGR
        h, w = img.shape[:2]
        scale = min(1.0, MAX_SIDE / max(h, w))
        if scale < 1:
            img = self.cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=self.cv2.INTER_AREA)
        ih, iw = img.shape[:2]
        out = []
        with self._lock:
            self.det.setInputSize((iw, ih))
            _, faces = self.det.detect(img)
            for f in faces if faces is not None else []:
                x, y, fw, fh = (float(v) for v in f[:4])
                if min(fw, fh) < self.min_size * scale:
                    continue
                emb = self.rec.feature(self.rec.alignCrop(img, f)).flatten().astype(np.float32)
                emb /= np.linalg.norm(emb) or 1.0
                bbox = [max(0.0, x / iw), max(0.0, y / ih), min(1.0, fw / iw), min(1.0, fh / ih)]
                out.append(
                    {"bbox": [round(v, 4) for v in bbox], "score": round(float(f[14]), 3), "embedding": emb.tolist()}
                )
        return sorted(out, key=lambda f: -f["score"])[:20]
