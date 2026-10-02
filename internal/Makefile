SHELL := /bin/bash

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
MASTER_DIR := $(ROOT)/master
RUNNER_DIR := $(ROOT)/runner
WEB_DIR := $(ROOT)/internal/web-client

PYTHON_BIN ?= $(shell if command -v python3.10 >/dev/null 2>&1; then echo python3.10; else echo python3; fi)
LIVEPORTRAIT_ROOT ?= $(HOME)/.cache/avatar-studio/LivePortrait

.PHONY: help setup setup-node setup-runner setup-liveportrait check-setup doctor run dev

HOST_OS := $(shell uname -s)
ifeq ($(HOST_OS),Darwin)
DEFAULT_PLATFORM := macos
else ifeq ($(HOST_OS),Linux)
DEFAULT_PLATFORM := ubuntu
else
DEFAULT_PLATFORM := unsupported
endif

PLATFORM ?= $(DEFAULT_PLATFORM)

help:
	@printf '%s\n' \
		'Avatar Studio local commands:' \
		'  make -f internal/Makefile setup  - install local dependencies' \
		'  make -f internal/Makefile doctor - inspect local runtime and GPU readiness' \
		'  make -f internal/Makefile run    - start internal benchmark stack' \
		'  make -f internal/Makefile dev    - alias of run' \
		'' \
		'Optional overrides:' \
		'  make -f internal/Makefile setup PYTHON_BIN=python3.10' \
		'  make -f internal/Makefile setup PLATFORM=ubuntu' \
		'  make -f internal/Makefile run LIVEPORTRAIT_ROOT=/path/to/LivePortrait'

setup: setup-node setup-runner setup-liveportrait
	@echo 'Avatar Studio local setup is ready.'

setup-node:
	@command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 1; }
	npm --prefix "$(MASTER_DIR)" install --no-audit --no-fund --package-lock=false
	npm --prefix "$(WEB_DIR)" install --no-audit --no-fund --package-lock=false

setup-runner:
	@command -v "$(PYTHON_BIN)" >/dev/null 2>&1 || { echo '$(PYTHON_BIN) is required.' >&2; exit 1; }
	@if [ ! -x "$(RUNNER_DIR)/.venv/bin/python" ]; then \
		"$(PYTHON_BIN)" -m venv "$(RUNNER_DIR)/.venv"; \
	fi
	"$(RUNNER_DIR)/.venv/bin/python" -m pip install -r "$(RUNNER_DIR)/requirements.txt" -r "$(ROOT)/internal/worker/requirements.txt"

setup-liveportrait:
	@if [ "$(PLATFORM)" = "macos" ]; then \
		LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" PYTHON_BIN="$(PYTHON_BIN)" \
			bash "$(RUNNER_DIR)/setup-liveportrait-macos.sh"; \
	elif [ "$(PLATFORM)" = "ubuntu" ]; then \
		LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" PYTHON_BIN="$(PYTHON_BIN)" \
			bash "$(RUNNER_DIR)/setup-liveportrait-linux.sh"; \
	else \
		echo "Unsupported platform: $(PLATFORM). Use macOS or Ubuntu." >&2; exit 1; \
	fi

doctor:
	LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" PYTHON_BIN="$(PYTHON_BIN)" \
		bash "$(ROOT)/internal/scripts/doctor.sh"

check-setup:
	@test -d "$(MASTER_DIR)/node_modules" || { echo 'Missing master/node_modules. Run: make -f internal/Makefile setup' >&2; exit 1; }
	@test -d "$(WEB_DIR)/node_modules" || { echo 'Missing internal/web-client/node_modules. Run: make -f internal/Makefile setup' >&2; exit 1; }
	@test -x "$(RUNNER_DIR)/.venv/bin/python" || { echo 'Missing runner/.venv. Run: make -f internal/Makefile setup' >&2; exit 1; }
	@test -x "$(LIVEPORTRAIT_ROOT)/.venv/bin/python" || { echo 'Missing LivePortrait runtime. Run: make -f internal/Makefile setup' >&2; exit 1; }

run: check-setup
	AVATAR_SKIP_SETUP=1 AVATAR_RESET_RUNTIME=1 PYTHON_BIN="$(PYTHON_BIN)" LIVEPORTRAIT_ROOT="$(LIVEPORTRAIT_ROOT)" \
		bash "$(ROOT)/internal/scripts/dev-stack.sh"

dev: run
