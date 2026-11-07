#!/usr/bin/env node
// `pnpm sbom`: CycloneDX SBOM per container image (syft, Apache-2.0, run as a container) and
// THIRD_PARTY_NOTICES.md, into dist/sbom/. Covers every image of every profile, both twins, and
// the production compose (compose.prod.yaml).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const SYFT = 'anchore/syft:v1.57.0';
const out = resolve('dist/sbom');
mkdirSync(out, { recursive: true });
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const compose = (files, ...args) =>
  sh('docker', ['compose', ...files.flatMap((f) => ['-f', f]), '--profile', '*', ...args]);
const twins = [['docker-compose.yml'], ['docker-compose.yml', 'compose.permissive.yaml']];
const backups = ['docker-compose.yml', 'compose.backup.yaml']; // backup overlay (ADR 0015)

sh('node', ['scripts/license-check.mjs', '--notices', `${out}/THIRD_PARTY_NOTICES.md`], {
  stdio: 'inherit',
});
compose(twins[0], 'build', 'api', 'web', 'worker', 'site');
compose(backups, 'build', 'postgres');
const images = new Set();
for (const files of [...twins, backups]) {
  compose(files, 'pull', '--ignore-buildable', '--quiet');
  for (const image of compose(files, 'config', '--images').split('\n').filter(Boolean)) {
    images.add(image);
  }
}
// compose.prod.yaml adds its own infra images (Caddy); its app images are the ones built above.
const prod = readFileSync('compose.prod.yaml', 'utf8').matchAll(/^\s*image:\s*([^\s$]\S*)/gm);
for (const [, image] of prod) {
  if (!images.has(image)) sh('docker', ['pull', '--quiet', image]);
  images.add(image);
}
const sock = '/var/run/docker.sock';
for (const image of [...images].sort()) {
  const file = `${image.replace(/[/:]/g, '_')}.cdx.json`;
  console.log(`sbom ${image} -> dist/sbom/${file}`);
  // syft unpacks images under /tmp, which its image does not let a non-root user write.
  const user = ['--user', `${process.getuid()}`, '--group-add', `${statSync(sock).gid}`];
  const tmp = ['--tmpfs', '/tmp:mode=1777', '-e', 'HOME=/tmp'];
  const mounts = ['-v', `${sock}:${sock}`, '-v', `${out}:/out`];
  sh('docker', [
    'run',
    '--rm',
    ...user,
    ...tmp,
    ...mounts,
    SYFT,
    `docker:${image}`,
    '-o',
    `cyclonedx-json=/out/${file}`,
  ]);
}
console.log(`${images.size} SBOMs + THIRD_PARTY_NOTICES.md in dist/sbom/`);
