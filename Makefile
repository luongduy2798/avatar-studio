SHELL := /bin/bash

ROOT := $(CURDIR)
API_DIR := $(ROOT)/api-server
GPU_DIR := $(ROOT)/gpu-service
WEB_DIR := $(ROOT)/web-client

PYTHON_BIN ?= python3.10
LIVEPORTRAIT_ROOT ?= $(HOME)/.cache/avatar-studio/LivePortrait

.PHONY: help setup setup-node setup-gpu setup-liveportrait check-setup run dev

help:
	@printf '%s\n' \
		'Avatar Studio local commands:' \
		'  make setup  - install local dependencies and LivePortrait models' \
		'  make run    - start web + API + GPU worker' \
		'  make dev    - alias of make run' \
		'' \
		'Optional overrides:' \
		'  make setup PYTHON_BIN=python3.10' \
		'  make run LIVEPORTRAIT_ROOT=/path/to/LivePortrait'

setup: setup-node setup-gpu setup-liveportrait
	@echo 'Avatar Studio local setup is ready.'

setup-node:
	@command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 1; }
	npm --prefix "$(API_DIR)" install --no-audit --no-fund --package-lock=false
	npm --prefix "$(WEB_DIR)" install --no-audit --no-fund --package-lock=false

setup-gpu:
	@command -v "$(PYTHON_BIN)" >/dev/null 2>&1 || { echo '$(PYTHON_BIN) is required.' >&2; exit 1; }
	@if [ ! -x "$(GPU_DIR)/.venv/bin/python" ]; then \
		"$(PYTHON_BIN)" -m venv "$(GPU_DIR)/.venv"; \
	fi
	"$(GPU_DIR)/.venv/bin/python" -m pip install -r "$(GPU_DIR)/requirements.txt"

setup-liveportrait:
	LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" PYTHON_BIN="$(PYTHON_BIN)" \
		bash "$(GPU_DIR)/scripts/setup-liveportrait-macos.sh"

check-setup:
	@test -d "$(API_DIR)/node_modules" || { echo 'Missing api-server/node_modules. Run: make setup' >&2; exit 1; }
	@test -d "$(WEB_DIR)/node_modules" || { echo 'Missing web-client/node_modules. Run: make setup' >&2; exit 1; }
	@test -x "$(GPU_DIR)/.venv/bin/python" || { echo 'Missing gpu-service/.venv. Run: make setup' >&2; exit 1; }
	@test -x "$(LIVEPORTRAIT_ROOT)/.venv/bin/python" || { echo 'Missing LivePortrait runtime. Run: make setup' >&2; exit 1; }

run: check-setup
	AVATAR_SKIP_SETUP=1 PYTHON_BIN="$(PYTHON_BIN)" LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" \
		bash "$(API_DIR)/scripts/dev-stack.sh"

dev: run
