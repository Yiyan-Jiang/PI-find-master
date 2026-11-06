#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { planAcceptance } from './planning.mjs';
import {
  getAcceptanceStatus,
  runAcceptance,
  safeAcceptancePath,
} from './acceptance.mjs';
const args = process.argv.slice(2);
let root = process.cwd(),
  json = false,
  action,
  timeoutMs,
  base;
const positional = [];
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    '用法：pi-find init | plan [--base ref] | status [--action push] | run <profile> [--timeout ms] | gate <action> [--root dir] [--json]',
  );
  process.exit(0);
}
try {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') {
      if (!args[i + 1]) throw Error('--root 缺少目录');
      root = path.resolve(args[++i]);
    } else if (a === '--json') json = true;
    else if (a === '--base') {
      if (!args[i + 1] || args[i + 1].startsWith('-'))
        throw Error('--base 缺少有效 ref');
      base = args[++i];
    } else if (a === '--action') {
      if (!args[i + 1]) throw Error('--action 缺少动作');
      action = args[++i];
    } else if (a === '--timeout') {
      timeoutMs = Number(args[++i]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw Error('--timeout 必须为正数毫秒');
    } else if (a.startsWith('-')) throw Error('未知参数：' + a);
    else positional.push(a);
  }
  const [command, value] = positional;
  if (positional.length > 2) throw Error('位置参数过多');
  if (base !== undefined && command !== 'plan')
    throw Error('--base 仅用于 plan 命令');
  root = await fs.realpath(root);
  let result;
  if (['init', 'status', 'plan'].includes(command) && value)
    throw Error(command + ' 不接受额外位置参数');
  if (command === 'init') {
    const filename = await safeAcceptancePath(root, '.pi-find.json');
    const sample = {
      acceptance: {
        profiles: {
          verify: {
            kind: 'command',
            description:
              '样板：请替换为项目明确授权的验证命令；command 只证明命令完成',
            include: ['**'],
            exclude: [],
            steps: [{ command: 'node', args: ['--version'] }],
          },
        },
        defaultProfiles: ['verify'],
        gates: {},
        impact: [],
      },
    };
    try {
      await fs.writeFile(filename, JSON.stringify(sample, null, 2) + '\n', {
        flag: 'wx',
      });
      result = { ok: true, created: true, path: filename };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      result = {
        ok: true,
        created: false,
        path: filename,
        reason: '已有配置，未覆盖',
      };
    }
  } else if (command === 'plan') result = await planAcceptance(root, { base });
  else if (command === 'status')
    result = await getAcceptanceStatus(root, { action });
  else if (command === 'gate') {
    if (!value) throw Error('用法：gate <action>');
    result = await getAcceptanceStatus(root, { action: value });
  } else if (command === 'run') {
    if (!value) throw Error('用法：run <profile>');
    const controller = new AbortController();
    const cancel = () => controller.abort(Error('CLI 取消'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      result = await runAcceptance(root, value, {
        signal: controller.signal,
        timeoutMs,
      });
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  } else
    throw Error(
      '用法：pi-find init | plan [--base ref] | status [--action push] | run <profile> [--timeout ms] | gate <action> [--root dir] [--json]',
    );
  console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (e) {
  console.log(
    JSON.stringify(
      { ok: false, status: 'blocked', reason: e.message },
      null,
      json ? 0 : 2,
    ),
  );
  process.exitCode = 1;
}
