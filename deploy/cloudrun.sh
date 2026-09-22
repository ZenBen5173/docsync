#!/usr/bin/env bash
# Deploy DocCheck to Google Cloud Run (builds the Dockerfile with Cloud Build).
#
#   deploy/cloudrun.sh <gcp-project-id> [region]
#
# The project must have an ACTIVE billing account (the free tier covers a demo, but billing must be on).
set -euo pipefail
PROJECT="${1:?usage: deploy/cloudrun.sh <gcp-project-id> [region]}"
REGION="${2:-asia-southeast1}"          # Singapore: closest to Malaysia
cd "$(dirname "$0")/.."

# Optional shared password for the whole site: `export DOCCHECK_DEMO_PASSWORD=...` before running this script.
# Without it the demo is open to anyone with the link - including our verdict for every email in the dataset.
ENVVARS="^@^DOCCHECK_PUBLIC_DEMO=1"     # ^@^ makes @ the separator, so a password may contain commas
if [ -n "${DOCCHECK_DEMO_PASSWORD:-}" ]; then
  ENVVARS="$ENVVARS@DOCCHECK_DEMO_PASSWORD=$DOCCHECK_DEMO_PASSWORD"; echo "password gate: ON"
else
  echo "password gate: OFF (fully public)"
fi

# refuse to deploy an image that would be missing the dataset (an unanchored *.pdf in .gcloudignore once stripped it)
PDFS=$(gcloud meta list-files-for-upload | tr '\\' '/' | grep -c 'data/bundle/attachments/.*\.pdf$' || true)
[ "$PDFS" -ge 1 ] || { echo "no PDF attachments in the upload - check .gcloudignore"; exit 1; }

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"

# max-instances 1  : live events, the pipeline lock and SQLite live inside ONE process
# no-cpu-throttling: "Run pipeline" works on a background thread after the HTTP response has been sent
# min-instances 0  : scales to zero when idle; a fresh instance starts from the clean seeded state baked into the image
# concurrency 500  : every open browser tab holds one request slot for its live-update stream; the default of 80
#                    would lock new visitors out of the single instance once ~80 tabs are open
gcloud run deploy doccheck --source . --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --port 8000 --memory 2Gi --cpu 2 \
  --min-instances 0 --max-instances 1 --concurrency 500 --no-cpu-throttling --timeout 3600 \
  --set-env-vars "$ENVVARS"

gcloud run services describe doccheck --project "$PROJECT" --region "$REGION" --format="value(status.url)"
