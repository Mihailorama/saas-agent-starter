#!/bin/sh
# Scans a Cal.diy image (infra/caldiy/build.sh) with Trivy; fails on fixable critical
# vulnerabilities. Used by CI (ci.yml caldiy-image) and release.yml (caldiy).
#   infra/caldiy/scan.sh <image>
#
# Skipped, with the reason (re-check on every REF bump, drop entries once upstream fixes them):
# Go build tools that upstream's yarn install leaves in node_modules and the running app never
# executes: the Depot CLI (`@depot/cli`, a remote-build client: docker/docker, grpc and Go stdlib
# CVEs) and esbuild's binaries (Go stdlib crypto/tls CVE-2025-68121; esbuild makes no TLS
# connections). Found 2026-11-07 at REF 2eb48ecc; everything else in the image passes.
set -eu
image=${1:?usage: infra/caldiy/scan.sh <image>}
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/aquasecurity/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222 \
  image --scanners vuln --severity CRITICAL --ignore-unfixed --exit-code 1 \
  --skip-files calcom/node_modules/@depot/cli-linux-x64/bin/depot \
  --skip-files calcom/node_modules/@esbuild/linux-x64/bin/esbuild \
  --skip-files calcom/node_modules/trigger.dev/node_modules/@esbuild/linux-x64/bin/esbuild \
  "$image"
