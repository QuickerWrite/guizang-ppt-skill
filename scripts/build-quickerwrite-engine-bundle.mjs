#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] || process.env.ENGINE_VERSION || '').replace(/^v/, '');
const arch = process.argv[3] || process.env.ENGINE_ARCH || process.arch;
const output = path.resolve(process.argv[4] || path.join(root, 'dist'));
if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('a semantic ENGINE_VERSION is required');
if (!['x64', 'arm64', 'amd64'].includes(arch)) throw new Error(`unsupported architecture: ${arch}`);
const targetArch = arch === 'x64' ? 'amd64' : arch;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-guizang-engine-'));
const payload = path.join(staging, 'engine');
const excluded = new Set(['.git', '.github', '.runner-output', 'dist']);
fs.cpSync(root, payload, { recursive: true, dereference: true, filter: source => !source.split(path.sep).some(part => excluded.has(part)) });
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) { const data = fs.readFileSync(absolute); files.push({ path: path.relative(staging, absolute).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length }); }
  }
}
walk(payload);
const manifest = {
  format: 'quickerwrite-ppt-engine-bundle/v1', schema_version: 1,
  engine: { id: 'guizang', name: 'Guizang', version, api_version: 'qw-ppt-engine/v1', license: 'AGPL-3.0', homepage: 'https://github.com/QuickerWrite/guizang-ppt-skill' },
  target: { os: 'linux', arch: targetArch },
  runtime: { kind: 'node', version: '>=20', entrypoint: 'engine/quickerwrite-runner/server.mjs', working_directory: 'engine' },
  endpoints: { health: '/health', capabilities: '/v1/capabilities', jobs: '/v1/jobs' },
  capabilities: { incremental_pages: true, page_cache: true, outputs: ['html'], previews: ['showcase', 'editorial', 'swiss'] }, files
};
fs.writeFileSync(path.join(staging, 'engine-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.mkdirSync(output, { recursive: true });
const name = `quickerwrite-ppt-engine-guizang-${version}-linux-${targetArch}.zip`;
execFileSync('python3', ['-c', `import os,sys,zipfile
root,out=sys.argv[1:]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for base,dirs,files in os.walk(root):
    dirs.sort(); files.sort()
    for name in files:
      full=os.path.join(base,name); z.write(full,os.path.relpath(full,root).replace(os.sep,'/'))`, staging, path.join(output, name)]);
const archive = fs.readFileSync(path.join(output, name));
fs.writeFileSync(path.join(output, `${name}.sha256`), `${crypto.createHash('sha256').update(archive).digest('hex')}  ${name}\n`);
fs.rmSync(staging, { recursive: true, force: true });
console.log(path.join(output, name));
