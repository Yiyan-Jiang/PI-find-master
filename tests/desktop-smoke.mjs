import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const desktopIndex = process.argv.indexOf('--desktop-root');
const desktopRoot =
  desktopIndex >= 0
    ? process.argv[desktopIndex + 1]
    : process.env.PI_DESKTOP_ROOT;
if (!desktopRoot)
  throw Error(
    '请通过 --desktop-root 或 PI_DESKTOP_ROOT 指定实际安装目录；未运行桌面验证',
  );
const chunks = path.join(
  path.resolve(desktopRoot),
  'app/resources/agent-runtime/chunks',
);
const candidates = [];
for (const file of await fs.readdir(chunks))
  if (
    /^runner-.*\.js$/.test(file) &&
    (await fs.readFile(path.join(chunks, file), 'utf8')).includes(
      'TrustedExtensionRunner',
    )
  )
    candidates.push(path.join(chunks, file));
assert.equal(
  candidates.length,
  1,
  '必须唯一定位真实 Desktop TrustedExtensionRunner',
);
const runnerPath = candidates[0];
const { TrustedExtensionRunner } = await import(pathToFileURL(runnerPath));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'find-desktop-'));
let runner,
  failed = false;
try {
  await fs.writeFile(path.join(tmp, 'AGENTS.md'), 'ROOT_CONSTRAINT');
  await fs.mkdir(path.join(tmp, 'child'));
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'CHILD_CONSTRAINT');
  await fs.writeFile(path.join(tmp, 'child', 'code.txt'), 'data');
  const diagnostics = [],
    requests = [];
  let confirmationHook;
  let prompt = 'base',
    approved = false;
  const bridge = {
    sessionId: 'desktop-smoke',
    cwd: tmp,
    getModel: () => ({ id: 'probe' }),
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel() {},
    isIdle: () => true,
    abort() {},
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    compact() {},
    getSystemPrompt: () => prompt,
    getActiveTools: () => ['Read'],
    getAllTools: () => [],
    setActiveTools() {},
    getSessionName: () => '',
    setSessionName() {},
    sendUserMessage() {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    requestUi: async (_e, r) => {
      requests.push(JSON.stringify(r));
      if (confirmationHook) {
        const hook = confirmationHook;
        confirmationHook = undefined;
        await hook();
      }
      return { kind: r.kind, value: approved };
    },
    publishCommands() {},
    publishDiagnostics(d) {
      diagnostics.splice(0, diagnostics.length, ...d);
    },
  };
  runner = new TrustedExtensionRunner({
    specs: [
      {
        id: 'local.pi-find-master',
        label: 'Environment finder',
        entry: path.join(root, 'src/extension.mjs'),
        root,
        source: 'user',
      },
    ],
    bridge,
  });
  const reports = await runner.load();
  assert.equal(reports[0].state, 'loaded');
  const registered = runner.getAgentTools().map((t) => t.name);
  for (const name of [
    'acceptance_plan',
    'acceptance_status',
    'run_acceptance',
    'task_record',
    'task_status',
  ])
    assert.ok(
      registered.includes(name),
      'missing acceptance integration: ' + name,
    );
  prompt = await runner.emitBeforeAgentStart('task', 'base');
  assert.ok(prompt.includes('ROOT_CONSTRAINT'));
  assert.ok(!prompt.includes('CHILD_CONSTRAINT'));
  const call = {
    type: 'tool_call',
    toolName: 'Read',
    input: { path: 'child/code.txt' },
  };
  const blocked = await runner.emit('tool_call', call);
  assert.ok(blocked.block);
  assert.ok(blocked.reason.includes('CHILD_CONSTRAINT'));
  assert.equal(await runner.emit('tool_call', call), undefined);
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'UPDATED_RULE');
  assert.ok(
    (await runner.emit('tool_call', call)).reason.includes('UPDATED_RULE'),
  );
  await runner.emit('session_compact', { type: 'session_compact' });
  assert.ok((await runner.emit('tool_call', call)).block);
  assert.ok(
    (
      await runner.emit('tool_call', {
        toolName: 'plugin_pi_session_orchestrator_SessionTask',
        input: { action: 'spawn', task: 'vague' },
      })
    ).block,
  );
  const tool = runner
    .getAgentTools()
    .find((t) => t.name === 'prepare_delegate');
  const prepared = await tool.execute(
    'prep',
    {
      project: 'child',
      task: 'read code',
      acceptance: 'report exact file paths',
      files: ['code.txt'],
    },
    AbortSignal.timeout(10000),
  );
  const handoff = JSON.parse(prepared.content[0].text);
  assert.ok(handoff.task.includes('UPDATED_RULE'));
  assert.equal(
    await runner.emit('tool_call', {
      toolName: 'plugin_pi_session_orchestrator_SessionTask',
      input: { action: 'spawn', task: handoff.task },
    }),
    undefined,
  );
  await fs.mkdir(path.join(tmp, '.local/pi-find'), { recursive: true });
  await fs.writeFile(
    path.join(tmp, '.local/pi-find/config.json'),
    JSON.stringify({
      tools: [
        {
          id: 'probe:run',
          category: 'other',
          steps: [
            {
              command: process.execPath,
              args: ['-e', 'console.log("REAL_EXEC_OK")'],
            },
          ],
        },
      ],
    }),
  );
  const run = runner.getAgentTools().find((t) => t.name === 'run_project_tool');
  const denied = await run.execute(
    'denied',
    { toolId: 'probe:run' },
    AbortSignal.timeout(10000),
  );
  assert.ok(denied.isError);
  approved = true;
  const executed = await run.execute(
    'allowed',
    { toolId: 'probe:run' },
    AbortSignal.timeout(10000),
  );
  assert.equal(executed.isError, false);
  assert.ok(executed.content[0].text.includes('REAL_EXEC_OK'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Desktop smoke');
  git('config', 'user.email', 'desktop@example.invalid');
  await fs.writeFile(path.join(tmp, '.gitignore'), '.local/\n');
  await fs.writeFile(
    path.join(tmp, '.pi-find.json'),
    JSON.stringify({
      acceptance: {
        profiles: {
          proof: {
            kind: 'command',
            include: ['child/code.txt'],
            steps: [
              {
                command: process.execPath,
                args: ['-e', 'console.log("REAL_PROFILE_CHECK")'],
                env: {
                  PI_FIND_PUBLIC_ENV: 'visible-setting',
                  PI_FIND_TOKEN: 'secret-fixture',
                },
              },
            ],
          },
        },
        defaultProfiles: ['proof'],
        gates: { push: ['proof'] },
      },
    }),
  );
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
  const tools = Object.fromEntries(
    runner.getAgentTools().map((tool) => [tool.name, tool]),
  );
  const invoke = (name, args) =>
    tools[name].execute(name, args, AbortSignal.timeout(120000));
  const planned = await invoke('acceptance_plan', {});
  assert.equal(planned.isError, false, planned.content[0].text);
  assert.deepEqual(JSON.parse(planned.content[0].text).changedPaths, []);
  const created = await invoke('task_record', {
    action: 'create',
    id: 'ui-flow',
    title: '恢复后仍保留验收要求',
    requirements: [
      { id: 'content', description: '核对项目命令结果', profiles: ['proof'] },
    ],
  });
  assert.equal(created.isError, false);
  assert.equal(
    (await invoke('acceptance_status', { profiles: ['proof'] })).isError,
    true,
  );
  approved = false;
  assert.equal(
    (await invoke('run_acceptance', { profile: 'proof' })).isError,
    true,
  );
  approved = true;
  const validated = await invoke('run_acceptance', { profile: 'proof' });
  assert.equal(validated.isError, false, validated.content[0].text);
  assert.ok(requests.at(-1).includes('visible-setting'));
  assert.ok(
    requests.at(-1).includes('PI_FIND_TOKEN') &&
      requests.at(-1).includes('sha256'),
  );
  assert.ok(
    !requests.at(-1).includes('secret-fixture'),
    '敏感环境值不可直接展示在确认弹窗',
  );
  const approvedConfig = await fs.readFile(
    path.join(tmp, '.pi-find.json'),
    'utf8',
  );
  confirmationHook = async () => {
    const config = JSON.parse(approvedConfig);
    config.acceptance.profiles.proof.steps = [
      {
        command: process.execPath,
        args: [
          '-e',
          'require("fs").writeFileSync(".local/unapproved-command","executed")',
        ],
      },
    ];
    await fs.writeFile(path.join(tmp, '.pi-find.json'), JSON.stringify(config));
  };
  const changedApproval = await invoke('run_acceptance', { profile: 'proof' });
  assert.equal(changedApproval.isError, true, '确认期间配置变化必须拒绝执行');
  await assert.rejects(fs.access(path.join(tmp, '.local/unapproved-command')), {
    code: 'ENOENT',
  });
  await fs.writeFile(path.join(tmp, '.pi-find.json'), approvedConfig);
  assert.equal(
    (await invoke('run_acceptance', { profile: 'proof' })).isError,
    false,
  );
  const complete = await invoke('task_status', { id: 'ui-flow' });
  assert.equal(JSON.parse(complete.content[0].text).status, 'passed');
  await invoke('task_record', {
    action: 'blocker',
    id: 'ui-flow',
    text: '尚未完成人工复核',
  });
  const blockedTask = JSON.parse(
    (await invoke('task_status', { id: 'ui-flow' })).content[0].text,
  );
  assert.equal(blockedTask.status, 'blocked');
  approved = false;
  assert.equal(
    (
      await invoke('task_record', {
        action: 'resolve_blocker',
        id: 'ui-flow',
        blockerId: blockedTask.openBlockers[0].id,
        text: '人工复核完成',
      })
    ).isError,
    true,
  );
  approved = true;
  await invoke('task_record', {
    action: 'resolve_blocker',
    id: 'ui-flow',
    blockerId: blockedTask.openBlockers[0].id,
    text: '人工复核完成',
  });
  assert.ok(
    requests.at(-1).includes('尚未完成人工复核'),
    '确认界面必须展示原阻塞事项',
  );
  const linked = JSON.parse(
    (
      await invoke('prepare_delegate', {
        taskId: 'ui-flow',
        requirementIds: ['content'],
        task: '复核文件',
        acceptance: '返回证据',
        files: ['child/code.txt'],
      })
    ).content[0].text,
  );
  assert.ok(linked.task.includes('content'));
  const summary = await runner.emitBeforeAgentStart('continue', 'base');
  assert.ok(summary.includes('恢复后仍保留验收要求'));
  await fs.writeFile(path.join(tmp, 'child/code.txt'), 'changed');
  assert.ok(
    JSON.parse(
      (await invoke('acceptance_plan', {})).content[0].text,
    ).changedPaths.includes('child/code.txt'),
  );
  assert.equal((await invoke('task_status', { id: 'ui-flow' })).isError, true);
  assert.equal(
    diagnostics.filter((d) =>
      ['handler_error', 'load_error', 'unsupported_api'].includes(d.kind),
    ).length,
    0,
    JSON.stringify(diagnostics),
  );
  console.log(
    'PASS: actual desktop loader, scoped rules, delegation, acceptance permission, real command evidence, task blockers and stale evidence',
  );
} catch (error) {
  failed = true;
  throw error;
} finally {
  await runner?.dispose();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('find-desktop-'));
  if (failed) console.error('Desktop smoke failure evidence preserved:', tmp);
  else await fs.rm(tmp, { recursive: true, force: true });
}
