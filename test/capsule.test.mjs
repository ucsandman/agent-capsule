import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtureHome } from './fixture.mjs';
import { rewriteText, isExcludedName, makeRules, loadConfig, parseTarget, doctorHtml } from '../capsule.mjs';

const CAPSULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'capsule.mjs');
const TOKEN = '__CAPSULE_HOME__';
// the committed capsule.config.json is the author's; every subprocess here gets a generic one instead
const NEUTRAL = { externalRoot: null, localPyPackages: {}, extraExclusions: [], release: { repo: null }, secrets: { defaultPrefixes: [] } };
const run = (args, env = {}) =>
  spawnSync(process.execPath, [CAPSULE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const filesOf = (out) => JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).files;

let TMP, FIX, NEUTRAL_CFG, OUT, MANIFEST, PACK_STDOUT;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-test-'));
  FIX = makeFixtureHome(path.join(TMP, 'home'));
  NEUTRAL_CFG = path.join(TMP, 'neutral.json');
  fs.writeFileSync(NEUTRAL_CFG, JSON.stringify(NEUTRAL));
  OUT = path.join(TMP, 'out');
  const r = run(['pack', '--home', FIX, '--out', OUT, '--config', NEUTRAL_CFG]);
  assert.equal(r.status, 0, `pack failed (${r.status}): ${r.stderr}`);
  PACK_STDOUT = r.stdout;
  MANIFEST = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------- (a) rewriteText ----------
test('rewriteText: every windows path form of the home collapses to the token', () => {
  const proj = makeRules('C:\\Users\\alice', { ...NEUTRAL, externalRoot: 'C:/Projects' });
  const none = makeRules('C:\\Users\\alice', NEUTRAL);
  assert.deepEqual(rewriteText('C:/Users/alice/.claude/hooks/x.cjs', {}, proj),
    [`${TOKEN}/.claude/hooks/x.cjs`, 1]);
  const [back, backN] = rewriteText('C:\\Users\\alice\\.claude\\hooks\\x.cjs', {}, proj);
  assert.ok(back.startsWith(`${TOKEN}/.claude`), back);
  assert.equal(backN, 1);
  assert.deepEqual(rewriteText('C:\\\\Users\\\\alice\\\\.claude', {}, proj), [`${TOKEN}/.claude`, 1]);
  assert.deepEqual(rewriteText('/c/Users/alice/.claude/hooks', {}, proj), [`${TOKEN}/.claude/hooks`, 1]);
  // a bare home dir, i.e. not the .claude subtree
  assert.deepEqual(rewriteText('C:/Users/alice/.dashclaw/x', {}, proj), [`${TOKEN}/.dashclaw/x`, 1]);
  // externalRoot on -> rewritten into ext/; externalRoot null -> left completely alone
  assert.deepEqual(rewriteText('C:/Projects/Foo/hooks/x.py', {}, proj),
    [`${TOKEN}/.claude/ext/Foo/hooks/x.py`, 1]);
  assert.deepEqual(rewriteText('C:/Projects/Foo/hooks/x.py', {}, none), ['C:/Projects/Foo/hooks/x.py', 0]);
});

test('rewriteText: posix home', () => {
  const r = makeRules('/home/alice', NEUTRAL);
  assert.deepEqual(rewriteText('/home/alice/.claude/hooks/x', {}, r), [`${TOKEN}/.claude/hooks/x`, 1]);
  assert.deepEqual(rewriteText('/home/alice/.dashclaw', {}, r), [`${TOKEN}/.dashclaw`, 1]);
  assert.deepEqual(rewriteText('/home/bob/.claude', {}, r), ['/home/bob/.claude', 0]);
});

test('rewriteText: interpreters are normalised only when asked', () => {
  const r = makeRules('/home/alice', NEUTRAL);
  assert.deepEqual(rewriteText('py -3.12 x.py', { interpreters: true }, r), ['python3 x.py', 1]);
  assert.deepEqual(rewriteText('python x.py', { interpreters: true }, r), ['python3 x.py', 1]);
  assert.deepEqual(rewriteText('python3 x.py', { interpreters: true }, r), ['python3 x.py', 0]);
  assert.deepEqual(rewriteText('python x.py', {}, r), ['python x.py', 0]);
});

// ---------- (b) isExcludedName ----------
test('isExcludedName: secret-ish and junk names are dropped, code is kept', () => {
  for (const n of ['.env', '.env.local', 'keys', 'k.pem', 'id.key', 'backups-2024', 'my-token.txt', 'foo.bak']) {
    assert.equal(isExcludedName(n, []), true, `${n} should be excluded`);
  }
  for (const n of ['token-guard.cjs', 'settings.json', 'hooks']) {
    assert.equal(isExcludedName(n, []), false, `${n} should be kept`);
  }
});

test('isExcludedName: extraExclusions are honoured, case-insensitively', () => {
  assert.equal(isExcludedName('fleet', []), false);
  assert.equal(isExcludedName('fleet', ['fleet']), true);
  assert.equal(isExcludedName('Fleet', ['fleet']), true);
  assert.equal(isExcludedName('fleet', ['FLEET']), true);
});

// ---------- (c) secret scan ----------
test('pack: a planted secret fails the scan and destroys the stage', () => {
  const out = path.join(TMP, 'out-plant');
  const r = run(['pack', '--home', FIX, '--out', out, '--config', NEUTRAL_CFG], { CAPSULE_TEST_PLANT: '1' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /SECRET SCAN FAILED/);
  assert.equal(fs.existsSync(path.join(out, 'stage')), false, 'stage must be deleted on a scan hit');
  assert.equal(fs.existsSync(path.join(out, 'capsule.tgz')), false, 'nothing may be tarred on a scan hit');
});

test('pack: a clean run writes the tarball and the manifest', () => {
  assert.ok(fs.existsSync(path.join(OUT, 'capsule.tgz')));
  assert.ok(fs.existsSync(path.join(OUT, 'manifest.json')));
});

// ---------- (d) manifest shape ----------
test('manifest: files list is sorted and holds exactly what the whitelist allows', () => {
  assert.equal(MANIFEST.version, 1);
  assert.ok(Array.isArray(MANIFEST.files));
  assert.deepEqual(MANIFEST.files, [...MANIFEST.files].sort(), 'files must be sorted');
  for (const f of ['settings.json', 'hooks/hello.cjs', 'CLAUDE.md', 'projects/p1/memory/MEMORY.md', 'agents-memory/note.md']) {
    assert.ok(MANIFEST.files.includes(f), `missing ${f}`);
  }
  for (const f of ['projects/p1/other.txt', '.env', 'keys/k.pem', 'hooks/backups-old/x.cjs']) {
    assert.equal(MANIFEST.files.includes(f), false, `${f} must never be packed`);
  }
  assert.equal(MANIFEST.files.some((f) => f.startsWith('node_modules/')), false);
  // positive control for the extraExclusions test below: with a neutral config this one IS packed
  assert.ok(MANIFEST.files.includes('hooks/secretdir/x.cjs'));
});

test('manifest: hooks, dropped, binaries and provision', () => {
  assert.ok(MANIFEST.hooks.length > 0);
  for (const h of MANIFEST.hooks) {
    assert.ok(h.event && h.original && h.rewritten, JSON.stringify(h));
    assert.ok(h.rewritten.includes(TOKEN), `not rewritten: ${h.rewritten}`);
  }
  assert.equal(MANIFEST.dropped.length, 1);
  assert.match(MANIFEST.dropped[0].command, /Media\.SoundPlayer/);
  assert.ok(MANIFEST.binaries.includes('node'));
  assert.ok(MANIFEST.binaries.includes('python3'), `py hook not normalised: ${MANIFEST.binaries}`);
  assert.deepEqual(Object.keys(MANIFEST.provision).sort(), ['apt', 'cargo', 'github', 'manual', 'pip', 'pip_local']);
});

test('manifest: rewrite counts, and no trace of the source home in the stage', () => {
  assert.ok(MANIFEST.rewritten['settings.json'] > 0);
  assert.ok(MANIFEST.rewritten['CLAUDE.md'] > 0);
  const md = fs.readFileSync(path.join(OUT, 'stage', 'CLAUDE.md'), 'utf8');
  assert.equal(md.includes(FIX.replace(/\\/g, '/')), false, md);
  assert.equal(md.includes(FIX.replace(/\//g, '\\')), false, md);
  assert.ok(md.includes(TOKEN));
  // env values are rewritten against the *packed* home, not the machine's own
  // the rewrite keeps whatever separator followed the home, so compare on a normalised form
  const staged = JSON.parse(fs.readFileSync(path.join(OUT, 'stage', 'settings.json'), 'utf8'));
  const slash = (s) => s.replace(/\\/g, '/');
  assert.equal(slash(staged.env.BASH_ENV), `${TOKEN}/.claude/load-secrets.sh`);
  assert.equal(slash(staged.statusLine.command), `node "${TOKEN}/.claude/scripts/status.mjs"`);
  assert.ok(PACK_STDOUT.includes('capsule pack summary'), PACK_STDOUT);
});

// ---------- (e) apply round-trip ----------
test('apply: rewrites to the target home and keeps its runtime state', () => {
  const target = path.join(TMP, 'target');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'load-secrets.sh'), 'export FIXTURE=1\n');
  fs.writeFileSync(path.join(target, '.claude', '.credentials.json'), '{"kept":true}\n');
  const r = run(['apply', path.join(OUT, 'capsule.tgz'), '--home', target]);
  assert.equal(r.status, 0, r.stderr);
  const settings = fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8');
  assert.ok(settings.includes(target.replace(/\\/g, '/')), settings);
  assert.equal(settings.includes(TOKEN), false, 'token must be resolved on apply');
  assert.ok(fs.existsSync(path.join(target, '.claude', '.capsule-manifest.json')));
  // agents-memory is relocated out of .claude
  assert.ok(fs.existsSync(path.join(target, '.agents', 'memory', 'note.md')));
  assert.equal(fs.existsSync(path.join(target, '.claude', 'agents-memory')), false);
  assert.ok(fs.existsSync(path.join(target, '.claude', 'load-secrets.sh')));
  assert.ok(fs.existsSync(path.join(target, '.claude', '.credentials.json')));
});

test('apply --dry-run touches nothing in the target', () => {
  const target = path.join(TMP, 'target-dry');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'marker.txt'), 'keep me\n');
  const r = run(['apply', path.join(OUT, 'capsule.tgz'), '--home', target, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(target), ['.claude']);
  assert.deepEqual(fs.readdirSync(path.join(target, '.claude')), ['marker.txt']);
});

// ---------- (f) config ----------
test('config: extraExclusions drops a directory the code knows nothing about', () => {
  const cfg = path.join(TMP, 'excl.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...NEUTRAL, extraExclusions: ['secretdir'] }));
  const out = path.join(TMP, 'out-excl');
  const r = run(['pack', '--home', FIX, '--out', out, '--config', cfg]);
  assert.equal(r.status, 0, r.stderr);
  const files = filesOf(out);
  assert.equal(files.includes('hooks/secretdir/x.cjs'), false);
  assert.ok(files.includes('hooks/hello.cjs'), 'the rest of hooks/ must survive');
});

test('config: an absent file falls back to generic defaults', () => {
  const out = path.join(TMP, 'out-nocfg');
  const r = run(['pack', '--home', FIX, '--out', out], { CAPSULE_CONFIG: path.join(TMP, 'absent.json') });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(filesOf(out).includes('hooks/secretdir/x.cjs'), 'no config means no extra exclusions');
  assert.deepEqual(loadConfig(path.join(TMP, 'absent.json')), NEUTRAL);
});

test('config: a bad config is a one-line fatal error', () => {
  const cfg = path.join(TMP, 'bad.json');
  fs.writeFileSync(cfg, '{ not json');
  const r = run(['pack', '--home', FIX, '--out', path.join(TMP, 'out-bad'), '--config', cfg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^bad config /);
});

test('secrets push: no configured prefixes refuses to guess a scope', () => {
  const r = run(['secrets', 'push', 'somebox', '--config', NEUTRAL_CFG, '--stage', path.join(OUT, 'stage')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no secrets\.defaultPrefixes configured/);
  assert.equal(r.stdout, '', 'must bail before contacting a devbox');
});

test('release: no configured repo exits 1 before packing anything', () => {
  const r = run(['release', '--dry-run', '--config', NEUTRAL_CFG], { CAPSULE_REPO: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no release repo: set CAPSULE_REPO or release\.repo in capsule\.config\.json/);
  assert.equal(r.stdout.includes('capsule pack summary'), false, 'must not pack before the repo check');
});

// ---------- (g) targets and deploy ----------
test('parseTarget: a bare name is a devbox, ssh:HOST is plain ssh, ssh: alone is fatal', () => {
  assert.deepEqual(parseTarget('my-box'), { kind: 'devbox', name: 'my-box' });
  assert.deepEqual(parseTarget('ssh:alice@host'), { kind: 'ssh', name: 'alice@host' });
  // exits the process, so it is exercised through the CLI rather than in-process
  const r = run(['deploy', 'ssh:', '--dry-run', '--config', NEUTRAL_CFG]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ssh: needs a host/);
});

test('deploy --dry-run (devbox): uploads all three artefacts and runs install.sh', () => {
  const r = run(['deploy', 'my-box', '--out', OUT, '--dry-run', '--config', NEUTRAL_CFG], { CAPSULE_REPO: 'x/y' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /upload my-box --mkdir .+ capsule\/capsule\.tgz/);
  assert.match(r.stdout, /mv \/workspaces\/\*\/capsule\/capsule\.tgz ~\/capsule\/capsule\.tgz/);
  assert.match(r.stdout, /upload my-box --mkdir .+ capsule\/capsule\.mjs/);
  assert.match(r.stdout, /upload my-box --mkdir .+ capsule\/install\.sh/);
  assert.match(r.stdout, /mv \/workspaces\/\*\/capsule\/install\.sh ~\/capsule\/bootstrap\/install\.sh/);
  assert.match(r.stdout, /CAPSULE_REPO='x\/y' bash ~\/capsule\/bootstrap\/install\.sh/);
  assert.equal(r.stdout.includes('CAPSULE_FORCE=1'), false, 'no --force means no CAPSULE_FORCE');
});

test('deploy --dry-run (ssh): scp source is drive-letter free and the destination is HOME-relative', () => {
  const r = run(['deploy', 'ssh:alice@host', '--out', OUT, '--dry-run', '--force', '--config', NEUTRAL_CFG],
    { CAPSULE_REPO: 'x/y' });
  assert.equal(r.status, 0, r.stderr);
  const scp = r.stdout.split('\n').map((l) => l.trim())
    .find((l) => l.startsWith('[dry-run] scp ') && l.includes('capsule.tgz'));
  assert.ok(scp, r.stdout);
  const [, , src, dest] = scp.split(/\s+/);
  assert.equal(src, './capsule.tgz');
  assert.equal(/^[A-Za-z]:/.test(src), false, `scp source must carry no drive prefix: ${src}`);
  assert.equal(dest, 'alice@host:capsule/capsule.tgz');
  assert.match(r.stdout, /ssh alice@host bash -c 'mkdir -p ~\/capsule'/);
  assert.ok(r.stdout.includes('alice@host:capsule/capsule.mjs'), r.stdout);
  assert.ok(r.stdout.includes('alice@host:capsule/bootstrap/install.sh'), r.stdout);
  assert.ok(r.stdout.includes('CAPSULE_FORCE=1'), r.stdout);
  assert.ok(r.stdout.includes('x/y') && r.stdout.includes('CAPSULE_REPO='), r.stdout);
  assert.match(r.stdout, /bash ~\/capsule\/bootstrap\/install\.sh/);
});

test('deploy: a missing capsule.tgz is a one-line fatal error', () => {
  const r = run(['deploy', 'my-box', '--out', path.join(TMP, 'no-such-out'), '--dry-run', '--config', NEUTRAL_CFG]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /capsule\.tgz — run capsule pack first/);
});

// ---------- (h) doctor --html ----------
test('doctorHtml: escapes every value and reports the pass ratio', () => {
  const rows = [
    { event: 'SessionStart', command: 'node ok.cjs', code: 0, stderrLine: '' },
    { event: 'PreToolUse', command: 'echo "<script>alert(1)</script>"', code: 1, stderrLine: 'boom' },
  ];
  const html = doctorHtml(rows, { home: '/home/alice', at: '2026-01-01T00:00:00.000Z' });
  assert.ok(html.includes('capsule doctor'), html.slice(0, 200));
  assert.ok(html.includes('1/2 hooks pass'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.equal(html.includes('<script>'), false, 'no raw script tag may survive escaping');
  assert.ok(html.includes('SessionStart') && html.includes('PreToolUse'), html);
});

test('doctor --html writes a self-contained report for an applied target', () => {
  const target = path.join(TMP, 'target'); // created by the apply test above
  assert.ok(fs.existsSync(path.join(target, '.claude', 'settings.json')), 'the apply test must have run first');
  const file = path.join(TMP, 'doctor-report.html');
  // exit code is 0 or 1 depending on whether python3 exists on this runner, so it is not asserted
  run(['doctor', '--home', target, '--html', file, '--config', NEUTRAL_CFG]);
  assert.ok(fs.existsSync(file), 'doctor --html must write the file');
  const html = fs.readFileSync(file, 'utf8');
  assert.ok(html.includes('capsule doctor'), html.slice(0, 200));
  assert.ok(html.includes('hooks pass'), html.slice(0, 2000));
  assert.ok(html.includes('hello.cjs'), html.slice(0, 4000));
});

test('secrets push --dry-run: no value reaches stdout and no temp file survives', () => {
  const cfg = path.join(TMP, 'capt.json'), scratch = path.join(TMP, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ ...NEUTRAL, secrets: { defaultPrefixes: ['CAPT_'] } }));
  // a stage whose settings.json names the secret, so detectSecretNames finds it without a real hook tree
  const stage = path.join(TMP, 'capt-stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'settings.json'), JSON.stringify({ env: { CAPT_X: '' } }));
  const value = 'capsule-test-secret-value-do-not-log';
  const r = run(['secrets', 'push', 'ssh:alice@host', '--dry-run', '--config', cfg, '--stage', stage],
    { CAPT_X: value, CAPSULE_SCRATCH: scratch });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(value), false, 'a secret value must never reach stdout');
  assert.equal(r.stderr.includes(value), false, 'a secret value must never reach stderr');
  assert.ok(r.stdout.includes('CAPT_X'), r.stdout); // the name does go out
  // the 0600 staging file is created before any bytes land, and the destination is replaced by a mv
  assert.match(r.stdout, /umask 077; : > ~\/capsule\/capsule-secrets-\d+\.sh/);
  assert.match(r.stdout, /mv ~\/capsule\/capsule-secrets-\d+\.sh ~\/\.claude\/load-secrets\.sh && chmod 600/);
  assert.match(r.stdout, /bash -n ~\/\.claude\/load-secrets\.sh && echo LOAD_SECRETS_OK/);
  assert.deepEqual(fs.readdirSync(scratch), [], 'a dry run must leave no temp file behind');
});

test('doctorHtml: exit 2 is a pass, labelled as a guard block', () => {
  const html = doctorHtml([{ event: 'PreToolUse', command: 'guard.cjs', code: 2, stderrLine: 'blocked' }], {});
  assert.ok(html.includes('1/1 hooks pass'), html);
  assert.ok(html.includes('2 (guard block)'), html);
  assert.ok(html.includes('class="badge ok"'), html);
});
