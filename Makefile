DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml

DATA_DIR ?= $(shell grep -s "^DATA_DIR=" .env | cut -d= -f2)
DATA_DIR := $(or $(DATA_DIR),./.data)

.PHONY: help env data up down dev logs ps scale psql redis-cli reindex test lint reset

help:            ## Show targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

env:             ## Create .env from the example with fresh secrets
	@test -f .env || (cp .env.example .env && \
	  sed -i "s/^TOKEN_ENC_KEY=$$/TOKEN_ENC_KEY=$$(openssl rand -hex 32)/; \
	          s/^URL_SIGNING_SECRET=$$/URL_SIGNING_SECRET=$$(openssl rand -hex 32)/; \
	          s/^ML_SERVICE_TOKEN=$$/ML_SERVICE_TOKEN=$$(openssl rand -hex 24)/; \
	          s/^POSTGRES_PASSWORD=$$/POSTGRES_PASSWORD=$$(openssl rand -hex 16)/" .env && \
	  echo "Created .env with fresh secrets. Connect clouds in Settings (see README for OAuth keys).")

data:            ## Create data dirs (owned by you, so the uid-1000 app user can write uploads)
	@mkdir -p $(DATA_DIR)/postgres $(DATA_DIR)/redis $(DATA_DIR)/weaviate $(DATA_DIR)/uploads

up: env data     ## Build and start the full local stack
	docker compose up --build -d
	@echo "→ http://localhost:$$(grep -s '^WEB_PORT=' .env | cut -d= -f2 || echo 8080)"

down:            ## Stop everything (data volumes are kept)
	docker compose down --remove-orphans

dev: env data    ## Hot reload everywhere (web on :5173)
	$(DEV) up --build

logs:            ## Tail logs
	docker compose logs -f --tail=100

ps:              ## Service + replica status
	docker compose ps

scale:           ## Watch the autoscaler and queue depth
	docker compose logs -f autoscaler

reindex:         ## Re-embed files indexed with an older model (ARGS=--all to redo everything)
	docker compose run --rm --no-deps api node src/reindex.js $(ARGS)

psql:            ## Open a psql shell on the local database
	docker compose exec postgres psql -U omni -d omni

redis-cli:       ## Open redis-cli
	docker compose exec redis redis-cli

test:            ## Run all test suites
	cd api && npm test
	cd web && npm test
	docker compose run --rm --no-deps -u root -v $$PWD/ml/tests:/srv/tests -v $$PWD/ml/requirements-dev.txt:/tmp/dev.txt \
	  --entrypoint sh ml -c "pip install -q -r /tmp/dev.txt && python -m pytest -q -p no:cacheprovider tests"

lint:            ## Lint everything
	cd api && npm run lint
	cd web && npm run lint
	docker compose run --rm --no-deps -u root -v $$PWD/ml:/src -v $$PWD/ml/requirements-dev.txt:/tmp/dev.txt \
	  --entrypoint sh ml -c "pip install -q -r /tmp/dev.txt && cd /src && ruff check --no-cache app tests scripts"

reset:           ## DANGER: stop the stack; prints how to wipe local data (db, redis, vectors, uploads)
	docker compose down --remove-orphans
	@echo "Delete $(DATA_DIR) to wipe all data:  rm -rf $(DATA_DIR)"
