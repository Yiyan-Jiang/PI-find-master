import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 以独立进程和真实磁盘验证任务保存、恢复及并发冲突，而非模拟持久化。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-find-tasks-'));
const entry = pathToFileURL(
  path.resolve(import.meta.dirname, '../src/tasks.mjs'),
).href;
function call(operation, input) {
  const source = `import * as t from ${JSON.stringify(entry)};const value=await t[${JSON.stringify(operation)}](${JSON.stringify(root)},${JSON.stringify(input)});console.log(JSON.stringify(value));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
  });
}
function success(operation, input) {
  const result = call(operation, input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  assert.deepEqual(success('listTasks', {}), []);
  await assert.rejects(fs.access(path.join(root, '.local')), {
    code: 'ENOENT',
  });
  const task = success('createTask', {
    id: 'frontend',
    title: '核对项目资源',
    requirements: [
      { id: 'url', description: '资源声明符合项目约定', profiles: [] },
    ],
  });
  assert.equal(task.revision, 1);
  const changed = success('updateTask', {
    id: 'frontend',
    expectedRevision: 1,
    decision: '复用项目已有检查入口',
  });
  assert.equal(changed.revision, 2);
  assert.notEqual(
    call('updateTask', {
      id: 'frontend',
      expectedRevision: 1,
      note: '过期写入',
    }).status,
    0,
  );
  const restored = success('readTask', { id: 'frontend' });
  assert.deepEqual(
    restored.decisions.map((item) => item.text),
    ['复用项目已有检查入口'],
  );
  assert.equal(
    success('taskStatus', { id: 'frontend' }).evidenceStatus,
    'unconfigured',
  );
  assert.notEqual(
    call('updateTask', { id: 'frontend', passed: true }).status,
    0,
  );
  assert.notEqual(
    call('createTask', { id: '../escape', title: '越界', requirements: [] })
      .status,
    0,
  );
  const lock = path.join(root, '.local/pi-find/tasks/task-frontend.json.lock');
  await fs.writeFile(lock, 'another active writer');
  assert.notEqual(
    call('updateTask', { id: 'frontend', note: '不能覆盖并发更新' }).status,
    0,
  );
  await fs.unlink(lock);
  const handoff = success('recordHandoff', {
    id: 'frontend',
    requirementIds: ['url'],
    brief: '只核对前端入口',
    files: [],
  });
  assert.equal(handoff.handoffs.length, 1);
  assert.equal(handoff.handoffs[0].reviewState, 'unverified');
  assert.notEqual(
    call('recordHandoff', {
      id: 'frontend',
      requirementIds: ['missing'],
      brief: '未知需求',
    }).status,
    0,
  );
  success('createTask', {
    id: 'backend',
    title: '另一个任务',
    requirements: [],
  });
  assert.equal(success('listTasks', {}).length, 2);
  assert.equal(success('readTask', { id: 'frontend' }).handoffs.length, 1);
  const beforeWriters = success('readTask', { id: 'frontend' });
  const outcomes = await Promise.all(
    Array.from(
      { length: 6 },
      (_, index) =>
        new Promise((resolve, reject) => {
          const source = `import {updateTask} from ${JSON.stringify(entry)};await updateTask(${JSON.stringify(root)}, {id:'frontend',note:'parallel-${index}'});`;
          const child = spawn(process.execPath, [
            '--input-type=module',
            '-e',
            source,
          ]);
          let error = '';
          child.stderr.on('data', (bytes) => {
            error += bytes;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, error }));
        }),
    ),
  );
  const successful = outcomes.filter((result) => result.code === 0).length;
  assert.ok(successful > 0);
  for (const result of outcomes)
    if (result.code !== 0) assert.match(result.error, /任务正在更新或有遗留锁/);
  const afterWriters = success('readTask', { id: 'frontend' });
  assert.equal(afterWriters.revision, beforeWriters.revision + successful);
  assert.equal(
    afterWriters.notes.length,
    beforeWriters.notes.length + successful,
  );
  const foreign = path.join(root, '.local/pi-find/tasks/task-foreign.json');
  await fs.writeFile(
    foreign,
    JSON.stringify({
      ...afterWriters,
      id: 'foreign',
      root: path.dirname(root),
    }),
  );
  assert.notEqual(call('listTasks', {}).status, 0);
  await fs.unlink(foreign);
  assert.notEqual(
    call('recordHandoff', {
      id: 'frontend',
      requirementIds: ['url'],
      brief: '越界路径',
      files: ['../secret'],
    }).status,
    0,
  );
  console.log(
    'PASS: cross-process task persistence, revisions, writer lock, scope, unverified delegation and task isolation',
  );
} finally {
  const absolute = path.resolve(root);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('pi-find-tasks-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
