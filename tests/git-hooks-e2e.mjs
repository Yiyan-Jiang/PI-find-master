import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const node = process.execPath,
  guard = path.resolve(import.meta.dirname, '../src/guard.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'find-git-gate-'));
const cmd = (program, args, options = {}) =>
  spawnSync(program, args, { cwd: root, encoding: 'utf8', ...options });
const git = (...args) => {
  const r = cmd('git', args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const check = (phase, input = '') => cmd(node, [guard, phase, root], { input });
try {
  git('init', '-q');
  git('config', 'user.name', 'Gate E2E');
  git('config', 'user.email', 'gate@example.invalid');
  await fs.writeFile(path.join(root, '.gitignore'), '.local/\n');
  await fs.writeFile(path.join(root, 'code.txt'), 'first');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  await fs.mkdir(path.join(root, '.local/pi-find'), { recursive: true });
  const config = {
    deny: ['docs/plans/**'],
    requireE2E: true,
    qualitySteps: [
      { command: node, args: ['-e', 'console.log("quality-real-check")'] },
    ],
    e2eSteps: [
      { command: node, args: ['-e', 'console.log("e2e-real-check")'] },
    ],
  };
  await fs.writeFile(
    path.join(root, '.local/pi-find/config.json'),
    JSON.stringify(config),
  );
  // 先证明没有 E2E 证据不能推送。
  assert.notEqual(
    check('pre-push', `refs/heads/main ${base} refs/heads/main ${base}\n`)
      .status,
    0,
  );
  const validate = (kind) => cmd(node, [guard, 'validate', root, kind]);
  assert.equal(validate('e2e').status, 0);
  assert.equal(
    check('pre-push', `refs/heads/main ${base} refs/heads/main ${base}\n`)
      .status,
    0,
  );
  await fs.writeFile(path.join(root, 'code.txt'), 'changed');
  git('add', 'code.txt');
  git('commit', '-qm', 'changed');
  const current = git('rev-parse', 'HEAD');
  assert.notEqual(
    check('pre-push', `refs/heads/main ${current} refs/heads/main ${base}\n`)
      .status,
    0,
  );
  assert.equal(validate('e2e').status, 0);
  assert.equal(
    check('pre-push', `refs/heads/main ${current} refs/heads/main ${base}\n`)
      .status,
    0,
  );
  await fs.mkdir(path.join(root, 'docs/plans'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/plans/no.md'), 'local draft');
  git('add', 'docs/plans/no.md');
  assert.notEqual(check('staged').status, 0);
  git('commit', '-qm', 'bypassed commit fixture');
  const bad = git('rev-parse', 'HEAD');
  assert.notEqual(
    check('pre-push', `refs/heads/main ${bad} refs/heads/main ${current}\n`)
      .status,
    0,
  );
  // 新配置沿用真实 pre-push 引用检查，并核对相关受测输入是否属于 HEAD。
  git('rm', 'docs/plans/no.md');
  git('commit', '-qm', 'remove forbidden fixture');
  const deliverable = git('rev-parse', 'HEAD');
  await fs.writeFile(
    path.join(root, '.pi-find.json'),
    JSON.stringify({
      acceptance: {
        profiles: {
          delivery: {
            kind: 'command',
            include: ['code.txt'],
            steps: [{ command: node, args: ['--version'] }],
          },
        },
        gates: { push: ['delivery'] },
      },
    }),
  );
  const cli = path.resolve(import.meta.dirname, '../src/cli.mjs');
  assert.equal(
    cmd(node, [cli, 'run', 'delivery', '--root', root, '--json']).status,
    0,
  );
  const refs = `refs/heads/main ${deliverable} refs/heads/main ${bad}\n`;
  assert.equal(check('pre-push', refs).status, 0);
  await fs.writeFile(
    path.join(root, 'code.txt'),
    'uncommitted code under test',
  );
  assert.equal(
    cmd(node, [cli, 'run', 'delivery', '--root', root, '--json']).status,
    0,
  );
  assert.notEqual(
    check('pre-push', refs).status,
    0,
    '本地检查通过不能替另一份 HEAD 授予推送通过',
  );
  console.log(
    'PASS: real process Git gates, absent/stale E2E blocks, fresh evidence allows, forbidden staged and pushed artifacts block',
  );
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('find-git-gate-'));
  await fs.rm(root, { recursive: true, force: true });
}
