"""Download everything the ML service needs at image build time, so containers start offline:
vision model weights + tokenizer, GeoNames (offline reverse geocoding) and the face models."""

import io
import os
import urllib.request
import zipfile
from pathlib import Path

import open_clip

DATA = Path(os.getenv("ML_DATA_DIR", "/models"))


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "OmniCloud-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


name = os.getenv("EMBED_MODEL_NAME", "ViT-B-16-SigLIP2-256")
open_clip.create_model_and_transforms(name, pretrained=os.getenv("EMBED_MODEL_PRETRAIN", "webli"))
open_clip.get_tokenizer(name)
print("vision model cached:", name)

geo = DATA / "geonames"
geo.mkdir(parents=True, exist_ok=True)
base = "https://download.geonames.org/export/dump"
with zipfile.ZipFile(io.BytesIO(fetch(f"{base}/cities15000.zip"))) as z:
    z.extract("cities15000.txt", geo)
for f in ("admin1CodesASCII.txt", "countryInfo.txt"):
    (geo / f).write_bytes(fetch(f"{base}/{f}"))
print("geonames cached")

faces = DATA / "faces"
faces.mkdir(parents=True, exist_ok=True)
zoo = "https://github.com/opencv/opencv_zoo/raw/main/models"
for path in (
    "face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface/face_recognition_sface_2021dec.onnx",
):
    data = fetch(f"{zoo}/{path}")
    if len(data) < 100_000:
        raise SystemExit(f"{path}: got {len(data)} bytes (LFS pointer?)")
    (faces / path.split("/")[1]).write_bytes(data)
print("face models cached")
