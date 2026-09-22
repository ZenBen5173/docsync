# DocCheck - one container: FastAPI serves the API and the built React UI.
#
#   docker build -t doccheck .
#   docker run --rm -p 8000:8000 doccheck            -> http://localhost:8000
#
# The inbox is processed at BUILD time, so every new container starts from the same clean, fully
# seeded demo state (and a public demo heals itself whenever the host starts a fresh instance).

# ---- 1. build the UI ---------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. runtime --------------------------------------------------------------
FROM python:3.11-slim
# DOCCHECK_PUBLIC_DEMO=1: this image is the hosted demo - no scoring endpoint, no API docs, rate-limited
# pipeline runs, "Reset demo data" enabled. Run with -e DOCCHECK_PUBLIC_DEMO=0 for a private install.
ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 PIP_NO_CACHE_DIR=1 \
    DOCCHECK_SOURCE=/app/data/bundle DOCCHECK_VAR=/app/var PORT=8000 DOCCHECK_PUBLIC_DEMO=1
# OpenCV (pulled in by the OCR engine) needs these two system libraries on slim images
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
# fail the build if a native library is missing: the OCR code swallows load errors at run time, so a broken
# OCR stack would otherwise produce a "successful" image whose scanned documents just come back empty
RUN python -c "import cv2, onnxruntime, pymupdf; from rapidocr_onnxruntime import RapidOCR; RapidOCR(); print('ocr stack ok')"
COPY app/ ./app/
COPY data/bundle/ ./data/bundle/
# fail the build loudly if an ignore file ever strips the dataset (an unanchored *.pdf in .gcloudignore once did)
RUN ls /app/data/bundle/inbox/*.json > /dev/null && ls /app/data/bundle/attachments/*.pdf > /dev/null
COPY --from=web /web/dist ./web/dist
# seed the database (classify + compare all emails) and warm the OCR model
#   then freeze that state as var/seed.db - "Reset demo data" in Admin restores it
RUN python -m app.pipeline run --source /app/data/bundle --note "image seed" --out /tmp/submission.json \
    && python -c "from app import store; store.bootstrap(); store.snapshot_seed()" \
    && rm -f /tmp/submission.json /app/var/last_results.json
# at run time a pipeline run shares ONE process with every visitor's requests: keep it to 3 workers
# (set after the seeding step on purpose, so the build itself still uses 8)
ENV PIPELINE_CONCURRENCY=3
EXPOSE 8000
# ONE worker on purpose: live events, the pipeline lock and SQLite all live in this process.
CMD ["sh", "-c", "exec uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT} --log-level warning"]
