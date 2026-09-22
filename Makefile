# Thin wrappers around run.py / the CLI (run.py works without make, e.g. on Windows).
PY ?= .venv/Scripts/python
dev:      ; $(PY) run.py --dev
start:    ; $(PY) run.py
reseed:   ; $(PY) run.py --reseed
test:     ; $(PY) -m pytest tests -q
pipeline: ; $(PY) -m app.pipeline run --source data/bundle
score:    ; $(PY) -m app.pipeline run --source http://localhost:8080 --no-db --submit --note "$(NOTE)"
eval:     ; $(PY) eval.py
