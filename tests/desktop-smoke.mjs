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
  smoke: {
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
  const createRunner = () => new TrustedExtensionRunner({
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
  runner = createRunner();
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

  const invoke = (name, args = {}) => runner.getAgentTools().find(t => t.name === name)
    .execute(name, args, AbortSignal.timeout(60000));
  const value = result => JSON.parse(result.content[0].text);
  const dispatch = (toolName, input) => runner.emit('tool_call', {toolName, input});
  prompt = await runner.emitBeforeAgentStart('task', 'base');
  assert.ok(prompt.includes('ROOT_CONSTRAINT'));
  assert.equal(await dispatch('Read', {path:'child/code.txt'}), undefined,
    '普通读取不得为规则展示失败重试');
  assert.equal(await dispatch('Task', {task:'读取 child/code.txt 并报告'}), undefined,
    '原生派发不需要插件交接');
  assert.equal(await dispatch('plugin_pi_session_orchestrator_SessionTask', {action:'spawn',task:'只读审查'}), undefined);
  await runner.emit('session_compact', {type:'session_compact'});
  assert.equal(await dispatch('Bash', {command:'git status --short'}), undefined);
  const configPath = path.join(tmp,'.pi-find.json');
  const countPath = path.join(tmp,'.local/executions');
  const script = 'const f=require("fs");const p=".local/executions";f.writeFileSync(p,String(Number(f.existsSync(p)?f.readFileSync(p,"utf8"):0)+1));console.log("REAL_EXEC_OK")';
  const config = {tools:[{id:'probe',description:'真实执行探针',steps:[{command:process.execPath,args:['-e',script]}]}]};
  await fs.writeFile(configPath,JSON.stringify(config));
  const denied = value(await invoke('run_project_tool',{toolId:'probe'}));
  assert.equal(denied.started,false);
  await assert.rejects(fs.access(countPath),{code:'ENOENT'});
  approved = true;
  const first = value(await invoke('run_project_tool',{toolId:'probe'}));
  assert.equal(first.status,'passed');
  assert.equal(first.started,true);
  assert.equal(first.project,tmp);
  assert.equal(first.steps[0].exitCode,0);
  const requestCount = requests.length;
  await invoke('task_record',{action:'create',id:'old',title:'旧任务',requirements:[]});
  await invoke('task_record',{action:'blocker',id:'old',text:'旧事项尚未解决'});
  await fs.writeFile(path.join(tmp,'.local/pi-find/tasks/task-old.json'),'broken optional record');
  const second = value(await invoke('run_project_tool',{toolId:'probe',taskId:'old'}));
  assert.equal(second.status,'passed');
  assert.equal(requests.length,requestCount,'批准复用不依赖任务记录');
  assert.equal(await fs.readFile(countPath,'utf8'),'2');
  assert.ok(second.association?.reasonCode);
  const startup = await runner.emitBeforeAgentStart('continue','base');
  assert.ok(!startup.includes('旧任务'));
  const query = value(await invoke('project_tools',{query:'请查找工程已有入口'}));
  assert.ok(query.availableToolIds.includes('probe'),'自然语言无匹配仍能看见入口');
  assert.ok(query.rulesContent.some(r=>r.text.includes('ROOT_CONSTRAINT')));
  const handoff = value(await invoke('prepare_delegate',{task:'读取文件',acceptance:'报告真实内容',files:['child/code.txt']}));
  await fs.writeFile(path.join(tmp,'child/AGENTS.md'),'UPDATED_RULE');
  assert.equal(await dispatch('Task',{task:handoff.dispatchTask}),undefined,'过期交接不封锁原生派发');
  const changed = structuredClone(config);
  changed.tools[0].steps[0].args=['-e','console.log("REAL_FAILURE");process.exit(4)'];
  await fs.writeFile(configPath,JSON.stringify(changed));
  confirmationHook=async()=>{throw Error('parent host proxy timeout: extensions.ui.request');};
  const uiFailure=value(await invoke('run_project_tool',{toolId:'probe'}));
  assert.equal(uiFailure.reasonCode,'ui_confirmation_failed');
  assert.equal(uiFailure.started,false);
  assert.equal(await fs.readFile(countPath,'utf8'),'2');
  const failure=value(await invoke('run_project_tool',{toolId:'probe'}));
  assert.equal(failure.status,'failed');
  assert.equal(failure.started,true);
  assert.equal(failure.steps[0].exitCode,4);
  changed.tools[0].steps[0].args=['-e','console.log("RACE_ORIGINAL")'];
  await fs.writeFile(configPath,JSON.stringify(changed));
  confirmationHook=async()=>{
    changed.tools[0].steps[0].args=['-e','require("fs").writeFileSync(".local/unapproved","bad")'];
    await fs.writeFile(configPath,JSON.stringify(changed));
  };
  const race=value(await invoke('run_project_tool',{toolId:'probe'}));
  assert.equal(race.reasonCode,'approval_changed');
  assert.equal(race.started,false);
  await assert.rejects(fs.access(path.join(tmp,'.local/unapproved')),{code:'ENOENT'});
  // 真实 Git、正式验收、证据失效与显式交付 gate。
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:tmp,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('config','user.name','Desktop smoke');git('config','user.email','desktop@example.invalid');
  await fs.writeFile(path.join(tmp,'.gitignore'),'.local/\n');
  const modern={acceptance:{profiles:{proof:{kind:'command',include:['child/code.txt'],steps:[{command:process.execPath,args:['-e','console.log("REAL_PROFILE_CHECK")'],env:{PI_FIND_TOKEN:'secret-fixture'}}]}},gates:{push:['proof']}}};
  await fs.writeFile(configPath,JSON.stringify(modern));
  const proof=value(await invoke('run_acceptance',{profile:'proof'}));
  assert.equal(proof.ok,true,JSON.stringify(proof));
  assert.equal(proof.started,true);
  assert.ok(requests.at(-1).includes('sha256')&&!requests.at(-1).includes('secret-fixture'));
  assert.equal(value(await invoke('acceptance_status',{action:'push'})).ok,false,'无 HEAD 交付必须拒绝');
  git('add','.');git('-c','commit.gpgsign=false','commit','-qm','fixture');
  assert.equal(value(await invoke('acceptance_status',{action:'push'})).ok,true);
  await invoke('task_record',{action:'create',id:'facts',title:'仅供参考',requirements:[{id:'read',description:'证据范围',profiles:['proof']}]});
  await invoke('task_record',{action:'blocker',id:'facts',text:'等待人工备注'});
  const facts=value(await invoke('task_status',{id:'facts'}));
  assert.equal(facts.evidenceStatus,'passed');assert.equal(facts.status,undefined);assert.equal(facts.openBlockers.length,1);
  approved=false;
  const beforeResolve=requests.length;
  assert.equal((await invoke('task_record',{action:'resolve_blocker',id:'facts',blockerId:facts.openBlockers[0].id,text:'事项已处理'})).isError,false);
  assert.equal(requests.length,beforeResolve);
  await fs.writeFile(path.join(tmp,'child/code.txt'),'changed');
  const stale=await invoke('acceptance_status',{});
  assert.equal(value(stale).ok,false);
  assert.equal(stale.isError,false,'普通证据过期是查询结果，不是工具执行失败');
  assert.equal(value(await invoke('acceptance_status',{action:'push'})).ok,false);
  approved=true;
  const evidenceConfig={tools:[{id:'evidence-write',category:'quality',steps:[{command:process.execPath,args:['-e','require("fs").writeFileSync(".local/completed-once","yes")']}]}]};
  await fs.writeFile(configPath,JSON.stringify(evidenceConfig));
  await fs.mkdir(path.join(tmp,'.local/pi-find/quality.json'));
  const storageFailure=value(await invoke('run_project_tool',{toolId:'evidence-write'}));
  assert.equal(storageFailure.executionOk,true);
  assert.equal(storageFailure.started,true);
  assert.equal(storageFailure.reasonCode,'evidence_failed');
  assert.equal(await fs.readFile(path.join(tmp,'.local/completed-once'),'utf8'),'yes');
  assert.equal(storageFailure.steps[0].exitCode,0);
  await fs.rmdir(path.join(tmp,'.local/pi-find/quality.json'));
  const midConfig={tools:[{id:'multi',steps:[
    {command:process.execPath,args:['-e','const f=require("fs");f.renameSync(".local/pi-find/logs",".local/log-history");f.writeFileSync(".local/pi-find/logs","blocked");f.appendFileSync(".local/once","1")']},
    {command:process.execPath,args:['-e','require("fs").writeFileSync(".local/should-not-run","bad")']},
  ]}]};
  await fs.writeFile(configPath,JSON.stringify(midConfig));
  const partial=value(await invoke('run_project_tool',{toolId:'multi'}));
  assert.equal(partial.started,true,'前一步已执行不能报告未启动');
  assert.equal(partial.steps[0].exitCode,0);
  assert.equal(partial.steps[1].started,false);
  assert.equal(await fs.readFile(path.join(tmp,'.local/once'),'utf8'),'1');
  await assert.rejects(fs.access(path.join(tmp,'.local/should-not-run')),{code:'ENOENT'});
  await fs.unlink(path.join(tmp,'.local/pi-find/logs'));
  await fs.rename(path.join(tmp,'.local/log-history'),path.join(tmp,'.local/pi-find/logs'));
  const raced=structuredClone(modern);
  raced.acceptance.profiles.proof.steps=[{command:process.execPath,args:['-e','console.log("ACCEPTANCE_ORIGINAL")']}];
  await fs.writeFile(configPath,JSON.stringify(raced));
  approved=false;
  const acceptanceDenied=value(await invoke('run_acceptance',{profile:'proof'}));
  assert.equal(acceptanceDenied.started,false);
  approved=true;
  confirmationHook=async()=>{
    raced.acceptance.profiles.proof.steps=[{command:process.execPath,args:['-e','require("fs").writeFileSync(".local/acceptance-unapproved","bad")']}];
    await fs.writeFile(configPath,JSON.stringify(raced));
  };
  const acceptanceRace=value(await invoke('run_acceptance',{profile:'proof'}));
  assert.equal(acceptanceRace.reasonCode,'approval_changed');
  assert.equal(acceptanceRace.started,false);
  await assert.rejects(fs.access(path.join(tmp,'.local/acceptance-unapproved')),{code:'ENOENT'});
  // 坏配置不得使整个 agent 启动失败；实际执行仍准确拒绝。
  await fs.writeFile(configPath,'{broken');
  assert.ok((await runner.emitBeforeAgentStart('bad config','base')).includes('diagnostics'));
  assert.equal(value(await invoke('run_project_tool',{toolId:'probe'})).started,false);
  assert.equal(diagnostics.filter(d=>['handler_error','load_error','unsupported_api'].includes(d.kind)).length,0,JSON.stringify(diagnostics));
  console.log('PASS: actual Desktop loader, native dispatch without workflow, task-independent approval, UI timeout, config race, real execution, unborn Git acceptance, delivery gates and advisory records');
  }
} catch (error) { failed=true; throw error; }
finally {
  await runner?.dispose();
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('find-desktop-'));
  if(failed)console.error('Desktop smoke failure evidence preserved:',tmp);
  else await fs.rm(tmp,{recursive:true,force:true});
}
