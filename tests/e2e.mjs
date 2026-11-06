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
  // 用真实目录别名覆盖 Windows 短路径与真实路径混用的同类场景。
  const alias = temp + '-alias';
  await fs.symlink(temp, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const aliasRules = await rulesFor(alias, alias);
    assert.equal(aliasRules.length, 1, '工作区路径别名必须正确加载根规则');
    const aliasSubRules = await rulesFor(alias, path.join(alias, 'frontend', 'src', 'new.ts'));
    assert.equal(aliasSubRules.length, 2, '未创建文件的祖先也应映射到真实工作区');
    assert.equal((await rulesFor(alias, 'frontend/src/new.ts')).length, 2);
    const outside = temp + '-outside';
    await fs.mkdir(outside);
    const external = path.join(temp, 'external');
    try {
      await fs.writeFile(path.join(outside, 'AGENTS.md'), 'OUTSIDE_RULE');
      await fs.symlink(outside, external, process.platform === 'win32' ? 'junction' : 'dir');
      assert.deepEqual(await rulesFor(alias, path.join(alias, 'external')), []);
      assert.deepEqual(await rulesFor(alias, path.join(alias, 'external', 'new', 'file.ts')), []);
    } finally {
      await fs.rm(external, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fs.unlink(alias);
  }
  const subRules = await rulesFor(
    temp,
    path.join(temp, 'frontend', 'src', 'a.ts'),
  );
  assert.equal(subRules.length, 2);
  assert.ok(subRules[1].text.includes('FRONTEND_RULE'));
  assert.equal((await rulesFor(temp, path.dirname(temp))).length, 0);
  if (process.platform === 'win32') {
    // 不存在的盘符必须返回空规则，不能在盘符根目录无限查找祖先。
    for (const drive of ['Z', 'Y', 'X', 'W']) {
      try {
        await fs.stat(drive + ':\\');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        assert.deepEqual(await rulesFor(temp, drive + ':\\missing\\file.ts'), []);
        break;
      }
    }
  }
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
