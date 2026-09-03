#!/usr/bin/env node
// capsule.mjs — pack a Claude Code user harness (~/.claude) into a portable tarball and apply it elsewhere.
// Zero deps: Node builtins + system `tar`. Node 20+.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const AGENTS_HOME = path.join(HOME, '.agents');
const TOKEN = '__CAPSULE_HOME__';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MANIFEST_NAME = '.capsule-manifest.json';
const RELEASE_REPO = process.env.CAPSULE_REPO || 'ucsandman/agent-capsule';
// where `secrets push` writes its short-lived 0600 file; set CAPSULE_SCRATCH to keep it off the system temp dir
const SCRATCH_DIR = process.env.CAPSULE_SCRATCH || os.tmpdir();
const TOP_LEVEL_FILES = ['CLAUDE.md', 'AGENTS.md', 'agnostic-rules.md', 'SOUL.md', 'RTK.md', 'keybindings.json'];
const TOP_LEVEL_DIRS = ['hooks', 'skills', 'agents', 'commands', 'workflows', 'local-plugins', 'docs', 'scripts', 'tools', 'get-shit-done'];
const GENERIC_REWRITE_EXTS = new Set(['.cjs', '.py', '.md', '.json', '.yaml']);
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.db', '.sqlite', '.exe', '.dll', '.zip', '.tgz', '.gz', '.pyc', '.woff', '.woff2', '.ttf', '.wasm', '.pdf']);
// ---------- provision: how each hook binary is installed on a fresh Linux box ----------
// cargo's `rtk` crate is an unrelated "Rust Type Kit" (verified 2026-09-03), so rtk comes from its GitHub release.
const PROVISION_TABLE = {
  'rtk': { github: { repo: 'rtk-ai/rtk', asset: 'rtk-x86_64-unknown-linux-musl.tar.gz', bin: 'rtk' } },
  'repowise-rewrite': { pip: 'repowise' },
  'pwsh': { apt: 'powershell' },
  'powershell': { apt: 'powershell' },
};
// `python3 -m <module>` hooks whose module is not on PyPI and ships from a local source tree instead
const LOCAL_PY_PACKAGES = {
  context_handoff_bundle: { name: 'context-handoff-bundle', src: path.join(HOME, 'clawd', 'projects', 'context-handoff-bundle') },
};
const PYPKG_KEEP = ['src', 'pyproject.toml', 'README.md', 'LICENSE'];
const PYPKG_SKIP_RE = /[\\/](__pycache__|[^\\/]*\.egg-info)([\\/]|$)|\.pyc$/;
// ---------- path / text helpers ----------
function fwd(p) { return p.split(path.sep).join('/'); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function underHome(p) {
  const rp = path.resolve(p).toLowerCase(), hp = path.resolve(HOME).toLowerCase();
  return rp === hp || rp.startsWith(hp + path.sep.toLowerCase());
}
function redact(s) { return String(s).slice(0, 4) + '***'; }
// ---------- exclusion rules (whitelist of what to walk, this filters within it) ----------
const EXACT_NAMES = new Set([
  '__pycache__', 'cache', 'debug', 'logs', 'telemetry', 'session-env', 'session-data', 'paste-cache',
  'shell-snapshots', 'image-cache', 'archive', 'skills-archive', 'tasks', 'jobs', 'metrics',
  'opus-handoff-injected', 'meditations', 'ide', 'chrome', 'file-history', 'downloads', 'homunculus',
  'backups', 'history.jsonl', 'corrections.jsonl', 'stats-cache.json', 'mcp-health-cache.json',
  '%systemdrive%', '--full-page', 'keys', 'load-secrets.sh', '.secrets.env', '.env',
  'node_modules', 'tests', 'fleet', 'superpowers',
]);
const PREFIX_NAMES = ['backups-', 'error-log', 'daemon'];
const CODE_EXTS = new Set(['.cjs', '.js', '.mjs', '.py', '.ps1', '.vbs']);
const SOFT_SUBSTRINGS = ['token', 'credential', 'creds']; // only applied to non-code files
function isExcludedName(name) {
  const lower = name.toLowerCase();
  if (EXACT_NAMES.has(lower) || lower.includes('.bak')) return true;
  if (/^\.env(\..+)?$/.test(lower)) return true;
  if (lower.endsWith('.pem') || lower.endsWith('.key')) return true;
  if (PREFIX_NAMES.some((p) => lower.startsWith(p))) return true;
  const ext = path.extname(lower);
  return !CODE_EXTS.has(ext) && SOFT_SUBSTRINGS.some((s) => lower.includes(s));
}
// ---------- staging copy: exclusion + symlink aware, never follows a symlink out of HOME ----------
function copyTree(srcAbs, destAbs, log) {
  let st;
  try { st = fs.lstatSync(srcAbs); } catch { return; } // missing (e.g. keybindings.json): skip silently
  if (isExcludedName(path.basename(srcAbs))) return;
  if (st.isSymbolicLink()) {
    let real;
    try { real = fs.realpathSync(srcAbs); } catch { console.warn(`skip broken symlink: ${fwd(srcAbs)}`); return; }
    if (!underHome(real)) { console.warn(`skip symlink out of HOME: ${fwd(srcAbs)} -> ${fwd(real)}`); return; }
    log?.push(`dereferenced symlink ${fwd(path.relative(CLAUDE_HOME, srcAbs))} -> ${fwd(real)}`);
    srcAbs = real; st = fs.statSync(real);
  }
  if (st.isDirectory()) {
    fs.mkdirSync(destAbs, { recursive: true });
    for (const e of fs.readdirSync(srcAbs)) copyTree(path.join(srcAbs, e), path.join(destAbs, e), log);
  } else if (st.isFile()) {
    if (st.size > MAX_FILE_BYTES) { console.warn(`skip oversized file (${st.size}B): ${fwd(srcAbs)}`); return; }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
  }
}
function walkDir(root, fn, dir = root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(root, fn, abs);
    else if (e.isFile()) fn(abs, fwd(path.relative(root, abs)));
  }
}
// ---------- __CAPSULE_HOME__ / interpreter rewrite ----------
const homeParts = fwd(CLAUDE_HOME).split('/');
const HOME_RE = new RegExp(homeParts.map(escapeRegex).join('[\\\\/]{1,2}'), 'gi');
const driveLetter = homeParts[0].replace(':', '').toLowerCase();
const GITBASH_RE = new RegExp(escapeRegex('/' + driveLetter + '/' + homeParts.slice(1).join('/')), 'gi');
const PROJECTS_RE = /[A-Za-z]:[\\/]{1,2}Projects[\\/]{1,2}([A-Za-z0-9_.-]+)[\\/]{1,2}/gi;
// bare home dir (e.g. C:/Users/sandm/.dashclaw/...) after the .claude-specific passes have consumed their matches
const BARE_HOME_RE = new RegExp(fwd(HOME).split('/').map(escapeRegex).join('[\\\\/]{1,2}') + '(?=[\\\\/])', 'gi');
function rewriteText(s, { interpreters = false } = {}) {
  let count = 0;
  let out = s.replace(HOME_RE, () => { count++; return TOKEN + '/.claude'; });
  out = out.replace(GITBASH_RE, () => { count++; return TOKEN + '/.claude'; });
  out = out.replace(PROJECTS_RE, (m, repo) => { count++; return `${TOKEN}/.claude/ext/${repo}/`; });
  out = out.replace(BARE_HOME_RE, () => { count++; return TOKEN; });
  if (interpreters) {
    out = out.replace(/\bpy -3\.12\b/g, () => { count++; return 'python3'; });
    out = out.replace(/(^|[\s"])python(?!3)(\s+)/g, (m, pre, ws) => { count++; return `${pre}python3${ws}`; });
  }
  return [out, count];
}
// ---------- external hook source discovery (C:/Projects/<repo>/... referenced by settings.json) ----------
function extractExternalRefs(cmd) {
  const re = /[A-Za-z]:[\\/]{1,2}Projects[\\/]{1,2}([A-Za-z0-9_.-]+)[\\/]{1,2}([^\s"']+\.(?:py|cjs|mjs|js|ps1))/gi;
  const out = []; let m;
  while ((m = re.exec(cmd))) out.push({ repo: m[1], relPath: m[2].replace(/\\/g, '/') });
  return out;
}
function copyExternalFile(stageDir, repo, relPath, copiedSet) {
  const key = `${repo}/${relPath}`;
  if (copiedSet.has(key)) return;
  const absSrc = `C:/Projects/${repo}/${relPath}`;
  if (!fs.existsSync(absSrc)) { console.warn(`external hook missing on disk: ${absSrc}`); return; }
  if (fs.statSync(absSrc).size > MAX_FILE_BYTES) { console.warn(`skip oversized external file: ${absSrc}`); return; }
  const destAbs = path.join(stageDir, 'ext', repo, relPath);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(absSrc, destAbs);
  copiedSet.add(key);
  if (!relPath.endsWith('.py')) return;
  const content = fs.readFileSync(absSrc, 'utf8'), dir = path.dirname(relPath);
  for (const m of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm)) {
    const siblingRel = (dir === '.' ? '' : dir + '/') + m[1] + '.py';
    if (fs.existsSync(`C:/Projects/${repo}/${siblingRel}`)) copyExternalFile(stageDir, repo, siblingRel, copiedSet);
    // sibling package directory (e.g. hooks/dashclaw_agent_intel/): copy whole package, skip caches/tests
    const pkgRel = (dir === '.' ? '' : dir + '/') + m[1], pkgAbs = `C:/Projects/${repo}/${pkgRel}`;
    if (fs.existsSync(path.join(pkgAbs, '__init__.py')) && !copiedSet.has(`${repo}/${pkgRel}/`)) {
      copiedSet.add(`${repo}/${pkgRel}/`);
      fs.cpSync(pkgAbs, path.join(stageDir, 'ext', repo, pkgRel), { recursive: true,
        filter: (src) => !/[\\/](__pycache__|tests?|\.pytest_cache)([\\/]|$)|\.pyc$/.test(src) });
    }
  }
}
// ---------- settings.json processing ----------
function stageSettings(stageDir) {
  const original = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, 'settings.json'), 'utf8'));
  const hooksManifest = [], dropped = [], externalRepos = new Set(), copiedExt = new Set();
  let rewrittenCount = 0;
  const newHooks = {};
  for (const event of Object.keys(original.hooks || {})) {
    const groups = [];
    for (const group of original.hooks[event]) {
      const keptHooks = [];
      for (const h of group.hooks || []) {
        const origCmd = h.command;
        if (origCmd.includes('Media.SoundPlayer')) { dropped.push({ event, command: origCmd }); continue; }
        for (const ref of extractExternalRefs(origCmd)) {
          externalRepos.add(ref.repo);
          copyExternalFile(stageDir, ref.repo, ref.relPath, copiedExt);
        }
        const [rewrittenCmd, n] = rewriteText(origCmd, { interpreters: true });
        rewrittenCount += n;
        const entry = { event, original: origCmd, rewritten: rewrittenCmd };
        if (/^\s*pwsh\s/.test(origCmd) || /^\s*powershell\s/.test(origCmd)) entry.needs_pwsh = true;
        hooksManifest.push(entry);
        keptHooks.push({ ...h, command: rewrittenCmd });
      }
      if (keptHooks.length) groups.push({ ...group, hooks: keptHooks });
    }
    if (groups.length) newHooks[event] = groups;
  }
  // statusLine: pack the file only if it lives under ~/.claude; rewrite its command text either way.
  let statusLine = original.statusLine, notes = [];
  if (statusLine && typeof statusLine.command === 'string') {
    const quoted = statusLine.command.match(/"([^"]+)"/);
    if (quoted && quoted[1].toLowerCase().startsWith(CLAUDE_HOME.toLowerCase())) {
      copyTree(quoted[1], path.join(stageDir, path.relative(CLAUDE_HOME, quoted[1])));
    } else if (quoted) {
      notes.push(`note: statusLine target (${quoted[1]}) is outside ~/.claude and was not packed`);
    }
    const [rewrittenCmd, n] = rewriteText(statusLine.command);
    rewrittenCount += n;
    statusLine = { ...statusLine, command: rewrittenCmd };
  }
  if (original.env?.BASH_ENV && !underHome(original.env.BASH_ENV)) {
    notes.push(`note: env.BASH_ENV (${original.env.BASH_ENV}) is outside ~/.claude and will not be portable`);
  }
  const env = {};
  for (const [k, v] of Object.entries(original.env || {})) env[k] = typeof v === 'string' ? rewriteText(v)[0] : v;
  const finalSettings = { ...original, env, hooks: newHooks, statusLine };
  fs.writeFileSync(path.join(stageDir, 'settings.json'), JSON.stringify(finalSettings, null, 2) + '\n');
  const binaries = new Set(hooksManifest.map((h) => h.rewritten.trim().split(/\s+/)[0]).filter(Boolean));
  if (statusLine?.command) binaries.add(statusLine.command.trim().split(/\s+/)[0]);
  return { hooksManifest, dropped, external: [...externalRepos], binaries: [...binaries].sort(), rewrittenCount, notes };
}
// ---------- provision derivation + local python package staging ----------
function stagePyPackage(stageDir, pkg) {
  if (!fs.existsSync(pkg.src)) { console.warn(`local python package missing on disk: ${fwd(pkg.src)}`); return null; }
  const destRoot = path.join(stageDir, 'ext', 'pypkg', pkg.name);
  let staged = 0;
  for (const entry of PYPKG_KEEP) {
    const src = path.join(pkg.src, entry);
    if (!fs.existsSync(src)) { console.warn(`pypkg ${pkg.name}: missing ${entry}`); continue; }
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, path.join(destRoot, entry), { recursive: true, filter: (s) => !PYPKG_SKIP_RE.test(s) });
    else copyTree(src, path.join(destRoot, entry));
    staged++;
  }
  return staged ? `ext/pypkg/${pkg.name}` : null;
}
function deriveProvision(stageDir, binaries, hooks) {
  const p = { pip: [], pip_local: [], cargo: [], apt: [], github: [], manual: [] };
  const push = (list, v) => { if (!list.some((x) => JSON.stringify(x) === JSON.stringify(v))) list.push(v); };
  for (const bin of binaries) {
    const rule = PROVISION_TABLE[bin];
    if (!rule) continue;
    for (const kind of ['pip', 'cargo', 'apt']) if (rule[kind]) push(p[kind], rule[kind]);
    if (rule.github) push(p.github, rule.github);
    if (rule.manual) push(p.manual, bin);
  }
  const modules = new Set();
  for (const h of hooks) {
    const m = h.rewritten.match(/\bpython3?\s+-m\s+([A-Za-z_][A-Za-z0-9_.]*)/);
    if (m) modules.add(m[1].split('.')[0]);
  }
  for (const mod of modules) {
    const pkg = LOCAL_PY_PACKAGES[mod];
    const rel = pkg ? stagePyPackage(stageDir, pkg) : null;
    if (rel) push(p.pip_local, rel); else push(p.manual, mod);
  }
  return p;
}
// ---------- generic __CAPSULE_HOME__ rewrite over the rest of stage (.cjs/.py/.md/.json/.yaml) ----------
function rewriteStageTextFiles(stageDir) {
  const rewritten = {};
  walkDir(stageDir, (abs, rel) => {
    if (rel === 'settings.json' || !GENERIC_REWRITE_EXTS.has(path.extname(abs).toLowerCase())) return;
    const [out, count] = rewriteText(fs.readFileSync(abs, 'utf8'));
    if (count > 0) { fs.writeFileSync(abs, out); rewritten[rel] = count; }
  });
  return rewritten;
}
// ---------- secret scan: every non-binary text file in stage ----------
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, /\bsk-[A-Za-z0-9]{20,}\b/g, /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g, /xox[bap]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g,
];
const PLACEHOLDER_RE = /your_|<|example|changeme|xxx|placeholder|redacted|test/i;
function isBinaryLike(abs) {
  if (BINARY_EXTS.has(path.extname(abs).toLowerCase())) return true;
  try {
    const fd = fs.openSync(abs, 'r'), buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch { return true; }
  return false;
}
function scanForSecrets(stageDir) {
  const hits = [];
  walkDir(stageDir, (abs, rel) => {
    if (isBinaryLike(abs)) return;
    let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
    text.split('\n').forEach((line, idx) => {
      if (/^-----BEGIN [A-Z ]*PRIVATE KEY/.test(line)) hits.push({ rel, line: idx + 1, snippet: redact(line) });
      for (const re of SECRET_PATTERNS) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(line))) hits.push({ rel, line: idx + 1, snippet: redact(m[0]) });
      }
      const kv = line.match(/^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(\S{8,})\s*$/);
      if (kv && !kv[2].includes('(') && !PLACEHOLDER_RE.test(kv[2])) hits.push({ rel, line: idx + 1, snippet: redact(kv[2]) });
    });
  });
  return hits;
}
// ---------- pack ----------
function pack(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const stageDir = path.join(outDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  const symlinkLog = [];
  for (const f of TOP_LEVEL_FILES) copyTree(path.join(CLAUDE_HOME, f), path.join(stageDir, f), symlinkLog);
  for (const d of TOP_LEVEL_DIRS) copyTree(path.join(CLAUDE_HOME, d), path.join(stageDir, d), symlinkLog);
  symlinkLog.forEach((l) => console.log(l));
  // plugins/: top-level files only, never recurse into cache/repos/marketplaces/data/auto-docs
  const pluginsDir = path.join(CLAUDE_HOME, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (e.isFile()) copyTree(path.join(pluginsDir, e.name), path.join(stageDir, 'plugins', e.name));
    }
  }
  // projects/*/memory only
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      const memSrc = path.join(projectsDir, e.name, 'memory');
      if (e.isDirectory() && fs.existsSync(memSrc)) copyTree(memSrc, path.join(stageDir, 'projects', e.name, 'memory'));
    }
  }
  // ~/.agents/memory -> agents-memory/
  const agentsMemSrc = path.join(AGENTS_HOME, 'memory');
  if (fs.existsSync(agentsMemSrc)) copyTree(agentsMemSrc, path.join(stageDir, 'agents-memory'));
  const settingsResult = stageSettings(stageDir);
  const provision = deriveProvision(stageDir, settingsResult.binaries, settingsResult.hooksManifest);
  const genericRewritten = rewriteStageTextFiles(stageDir);
  // test seam (kept intentionally): plant a fake secret to prove the scanner fails on purpose.
  // Built from parts so this fixture value never appears contiguous in source.
  if (process.env.CAPSULE_TEST_PLANT === '1') {
    const fakeVal = ['ghp_abcdefghijklmnopqrstuvwxyz', '0123456789'].join('');
    fs.writeFileSync(path.join(stageDir, 'hooks', '_plant.txt'), `GITHUB_TOKEN=${fakeVal}\n`);
  }
  const hits = scanForSecrets(stageDir);
  if (hits.length) {
    console.error(`SECRET SCAN FAILED: ${hits.length} hit(s)`);
    for (const h of hits) console.error(`${h.rel}:${h.line}  ${h.snippet}`);
    fs.rmSync(stageDir, { recursive: true, force: true });
    process.exit(2);
  }
  const files = []; let bytes = 0;
  walkDir(stageDir, (abs, rel) => { files.push(rel); bytes += fs.statSync(abs).size; });
  const manifest = {
    version: 1, packedAt: new Date().toISOString(), sourceOS: process.platform, sourceHome: fwd(HOME),
    files: files.sort(), bytes,
    hooks: settingsResult.hooksManifest, binaries: settingsResult.binaries, external: settingsResult.external,
    dropped: settingsResult.dropped,
    rewritten: { 'settings.json': settingsResult.rewrittenCount, ...genericRewritten },
    provision,
    notPortable: ['~/.claude.json (MCP servers + OAuth)', 'plugins/ (reinstall from enabledPlugins)'],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(stageDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  const tgzPath = path.join(outDir, 'capsule.tgz');
  const tar = spawnSync('tar', ['--force-local', '-czf', fwd(tgzPath), '-C', fwd(stageDir), '.'], { stdio: 'inherit' });
  if (tar.status !== 0) { console.error('tar failed'); process.exit(1); }
  console.log('--- capsule pack summary ---');
  console.log(`files: ${files.length}  bytes(staged): ${bytes}  bytes(tgz): ${fs.statSync(tgzPath).size}`);
  console.log(`hooks kept: ${settingsResult.hooksManifest.length}  dropped: ${settingsResult.dropped.length}`);
  console.log(`external repos: ${settingsResult.external.join(', ') || '(none)'}`);
  console.log(`binaries required: ${settingsResult.binaries.join(', ')}`);
  console.log(`provision: pip=${provision.pip.join(',') || '-'} pip_local=${provision.pip_local.join(',') || '-'} ` +
    `cargo=${provision.cargo.join(',') || '-'} github=${provision.github.map((g) => g.repo).join(',') || '-'} ` +
    `apt=${provision.apt.join(',') || '-'} manual=${provision.manual.join(',') || '-'}`);
  settingsResult.notes.forEach((n) => console.log(n));
  console.log(`wrote ${tgzPath}`);
}
// ---------- apply ----------
const ts = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
function apply(capsulePath, targetHome, dryRun) {
  const claudeTarget = path.join(targetHome, '.claude');
  let extractDest;
  if (dryRun) {
    extractDest = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-dryrun-'));
    console.log(`[dry-run] extracting to ${extractDest} (not touching ${claudeTarget})`);
  } else {
    if (fs.existsSync(claudeTarget)) {
      const backup = `${claudeTarget}.pre-capsule-${ts()}`;
      fs.renameSync(claudeTarget, backup);
      console.log(`backed up existing .claude to ${backup}`);
      fs.mkdirSync(claudeTarget, { recursive: true });
      // runtime state the capsule never carries: keep the target's own auth, sessions, transcripts, plugins
      // load-secrets.sh is never packed (it holds live values) but env.BASH_ENV points at it, and a missing
      // BASH_ENV target fails silently — losing it on re-apply would quietly unauthenticate every hook.
      for (const keep of ['.credentials.json', '.last-cleanup', 'history.jsonl', 'sessions', 'projects', 'plugins', 'cache', 'backups', 'load-secrets.sh']) {
        const src = path.join(backup, keep);
        if (fs.existsSync(src)) { fs.cpSync(src, path.join(claudeTarget, keep), { recursive: true }); console.log(`kept target state: ${keep}`); }
      }
    }
    fs.mkdirSync(claudeTarget, { recursive: true });
    extractDest = claudeTarget;
  }
  const tar = spawnSync('tar', ['--force-local', '-xzf', fwd(capsulePath), '-C', fwd(extractDest)], { stdio: 'inherit' });
  if (tar.status !== 0) { console.error('tar extract failed'); process.exit(1); }
  const manifestPath = path.join(extractDest, MANIFEST_NAME);
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const realHome = fwd(targetHome);
  const rewriteTargets = new Set(['settings.json', ...(manifest ? Object.keys(manifest.rewritten || {}) : [])]);
  for (const rel of rewriteTargets) {
    const abs = path.join(extractDest, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes(TOKEN)) fs.writeFileSync(abs, text.split(TOKEN).join(realHome));
  }
  const agentsMemExtracted = path.join(extractDest, 'agents-memory');
  if (fs.existsSync(agentsMemExtracted)) {
    if (dryRun) {
      console.log(`[dry-run] would move agents-memory -> ${path.join(targetHome, '.agents', 'memory')}`);
    } else {
      const agentsDest = path.join(targetHome, '.agents', 'memory');
      fs.mkdirSync(path.dirname(agentsDest), { recursive: true });
      fs.cpSync(agentsMemExtracted, agentsDest, { recursive: true });
      fs.rmSync(agentsMemExtracted, { recursive: true, force: true });
    }
  }
  const present = {};
  for (const name of manifest ? manifest.binaries : []) {
    const checkName = process.platform !== 'win32' && name === 'powershell' ? 'pwsh' : name;
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [checkName], { shell: false });
    present[name] = res.status === 0;
  }
  let restoredCount = 0;
  walkDir(dryRun ? extractDest : claudeTarget, () => { restoredCount++; });
  console.log('--- capsule apply report ---');
  console.log(`restored files: ${restoredCount}`);
  if (!manifest) { console.log('no manifest found inside capsule; skipping detailed report'); return; }
  const runnable = manifest.hooks.filter((h) => present[h.rewritten.trim().split(/\s+/)[0]] !== false);
  const blocked = manifest.hooks.filter((h) => !runnable.includes(h));
  console.log(`hooks that will run: ${runnable.length}`);
  runnable.forEach((h) => console.log(`  [${h.event}] ${h.rewritten.split(TOKEN).join(realHome)}`));
  console.log(`hooks needing a missing binary: ${blocked.length}`);
  blocked.forEach((h) => console.log(`  [${h.event}] ${h.rewritten.split(TOKEN).join(realHome)}`));
  console.log(`dropped hooks: ${manifest.dropped.length}`);
  manifest.dropped.forEach((d) => console.log(`  [${d.event}] ${d.command}`));
  console.log('binary check:');
  Object.entries(present).forEach(([name, ok]) => console.log(`  ${name}: ${ok ? 'present' : 'MISSING'}`));
  console.log('not portable:');
  manifest.notPortable.forEach((n) => console.log(`  ${n}`));
}
// ---------- doctor: dry-execute every configured hook, never mutate anything ----------
const doctorPass = (r) => r.code === 0 || r.code === 2; // 2 = a guard deliberately blocking, still a working hook
function runDoctor(targetHome, extraPath = []) {
  const settings = JSON.parse(fs.readFileSync(path.join(targetHome, '.claude', 'settings.json'), 'utf8'));
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'capsule-doctor', cwd: fwd(targetHome) });
  const env = { ...process.env, HOME: targetHome };
  if (extraPath.length) env.PATH = [...extraPath, env.PATH].join(path.delimiter);
  const rows = [];
  for (const event of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[event]) {
      for (const h of group.hooks || []) {
        const res = spawnSync(h.command, { shell: true, input: stdin, timeout: 15000, env });
        const code = res.status === null ? 'timeout' : res.status;
        const stderrLine = (res.stderr ? res.stderr.toString() : '').split('\n')[0] || '';
        rows.push({ event, command: h.command, code, stderrLine });
      }
    }
  }
  return rows;
}
function printDoctor(rows) {
  console.log('--- capsule doctor ---');
  for (const r of rows) {
    const cmdShort = r.command.length > 80 ? r.command.slice(0, 77) + '...' : r.command;
    console.log(`${r.event.padEnd(16)} | ${cmdShort.padEnd(80)} | ${String(r.code).padEnd(6)} | ${r.stderrLine}`);
  }
  console.log(`hooks: ${rows.filter(doctorPass).length}/${rows.length} pass`);
}
// ---------- provision: install what the hooks need. Runs ON the target box, after apply. ----------
function shOut(cmd, env) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env, timeout: 30000 });
  // `python3 -c "import x"` succeeds silently, so exit 0 with no stdout still means present
  return r.status === 0 ? ((r.stdout || '').trim().split('\n')[0].trim() || 'ok') : '';
}
const whichCmd = (name) => (process.platform === 'win32' ? `where ${name}` : `command -v ${name}`);
function binForInstall(kind, target) {
  for (const [bin, rule] of Object.entries(PROVISION_TABLE)) if (rule[kind] === target) return bin;
  return target;
}
function provisionSteps(p, claudeDir) {
  const steps = [];
  for (const pkg of p.pip || []) steps.push({ kind: 'pip', label: pkg, check: whichCmd(binForInstall('pip', pkg)),
    cmd: `python3 -m pip install --user ${pkg}`, uv: `uv pip install --system ${pkg}`,
    bsp: `python3 -m pip install --user --break-system-packages ${pkg}` });
  for (const rel of p.pip_local || []) {
    const dir = fwd(path.join(claudeDir, rel)), mod = path.basename(rel).replace(/-/g, '_');
    steps.push({ kind: 'pip_local', label: rel, check: `python3 -c "import ${mod}"`,
      cmd: `python3 -m pip install --user -e "${dir}"`, uv: `uv pip install --system -e "${dir}"`,
      bsp: `python3 -m pip install --user --break-system-packages -e "${dir}"` });
  }
  for (const crate of p.cargo || []) steps.push({ kind: 'cargo', label: crate, check: whichCmd(binForInstall('cargo', crate)), cmd: `cargo install ${crate}` });
  for (const g of p.github || []) steps.push({ kind: 'github', label: `${g.repo}/${g.asset}`, check: whichCmd(g.bin),
    cmd: `set -e; d=$(mktemp -d); curl -fsSL -o "$d/a.tgz" https://github.com/${g.repo}/releases/latest/download/${g.asset}; ` +
      `tar xzf "$d/a.tgz" -C "$d"; b=$(find "$d" -type f -name ${g.bin} | head -1); mkdir -p "$HOME/.local/bin"; ` +
      `install -m 755 "$b" "$HOME/.local/bin/${g.bin}"; rm -rf "$d"` });
  for (const pkg of p.apt || []) steps.push({ kind: 'apt', label: pkg, needsApt: true, check: whichCmd(binForInstall('apt', pkg)),
    cmd: `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}` });
  return steps;
}
function provision(targetHome, { dryRun = false, apt = false } = {}) {
  const claudeDir = path.join(targetHome, '.claude'), manifestPath = path.join(claudeDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) { console.error(`no ${MANIFEST_NAME} under ${fwd(claudeDir)} — run \`capsule apply\` first`); process.exit(1); }
  const p = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).provision) || {};
  const localBin = path.join(targetHome, '.local', 'bin'), cargoBin = path.join(targetHome, '.cargo', 'bin');
  const extraPath = [localBin, cargoBin];
  const env = { ...process.env, HOME: targetHome, CARGO_INSTALL_ROOT: path.join(targetHome, '.local'),
    PATH: [...extraPath, process.env.PATH].join(path.delimiter) };
  const steps = provisionSteps(p, claudeDir);
  const before = dryRun ? [] : runDoctor(targetHome, extraPath);
  const results = [];
  for (const s of steps) {
    if (s.needsApt && !apt) { console.log(`[skip] ${s.kind} ${s.label}: needs --apt (sudo)`); results.push({ ...s, code: 'skipped-no-apt' }); continue; }
    const already = shOut(s.check, env);
    if (already) { console.log(`[skip] ${s.kind} ${s.label}: already present at ${already}`); results.push({ ...s, code: 0, landed: already }); continue; }
    if (dryRun) { console.log(`[dry-run] ${s.kind}: ${s.cmd}`); results.push({ ...s, code: 'dry-run' }); continue; }
    // pip -> uv -> pip --break-system-packages. A uv-managed python3 (PEP 668) refuses the first two;
    // --user --break-system-packages writes only to the user site dir, never the managed install.
    const chain = [s.cmd, ...(s.uv ? [s.uv] : []), ...(s.bsp ? [s.bsp] : [])];
    let r, stderr = '';
    for (let i = 0; i < chain.length; i++) {
      if (i > 0) console.log(`  refused (externally-managed) -> retry: ${chain[i]}`);
      r = spawnSync(chain[i], { shell: true, encoding: 'utf8', env, timeout: 900000 });
      stderr = r.stderr || '';
      s.cmd = chain[i];
      if (r.status === 0 || !/externally[- ]managed/i.test(stderr + (r.stdout || ''))) break;
    }
    const code = r.status === null ? 'timeout' : r.status;
    const errLine = stderr.split('\n').filter((l) => l.trim())[0] || '';
    const landed = shOut(s.check, env);
    console.log(`[${s.kind}] ${s.cmd}`);
    console.log(`  exit=${code}  ${errLine ? 'stderr[0]: ' + errLine.slice(0, 140) : ''}`);
    console.log(`  check: ${s.check} -> ${landed || 'NOT FOUND'}`);
    results.push({ ...s, code, errLine, landed });
  }
  if (dryRun) { console.log(`--- capsule provision (dry-run) --- steps: ${steps.length}`); return; }
  const after = runDoctor(targetHome, extraPath);
  const cnt = (rows) => `${rows.filter(doctorPass).length}/${rows.length}`;
  console.log('--- capsule provision report ---');
  for (const r of results) console.log(`  ${String(r.kind).padEnd(9)} ${String(r.label).slice(0, 46).padEnd(46)} exit=${String(r.code).padEnd(14)} ${r.landed || ''}`);
  console.log(`doctor before: ${cnt(before)} pass   after: ${cnt(after)} pass`);
  after.filter((r) => !doctorPass(r)).forEach((r) => console.log(`  still failing [${r.event}] ${r.command.slice(0, 64)} -> ${r.code} ${r.stderrLine.slice(0, 80)}`));
  // probe the *login* PATH with a clean env — inheriting our augmented PATH would mask a real gap
  const loginPath = process.platform === 'win32' ? '' : shOut(`env -i HOME="${fwd(targetHome)}" bash -lc 'echo $PATH'`, process.env);
  if (loginPath && !loginPath.split(':').includes(fwd(localBin))) {
    console.log(`PATH hint: add to your login shell -> export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"`);
  }
}
// ---------- secrets: names the capsule's own hooks read, pushed to a devbox as ~/.claude/load-secrets.sh ----------
const ENV_NAME_RES = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g, /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /os\.environ(?:\.get)?[([]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g, /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];
const ENV_SCAN_EXTS = new Set(['.cjs', '.js', '.mjs', '.py', '.ps1']);
const NON_SECRET_ENV = new Set(['TEMP', 'TMP', 'TMPDIR', 'HOME', 'PATH', 'PWD', 'OS', 'SHELL', 'USER', 'USERNAME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'COMSPEC', 'CI', 'NODE_ENV', 'BASH_ENV',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT']);
function detectSecretNames(root) {
  const names = new Set();
  for (const sub of ['hooks', 'ext', 'scripts', 'tools']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    walkDir(dir, (abs) => {
      if (!ENV_SCAN_EXTS.has(path.extname(abs).toLowerCase())) return;
      let t; try { t = fs.readFileSync(abs, 'utf8'); } catch { return; }
      for (const re of ENV_NAME_RES) { re.lastIndex = 0; let m; while ((m = re.exec(t))) names.add(m[1]); }
    });
  }
  const sp = path.join(root, 'settings.json');
  if (fs.existsSync(sp)) { try { Object.keys(JSON.parse(fs.readFileSync(sp, 'utf8')).env || {}).forEach((k) => names.add(k)); } catch { /* ignore */ } }
  return [...names].filter((n) => n.startsWith('DASHCLAW_') || (!NON_SECRET_ENV.has(n) && !/_(HOME|DIR|PATH|FILE)$/.test(n))).sort();
}
function capsuleScanRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const staged = path.resolve('dist', 'stage');
  return fs.existsSync(path.join(staged, 'settings.json')) ? staged : CLAUDE_HOME;
}
const isSet = (n) => typeof process.env[n] === 'string' && process.env[n] !== '';
function secretsList(root) {
  const names = detectSecretNames(root), set = names.filter(isSet);
  console.log(`--- capsule secrets (scanned ${fwd(root)}) ---`);
  names.forEach((n) => console.log(`  ${isSet(n) ? 'SET   ' : 'unset '} ${n}`)); // names only, never values
  console.log(`detected=${names.length} set=${set.length}`);
  return set;
}
function devboxBin() {
  return process.env.DEVBOX_BIN || (process.platform === 'win32'
    ? path.join(HOME, 'AppData', 'Local', 'Programs', 'devbox', 'devbox.exe') : 'devbox');
}
function secretsPush(devboxName, wanted, root) {
  // Default is the DASHCLAW_* slice of the detected set — the names this harness's hooks authenticate with.
  // The scan also finds unrelated live keys (Stripe/GitHub/Resend/...); those only go over if named explicitly.
  const detected = detectSecretNames(root);
  const names = (wanted.length ? wanted : detected.filter((n) => n.startsWith('DASHCLAW_') && !/_(DIR|PATH|FILE)$/.test(n))).filter(isSet);
  if (!names.length) { console.error('no detected secret names are set in this shell — nothing to push'); process.exit(1); }
  if (!wanted.length) console.log(`default scope: DASHCLAW_* (${detected.length} names detected; name others explicitly to push them)`);
  const dir = fs.existsSync(SCRATCH_DIR) ? SCRATCH_DIR : os.tmpdir();
  const tmp = path.join(dir, `capsule-secrets-${process.pid}.sh`);
  const body = '#!/usr/bin/env bash\n# generated by `capsule secrets push` — sourced via settings.json env.BASH_ENV\n'
    + names.map((n) => `export ${n}='${String(process.env[n]).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  let err = null;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    const up = spawnSync(devboxBin(), ['upload', devboxName, '--mkdir', tmp, 'capsule/load-secrets.sh'], { stdio: 'inherit' });
    if (up.status !== 0) throw new Error(`devbox upload failed (exit ${up.status})`);
    // remote path is relative to the workspace dir; glob so this works on any box
    const mv = spawnSync(devboxBin(), ['exec', devboxName, '--', 'bash', '-c',
      '(mkdir -p ~/.claude && mv /workspaces/*/capsule/load-secrets.sh ~/.claude/load-secrets.sh && chmod 600 ~/.claude/load-secrets.sh'
      + ' && bash -n ~/.claude/load-secrets.sh && echo LOAD_SECRETS_OK)'
      // never leave a secrets file inside the workspace checkout if any step fails
      + ' || { rm -f /workspaces/*/capsule/load-secrets.sh; exit 1; }'], { stdio: 'inherit' });
    if (mv.status !== 0) throw new Error(`devbox exec install failed (exit ${mv.status})`);
  } catch (e) { err = e; } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  if (err) { console.error(err.message); process.exit(1); }
  console.log(`pushed ${names.length} names to ${devboxName}:~/.claude/load-secrets.sh (mode 600)`);
  names.forEach((n) => console.log(`  ${n}`)); // names only
}
// ---------- release: pack, then publish the tarball as a (private) GitHub release asset ----------
function release(outDir, dryRun) {
  pack(outDir);
  const tag = `capsule-${ts().slice(0, 13)}`;
  const ghArgs = ['release', 'create', tag, fwd(path.join(outDir, 'capsule.tgz')), fwd(process.argv[1]),
    '--repo', RELEASE_REPO, '--title', `capsule ${tag}`,
    '--notes', `Claude Code harness capsule packed ${new Date().toISOString()}. Install: bootstrap/install.sh`];
  if (dryRun) { console.log('[dry-run] gh ' + ghArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')); return; }
  const r = spawnSync('gh', ghArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status ?? 1);
}
// ---------- CLI ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--stage') out.stage = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apt') out.apt = true;
    else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'pack') {
  pack(path.resolve(args.out || 'dist'));
} else if (cmd === 'apply') {
  if (!args._[1]) { console.error('usage: capsule.mjs apply CAPSULE.tgz [--home DIR] [--dry-run]'); process.exit(1); }
  apply(path.resolve(args._[1]), args.home ? path.resolve(args.home) : HOME, !!args.dryRun);
} else if (cmd === 'doctor') {
  const rows = runDoctor(args.home ? path.resolve(args.home) : HOME);
  printDoctor(rows);
  process.exit(rows.every(doctorPass) ? 0 : 1);
} else if (cmd === 'provision') {
  provision(args.home ? path.resolve(args.home) : HOME, { dryRun: !!args.dryRun, apt: !!args.apt });
} else if (cmd === 'secrets') {
  const sub = args._[1] || 'list', root = capsuleScanRoot(args.stage);
  if (sub === 'list') secretsList(root);
  else if (sub === 'push') {
    if (!args._[2]) { console.error('usage: capsule.mjs secrets push DEVBOX [NAME...]'); process.exit(1); }
    secretsPush(args._[2], args._.slice(3), root);
  } else { console.error('usage: capsule.mjs secrets <list|push DEVBOX [NAME...]> [--stage DIR]'); process.exit(1); }
} else if (cmd === 'release') {
  release(path.resolve(args.out || 'dist'), !!args.dryRun);
} else {
  console.error('usage: capsule.mjs <pack [--out DIR]|apply CAPSULE.tgz [--home DIR] [--dry-run]|doctor [--home DIR]\n'
    + '                    |provision [--home DIR] [--apt] [--dry-run]|secrets <list|push DEVBOX [NAME...]> [--stage DIR]\n'
    + '                    |release [--out DIR] [--dry-run]>');
  process.exit(1);
}
