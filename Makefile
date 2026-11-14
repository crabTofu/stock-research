PY := .venv/bin/python

.PHONY: setup ingest ingest-force dev-api dev-ui build serve

setup:            ## create venv, install backend + frontend deps
	python3 -m venv .venv
	.venv/bin/pip install -r backend/requirements.txt
	npm --prefix frontend install

ingest:           ## pull whatever is stale into data/market.db
	$(PY) -m backend.app.ingest

ingest-force:     ## re-pull everything, ignoring freshness windows
	$(PY) -m backend.app.ingest --force

dev-api:          ## API with auto-reload on :8000
	.venv/bin/uvicorn backend.app.main:app --reload --reload-dir backend --port 8000

dev-ui:           ## Vite dev server on :5173 (proxies /api to :8000)
	npm --prefix frontend run dev

build:            ## production frontend bundle -> frontend/dist
	npm --prefix frontend run build

serve: build      ## single process: API + built UI on :8000
	.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
