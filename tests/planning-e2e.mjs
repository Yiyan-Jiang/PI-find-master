import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plan-'));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const call = (...args) => {
  const r = spawnSync(
    process.execPath,
    [cli, ...args, '--root', root, '--json'],
    { encoding: 'utf8' },
  );
  return { code: r.status, data: JSON.parse(r.stdout) };
};
let checks = 0;
const check = (ok, label) => {
  assert.ok(ok, label);
  console.log(`ok ${++checks}: ${label}`);
};
try {
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Planning E2E');
  const profile = (description) => ({
    kind: 'command',
    description,
    steps: [
      {
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync("EXECUTED","wrong")'],
      },
    ],
  });
  const cfg = {
    acceptance: {
      profiles: {
        baseline: profile('默认检查'),
        app: profile('源码检查'),
        tests: profile('测试检查'),
      },
      defaultProfiles: ['baseline'],
      impact: [
        { paths: ['src/**'], profiles: ['app'] },
        { paths: ['tests/**'], profiles: ['tests'] },
      ],
    },
  };
  const save = () =>
    fs.writeFile(path.join(root, '.pi-find.json'), JSON.stringify(cfg));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'src/a.txt'), 'source');
  await fs.writeFile(path.join(root, 'tests/a.txt'), 'test');
  await save();
  git('add', '.');
  git('commit', '-qm', 'fixture');
  let r = call('plan');
  check(
    r.code === 0 &&
      r.data.configured &&
      r.data.ok &&
      r.data.changedPaths.length === 0 &&
      r.data.profiles.map((p) => p.id).join(',') === 'baseline',
    'clean CLI plan selects only defaults',
  );
  check(
    r.data.baseCommit === git('rev-parse', 'HEAD') &&
      r.data.note.includes('未执行'),
    'plan identifies verified base and execution boundary',
  );
  await fs.writeFile(path.join(root, 'src/a.txt'), 'modified');
  await fs.unlink(path.join(root, 'tests/a.txt'));
  await fs.writeFile(path.join(root, 'src/new.txt'), 'new');
  r = call('plan', '--base', 'HEAD');
  check(
    r.code === 0 &&
      r.data.changedPaths.join(',') === 'src/a.txt,src/new.txt,tests/a.txt' &&
      r.data.profiles
        .map((p) => p.id)
        .sort()
        .join(',') === 'app,baseline,tests',
    'tracked edits/deletions and untracked inputs select impact profiles',
  );
  await fs.writeFile(path.join(root, 'unknown.txt'), 'unknown');
  r = call('plan');
  check(
    r.data.profiles.length === 3,
    'unknown impact conservatively selects all profiles',
  );
  cfg.acceptance.impact.push({ paths: ['unknown.txt'], profiles: ['missing'] });
  await save();
  r = call('plan');
  check(
    r.code !== 0 &&
      r.data.profiles.some((p) => p.id === 'missing' && !p.configured) &&
      !r.data.ok,
    'missing profile references remain visible and block plan',
  );
  for (const base of [
    'no-such-ref',
    "HEAD;node -e \"require('fs').writeFileSync('INJECTED','bad')\"",
    '--output=INJECTED',
  ]) {
    r = call('plan', '--base', base);
    check(
      r.code !== 0 && !r.data.ok,
      'invalid or hostile base rejected: ' + base.split(';')[0],
    );
  }
  check(call('plan', '--base').code !== 0, 'base missing value rejected');
  check(
    call('status', '--base', 'HEAD').code !== 0,
    'base restricted to plan command',
  );
  const sub = spawnSync(
    process.execPath,
    [cli, 'plan', '--root', path.join(root, 'src'), '--json'],
    { encoding: 'utf8' },
  );
  check(
    sub.status !== 0 && JSON.parse(sub.stdout).reason.includes('根目录'),
    'subdirectory explicitly rejected',
  );
  for (const name of ['.local', 'EXECUTED', 'INJECTED']) {
    let absent = false;
    try {
      await fs.access(path.join(root, name));
    } catch (e) {
      if (e.code === 'ENOENT') absent = true;
      else throw e;
    }
    check(absent, 'read-only planner creates no ' + name);
  }
  console.log(`planning E2E passed: ${checks} checks`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
