import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { resolve, join, basename, extname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const filePath = value => typeof value === 'string' && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value) && /\.(xlsx?|pdf|csv|tsv|png|jpe?g|webp|json|txt|zip)$/i.test(value);
const walk = (value, transform) => Array.isArray(value) ? value.map(item => walk(item, transform)) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, transform)])) : transform(value);

export function readEnvironment(root) {
  const result = {};
  for (const path of [resolve(root, '..', '..', '.env'), join(root, '.env')]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return result;
}

function tableRows(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({
    name, columns: db.prepare(`PRAGMA table_info(${quote(name)})`).all().filter(column => /TEXT/i.test(column.type)).map(column => column.name),
    rows: db.prepare(`SELECT rowid AS _portable_row_id, * FROM ${quote(name)}`).all(),
  }));
}

export async function exportPortableData(root, destination) {
  root = resolve(root); destination = resolve(destination);
  if (existsSync(destination)) throw new Error('내보낼 폴더가 이미 있습니다. 새 폴더를 지정하세요.');
  const env = readEnvironment(root);
  const sourceDb = resolve(root, env.FULFILLMENT_DB_PATH || 'data/fulfillment.db');
  if (!existsSync(sourceDb)) throw new Error('이전할 업무 DB를 찾을 수 없습니다.');
  mkdirSync(join(destination, 'files'), { recursive: true });
  const live = new DatabaseSync(sourceDb, { readOnly: true });
  try { await backup(live, join(destination, 'fulfillment.db')); } finally { live.close(); }
  const db = new DatabaseSync(join(destination, 'fulfillment.db'), { readOnly: true });
  const sources = new Set();
  const counts = {};
  try {
    for (const table of tableRows(db)) {
      counts[table.name] = table.rows.length;
      for (const row of table.rows) for (const column of table.columns) {
        const value = row[column];
        if (typeof value !== 'string') continue;
        if (column.endsWith('_json')) {
          try { walk(JSON.parse(value), leaf => { if (filePath(leaf)) sources.add(leaf); return leaf; }); } catch {}
        } else if (filePath(value)) sources.add(value);
      }
    }
  } finally { db.close(); }
  const statePath = join(root, 'data/workflow-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (state) walk(state, value => { if (filePath(value)) sources.add(value); return value; });
  const template = env.FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE || env.FULFILLMENT_SHIPMENT_WORKBOOK;
  if (template) sources.add(resolve(root, template));
  const files = [], missingFiles = [];
  for (const oldPath of sources) {
    if (!existsSync(oldPath) || !statSync(oldPath).isFile()) { missingFiles.push(oldPath); continue; }
    const bytes = readFileSync(oldPath);
    const name = `${sha(Buffer.from(oldPath)).slice(0, 16)}-${basename(oldPath)}`;
    const path = `files/${name}`;
    writeFileSync(join(destination, path), bytes, { flag: 'wx' });
    if (sha(readFileSync(oldPath)) !== sha(bytes)) throw new Error('내보내는 동안 업무 파일이 변경됐습니다. 업무를 멈춘 뒤 다시 내보내세요.');
    files.push({ oldPath, path, sha256: sha(bytes), bytes: bytes.length });
  }
  if (state) {
    state.settings.scheduleEnabled = false;
    // A migrated live run must never be processed by demo adapters on the new PC.
    writeFileSync(join(destination, 'workflow-state.json'), JSON.stringify(state, null, 2));
  }
  const manifest = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), sourceRoot: root, counts, files, missingFiles,
    templateOldPath: template ? resolve(root, template) : null,
    databaseSha256: sha(readFileSync(join(destination, 'fulfillment.db'))),
    stateSha256: state ? sha(readFileSync(join(destination, 'workflow-state.json'))) : null };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function inside(root, path) {
  const result = resolve(root, path), rel = relative(root, result);
  if (!rel || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('이전 자료 경로가 패키지 범위를 벗어납니다.');
  return result;
}

export function restorePortableData(root, source = join(root, 'migration')) {
  root = resolve(root); source = resolve(source);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('지원하지 않는 이전 자료입니다.');
  const destination = join(root, 'data'), targetDb = join(destination, 'fulfillment.db');
  const marker = join(destination, 'portable-import.json');
  if (existsSync(targetDb)) {
    if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).id === manifest.id) return { status: 'already_imported', id: manifest.id };
    throw new Error('이 PC에 업무 DB가 이미 있습니다. 기존 DB를 덮어쓰지 않았습니다. 새 폴더에서 처음 설정을 실행하세요.');
  }
  if (existsSync(join(destination, 'workflow-state.json'))) throw new Error('기존 작업 설정이 있습니다. 새 폴더에서 이전하세요.');
  const snapshot = readFileSync(join(source, 'fulfillment.db'));
  if (sha(snapshot) !== manifest.databaseSha256) throw new Error('이전 DB 파일이 변경됐습니다. 원본 패키지를 다시 복사하세요.');
  const stateBytes = manifest.stateSha256 ? readFileSync(join(source, 'workflow-state.json')) : null;
  if (stateBytes && sha(stateBytes) !== manifest.stateSha256) throw new Error('이전 작업 설정 파일이 변경됐습니다.');
  const mappings = new Map();
  const verified = manifest.files.map(file => {
    const path = inside(source, file.path), bytes = readFileSync(path);
    if (sha(bytes) !== file.sha256) throw new Error(`이전 파일이 변경됐습니다: ${basename(file.path)}`);
    const newPath = inside(root, join('data', 'migrated-files', basename(file.path)));
    mappings.set(file.oldPath, newPath);
    return { bytes, newPath };
  });
  mkdirSync(join(destination, 'migrated-files'), { recursive: true });
  for (const file of verified) {
    if (existsSync(file.newPath) && sha(readFileSync(file.newPath)) !== sha(file.bytes)) throw new Error('이미 다른 업무 파일이 있습니다. 새 폴더에서 이전하세요.');
    writeFileSync(file.newPath, file.bytes);
  }
  const stagedDb = join(destination, `portable-${randomUUID()}.db`);
  writeFileSync(stagedDb, snapshot, { flag: 'wx' });
  const db = new DatabaseSync(stagedDb);
  const replace = value => typeof value === 'string' && mappings.has(value) ? mappings.get(value) : value;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const table of tableRows(db)) for (const row of table.rows) for (const column of table.columns) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      let updated = value;
      if (column.endsWith('_json')) { try { updated = JSON.stringify(walk(JSON.parse(value), replace)); } catch {} }
      else updated = replace(value);
      if (updated !== value) db.prepare(`UPDATE ${quote(table.name)} SET ${quote(column)} = ? WHERE rowid = ?`).run(updated, row._portable_row_id);
    }
    db.exec('COMMIT');
    for (const [table, expected] of Object.entries(manifest.counts)) {
      if (db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n !== expected) throw new Error('이전 후 업무 기록 수가 일치하지 않습니다.');
    }
  } finally { db.close(); }
  if (stateBytes) writeFileSync(join(destination, 'workflow-state.json'), JSON.stringify(walk(JSON.parse(stateBytes.toString('utf8')), replace), null, 2), { flag: 'wx' });
  renameSync(stagedDb, targetDb);
  const report = { status: 'imported', id: manifest.id, importedAt: new Date().toISOString(), files: verified.length, counts: manifest.counts,
    missingFiles: manifest.missingFiles, templatePath: mappings.get(manifest.templateOldPath) || null };
  writeFileSync(marker, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root = process.cwd(), destination] = process.argv.slice(2);
  try {
    const result = command === 'export' ? await exportPortableData(root, destination) : command === 'restore' ? restorePortableData(root, destination) : null;
    if (!result) throw new Error('export 또는 restore 명령을 사용하세요.');
    console.log(JSON.stringify({ status: result.status || 'exported', id: result.id, files: Array.isArray(result.files) ? result.files.length : result.files, missingFiles: result.missingFiles?.length || 0, templatePath: result.templatePath || null }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
