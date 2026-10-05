"""Download everything the ML service needs at image build time, so containers start offline:
vision model weights + tokenizer, the query-understanding LLM, GeoNames (offline reverse geocoding)
and the face models."""

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

text_model = os.getenv("TEXT_EMBED_MODEL", "intfloat/multilingual-e5-small")
from sentence_transformers import SentenceTransformer  # noqa: E402

SentenceTransformer(text_model, device="cpu")
print("text model cached:", text_model)

# Query understanding: a 4-bit Qwen3-0.6B for llama.cpp (~400 MB).
from huggingface_hub import hf_hub_download  # noqa: E402

llm_file = os.getenv("LLM_MODEL", "Qwen3-0.6B-Q4_K_M.gguf")
hf_hub_download(os.getenv("LLM_REPO", "unsloth/Qwen3-0.6B-GGUF"), llm_file, local_dir=DATA / "llm")
print("llm cached:", llm_file)

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

# Store the big weight files as float16: half the image size. Models still load and run in float32
# (weights are cast on load); measured embedding change: cosine >= 0.999999, margins move by ~4e-5.
import glob  # noqa: E402

import torch  # noqa: E402
from safetensors.torch import load_file, safe_open, save_file  # noqa: E402

for path in glob.glob(str(DATA / "hub/**/*.safetensors"), recursive=True):
    real = os.path.realpath(path)
    if os.path.getsize(real) < 50_000_000:
        continue
    with safe_open(real, "pt") as f:
        meta = f.metadata()
    weights = {k: v.half() if v.dtype == torch.float32 else v for k, v in load_file(real).items()}
    save_file(weights, real + ".tmp", metadata=meta)
    os.replace(real + ".tmp", real)
    print("stored as float16:", path.split("models--")[1].split("/")[0], os.path.getsize(real) // 1_000_000, "MB")

# Download bookkeeping isn't needed at runtime.
import shutil  # noqa: E402

for junk in (DATA / "xet", DATA / "llm/.cache"):
    shutil.rmtree(junk, ignore_errors=True)
