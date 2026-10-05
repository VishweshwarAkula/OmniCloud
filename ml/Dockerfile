# uv is only needed while installing: mounted for those steps, never copied into the image.
FROM ghcr.io/astral-sh/uv:latest AS uv

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HOME=/models UV_SYSTEM_PYTHON=1 UV_COMPILE_BYTECODE=1 UV_NO_CACHE=1
WORKDIR /srv

# CPU-only torch wheels keep the image ~4 GB smaller than the default CUDA build; C++ headers and
# torch's own test suite are only for building extensions (~150 MB).
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv pip install --index-url ${TORCH_INDEX} torch torchvision && \
    cd /usr/local/lib/python3.12/site-packages && rm -rf torch/include torch/share torch/test
COPY requirements.txt .
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv pip install -r requirements.txt && \
    # Bundled test suites are never imported at runtime (~120 MB).
    find /usr/local/lib/python3.12/site-packages -depth -type d \( -name tests -o -name test \) -exec rm -rf {} +
# llama.cpp for the query-understanding LLM: a prebuilt CPU wheel, so no compiler in the image.
ARG LLAMA_INDEX=https://abetlen.github.io/llama-cpp-python/whl/cpu
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv uv pip install --extra-index-url ${LLAMA_INDEX} --index-strategy unsafe-best-match --only-binary llama-cpp-python "llama-cpp-python==0.3.36"

# Bake the CLIP weights into the image: no download on container start.
ARG EMBED_MODEL_NAME=ViT-B-16-SigLIP2-256
ARG EMBED_MODEL_PRETRAIN=webli
ENV EMBED_MODEL_NAME=${EMBED_MODEL_NAME} EMBED_MODEL_PRETRAIN=${EMBED_MODEL_PRETRAIN}
COPY scripts/prefetch_model.py scripts/
RUN python scripts/prefetch_model.py && chmod -R a+rX /models

FROM base AS dev
COPY requirements-dev.txt .
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv uv pip install -r requirements-dev.txt
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS prod
# Everything was downloaded at build time; never call the HuggingFace Hub at runtime.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
RUN useradd --system --uid 10001 ml
COPY app ./app
COPY scripts ./scripts
USER ml
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"
# One worker: the CLIP model lives in-process; torch already uses all cores per request.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "30"]
