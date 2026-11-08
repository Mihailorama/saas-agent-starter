#!/bin/sh
# Builds the Cal.diy image (MIT, https://github.com/calcom/cal.diy) from a pinned upstream commit
# with upstream's own, unmodified Dockerfile: repository root `Dockerfile`, build args as in its
# README ("Build-time variables") and docker-compose.yml. Secrets are runtime-only: the build's
# NEXTAUTH_SECRET / CALENDSO_ENCRYPTION_KEY are the Dockerfile's placeholder defaults, which
# next.config.ts only checks for presence; the URL placeholder is replaced at start (start.sh).
# Used by CI (.github/workflows/ci.yml job caldiy-image, release.yml job caldiy) and by hand:
#   infra/caldiy/build.sh caldiy:local      # then: docker compose --profile booking up -d
# Needs ~6 GB of free RAM (Next.js build heap) and ~15 GB of disk. docs/crm.md, ADR 0026.
set -eu
# calcom/cal.diy main, 2026-11-03 ("chore(atoms): stop publishing @calcom/atoms"). Cal.diy has
# no release tags since the fork (the last tag, v6.2.0 of 2026-03-01, is the old Cal.com), so the
# pin is a commit. Bump: pick a newer main commit, rebuild, let CI scan and smoke-test it.
REF=2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee

tag=${1:?usage: infra/caldiy/build.sh <image tag> [extra docker build args]}
shift
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git -C "$src" init -q
git -C "$src" fetch -q --depth 1 https://github.com/calcom/cal.diy.git "$REF"
git -C "$src" checkout -q FETCH_HEAD
docker build -t "$tag" \
  --build-arg MAX_OLD_SPACE_SIZE=6144 \
  --build-arg CALCOM_TELEMETRY_DISABLED=1 \
  --label org.opencontainers.image.source=https://github.com/calcom/cal.diy \
  --label org.opencontainers.image.revision="$REF" \
  --label org.opencontainers.image.licenses=MIT \
  "$@" "$src"
