import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { exportPortableData } from './portable-data.mjs';

const root = resolve(process.argv[2] || process.cwd());
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const output = resolve(process.argv[3] || join(root, 'output', 'portable', `SupplierHub-${stamp}`));
if (existsSync(output) || existsSync(output + '.zip')) throw new Error('출력 경로가 이미 있습니다. 다른 경로를 지정하세요.');
if (!existsSync(join(root, 'dist/server.js'))) throw new Error('먼저 npm run build를 실행하세요.');
mkdirSync(output, { recursive: true });
function copyTree(relative) {
  const source = join(root, relative), destination = join(output, relative);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(relative, entry.name));
    else if (entry.isFile()) copyFileSync(join(source, entry.name), join(destination, entry.name));
  }
}
for (const directory of ['src', 'dist', 'public']) copyTree(directory);
mkdirSync(join(output, 'scripts'));
for (const name of readdirSync(join(root, 'scripts'))) {
  if (/^(?:portable-|build-ui|build-portable-package|build-shipment-upload|prepare-order-confirmation|print-shipment-documents|print-xlsx|start-logen-windows-mcp|confirm-logen-oz-print|focus-browser-window)/.test(name)) {
    copyFileSync(join(root, 'scripts', name), join(output, 'scripts', name));
  }
}
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', '.env.example', 'start-dashboard.cmd', 'start-dashboard.ps1']) copyFileSync(join(root, file), join(output, file));
mkdirSync(join(output, 'docs'));
for (const file of ['PORTABLE_INSTALL.html', 'EXPERIENCE_PAGES.md']) copyFileSync(join(root, 'docs', file), join(output, 'docs', file));
copyFileSync(join(root, 'docs/PORTABLE_INSTALL.html'), join(output, '새PC_설치안내.html'));
writeFileSync(join(output, '.portable'), 'Use only this project .env; never inherit a parent project environment file.\n');
const allowed = new Set(['LOGEN_INTEGRATION_METHOD', 'LOGEN_REGISTRATION_URL', 'LOGEN_WAYBILL_URL', 'LOGEN_TRACKING_URL', 'LOGEN_SELECTORS_JSON',
  'SUPPLIERHUB_SHIPMENT_URL', 'SUPPLIERHUB_FULFILLMENT_SELECTORS_JSON', 'SUPPLIERHUB_SHIPMENT_UPLOAD_URL', 'SUPPLIERHUB_SHIPMENT_JOBS_URL',
  'SUPPLIERHUB_SHIPMENT_LIST_URL', 'SUPPLIERHUB_SHIPMENT_SELECTORS_JSON', 'SUPPLIERHUB_SHIPMENT_PDF_REQUESTS_JSON', 'SUPPLIERHUB_DATE_INPUT_FORMAT']);
const overrides = new Map();
for (const file of [resolve(root, '..', '..', '.env'), join(root, '.env')]) if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (allowed.has(key)) overrides.set(key, line);
  }
}
let config = readFileSync(join(root, '.env.example'), 'utf8').split(/\r?\n/).map(line => {
  const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
  if (overrides.has(key)) return overrides.get(key);
  if (['FULFILLMENT_ORDER_PRINTER', 'FULFILLMENT_WAYBILL_PRINTER', 'FULFILLMENT_SHIPMENT_PRINTER'].includes(key)) return key + '=';
  return line;
}).join('\n');
config += '\nSUPPLIERHUB_PORTABLE=1\nSUPPLIERHUB_PROFILE_DIR=data/fulfillment-supplierhub-profile\n';
writeFileSync(join(output, '.env.portable'), config);
for (const [name, script] of [['처음설정','portable-setup'], ['실행환경확인','portable-check'], ['업무시작','portable-start'], ['업무종료','portable-stop']]) {
  writeFileSync(join(output, name + '.cmd'), `@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\${script}.ps1"\r\nif errorlevel 1 pause\r\n`, 'ascii');
}
writeFileSync(join(output, '이전용패키지만들기.cmd'), '@echo off\r\ncd /d "%~dp0"\r\ncall npm.cmd run build\r\nif errorlevel 1 goto failed\r\nnode.exe scripts\\build-portable-package.mjs "%~dp0."\r\n:failed\r\npause\r\n', 'ascii');
const manifest = await exportPortableData(root, join(output, 'migration'));
writeFileSync(join(output, '읽어주세요.txt'), `SupplierHub 다른 PC 이전 패키지\n\n1. 새PC_설치안내.html을 여세요.\n2. Node.js 24+, Python 3.10+, Chrome, 데스크톱 Excel, PowerShell 7 및 프린터를 설치하세요.\n3. 처음설정.cmd → 실행환경확인.cmd → 업무시작.cmd 순서로 실행하세요.\n\n이전자료 생성시각(UTC): ${manifest.createdAt}\n실제 파일 ${manifest.files.length}개 포함, 원본에서도 찾지 못한 파일 ${manifest.missingFiles.length}개.\n누락 상세는 migration/manifest.json의 missingFiles에서 확인하세요.\n기존 PC에서 이후 업무를 계속했다면 최종 이전 직전에 패키지를 다시 만드세요.\n로그인 세션·비밀번호·API 비밀키·기존 PC 출력 보조 토큰은 포함하지 않았습니다.\n최초 설정에는 인터넷 연결이 필요합니다. 새 PC 설치와 실제 등록·인쇄는 별도 확인이 필요합니다.\n`, 'utf8');
const zip = new AdmZip(); zip.addLocalFolder(output, 'SupplierHub'); zip.writeZip(output + '.zip');
const bytes = readFileSync(output + '.zip');
const summary = { archive: output + '.zip', folder: output, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  createdAt: manifest.createdAt, files: manifest.files.length, missingFiles: manifest.missingFiles.length, counts: manifest.counts };
writeFileSync(output + '.summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
