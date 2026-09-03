// A fake home to pack: built with the real path separators of the current OS, so one fixture
// serves both the ubuntu and the windows CI runner.
import fs from 'node:fs';
import path from 'node:path';
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
export function makeFixtureHome(dir) {
  const claude = path.join(dir, '.claude');
  const hello = path.join(claude, 'hooks', 'hello.cjs');
  const hpy = path.join(claude, 'hooks', 'h.py');
  const status = path.join(claude, 'scripts', 'status.mjs');
  const settings = {
    env: { BASH_ENV: path.join(claude, 'load-secrets.sh') },
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [
        { type: 'command', command: `node "${hello}"` },
        { type: 'command', command: `python "${hpy}"` },
      ] }],
      Stop: [{ matcher: '*', hooks: [
        { type: 'command', command: 'powershell -c "(New-Object Media.SoundPlayer \'tada.wav\').PlaySync()"' },
      ] }],
    },
    statusLine: { type: 'command', command: `node "${status}"` },
  };
  w(path.join(claude, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  // the home path in both forward-slash and backslash form: both must be rewritten away
  const fwdDir = dir.replace(/\\/g, '/'), backDir = dir.replace(/\//g, '\\');
  w(path.join(claude, 'CLAUDE.md'),
    `# fixture harness\nfwd: ${fwdDir}/.claude/hooks\nback: ${backDir}\\.claude\\hooks\n`);
  w(hello, 'process.exit(0);\n');
  w(hpy, 'import sys\nsys.exit(0)\n');
  w(status, 'process.stdout.write("ok");\n');
  w(path.join(claude, 'hooks', 'secretdir', 'x.cjs'), '// only excluded via config.extraExclusions\n');
  w(path.join(claude, 'projects', 'p1', 'memory', 'MEMORY.md'), '# p1 memory\n');
  w(path.join(claude, 'projects', 'p1', 'other.txt'), 'not memory, must not be packed\n');
  w(path.join(dir, '.agents', 'memory', 'note.md'), '# agents memory note\n');
  // none of these may ever reach the stage
  w(path.join(claude, '.env'), 'NOPE=1\n');
  w(path.join(claude, 'keys', 'k.pem'), 'not a real key\n');
  w(path.join(claude, 'hooks', 'backups-old', 'x.cjs'), '// backup\n');
  w(path.join(claude, 'node_modules', 'm', 'i.js'), 'module.exports = 1;\n');
  return dir;
}
