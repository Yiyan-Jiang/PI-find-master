import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  discover,
  rulesFor,
  runSteps,
  sourceFingerprint,
  inspectStaged,
  validationStatus,
} from '../src/core.mjs';

// 从真实 Git 仓库和真实子进程验证外部可观察行为。
const temp = await fs.mkdtemp(
  path.join(process.env.TEMP || os.tmpdir(), 'pi-find-e2e-'),
);
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
try {
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Probe');
  await fs.writeFile(path.join(temp, '.gitignore'), '.local/\nnode_modules/\n');
  await fs.writeFile(path.join(temp, 'AGENTS.md'), 'ROOT_RULE');
  await fs.mkdir(path.join(temp, 'frontend'));
  await fs.writeFile(path.join(temp, 'frontend', 'AGENTS.md'), 'FRONTEND_RULE');
  await fs.writeFile(
    path.join(temp, 'frontend', 'package.json'),
    JSON.stringify({
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' },
    }),
  );
  await fs.writeFile(path.join(temp, 'pyproject.toml'), '[tool.ruff]\n');
  await fs.writeFile(path.join(temp, 'code.py'), 'print(1)\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const d = await discover(temp);
  assert.ok(d.tools.some((t) => t.id === 'frontend:npm:lint'));
  assert.ok(d.configFiles.includes('pyproject.toml'));
  await fs.mkdir(path.join(temp, 'broken'));
  await fs.writeFile(path.join(temp, 'broken/package.json'), '{bad json');
  assert.equal((await discover(temp)).diagnostics.length, 1);
  await fs.rm(path.join(temp, 'broken'), { recursive: true });
  const rootRules = await rulesFor(temp, temp);
  assert.equal(rootRules.length, 1);
  const subRules = await rulesFor(
    temp,
    path.join(temp, 'frontend', 'src', 'a.ts'),
  );
  assert.equal(subRules.length, 2);
  assert.ok(subRules[1].text.includes('FRONTEND_RULE'));
  assert.equal((await rulesFor(temp, path.dirname(temp))).length, 0);
  const before = await sourceFingerprint(temp);
  const marker = path.join(temp, 'must-not-exist');
  const failure = await runSteps(
    temp,
    [
      { command: process.execPath, args: ['-e', 'process.exit(7)'] },
      {
        command: process.execPath,
        args: [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ],
      },
    ],
    { timeoutMs: 10000 },
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.steps.length, 1);
  assert.equal(failure.steps[0].exitCode, 7);
  await assert.rejects(fs.access(marker));
  const timeout = await runSteps(
    temp,
    [{ command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }],
    { timeoutMs: 150 },
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.steps[0].timedOut, true);
  const success = await runSteps(
    temp,
    [{ command: process.execPath, args: ['-e', 'console.log("PASS")'] }],
    { timeoutMs: 10000, recordAs: 'quality' },
  );
  assert.ok(success.ok);
  assert.ok((await validationStatus(temp, 'quality')).valid);
  await fs.writeFile(path.join(temp, 'code.py'), 'print(2)\n');
  assert.notEqual(before, await sourceFingerprint(temp));
  assert.equal((await validationStatus(temp, 'quality')).valid, false);
  await fs.mkdir(path.join(temp, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(temp, 'docs', 'plans', 'draft.md'), 'draft');
  git('add', 'docs/plans/draft.md');
  const denied = await inspectStaged(temp, ['docs/plans/**']);
  assert.ok(denied.denied.includes('docs/plans/draft.md'));
  git('reset', '-q', 'HEAD', 'docs/plans/draft.md');
  git('add', 'code.py');
  await fs.writeFile(path.join(temp, 'code.py'), 'print(3)\n');
  assert.ok(
    (await inspectStaged(temp, [])).partiallyStaged.includes('code.py'),
  );
  // 真正的 Git gitlink 目录不能被当作普通文件读取。
  const head = git('rev-parse', 'HEAD').trim();
  await fs.mkdir(path.join(temp, 'sub'));
  git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  assert.equal(typeof (await sourceFingerprint(temp)), 'string');
  console.log(
    'PASS: discovery, scoped rules, real exit code, fail-fast, timeout, stale validation, staged deny and partial staging',
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
