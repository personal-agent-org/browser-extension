# Personal Agent browser extension task runner. Run `just` (or `just --list`) to see recipes.
# `just check` mirrors the CI gate.
set shell := ["bash", "-c"]

# List recipes
default:
    @just --list

# Install deps + git hooks
setup:
    npm ci
    command -v prek >/dev/null && prek install && prek install --hook-type commit-msg || echo "prek not installed (uv tool install prek)"

# Build dist/chrome + dist/firefox
build:
    npm run build

# Lint (eslint)
lint:
    npm run lint

# Run tests
test:
    npm test

# web-ext lint of the built firefox bundle
lint-ext:
    npm run build && npx web-ext lint --source-dir dist/firefox

# Run all pre-commit hooks
hooks:
    prek run --all-files

# Pre-PR gate (mirrors CI): lint + test + build
check: lint test build
