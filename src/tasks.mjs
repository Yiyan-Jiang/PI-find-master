import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAcceptanceStatus, safeAcceptancePath } from './acceptance.mjs';

const validId = (value) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
function id(value) {
  if (!validId(value))
    throw Error(
      '任务和需求 ID 必须为 1–64 位字母、数字、点、横线或下划线，且以字母或数字开头',
    );
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000)
    throw Error(`${label} 必须是非空文本，最多 16000 字符`);
  return value;
}
function fields(input, allowed) {
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw Error(`不支持任务字段：${key}；验收通过状态只能由证据推导`);
}

/** 本机账本只能存入真实工作区；不通过目录链接写到其他项目。 */
async function directory(root, create = false) {
  root = await fs.realpath(root);
  const target = path.join(root, '.local', 'pi-find', 'tasks');
  let current = root;
  for (const component of ['.local', 'pi-find', 'tasks']) {
    current = path.join(current, component);
    if (create) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!create && error.code === 'ENOENT')
        return { root, dir: target, exists: false };
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(current)) !== current
    )
      throw Error('任务目录不能使用符号链接或目录联接');
  }
  return { root, dir: current, exists: true };
}

async function location(root, taskId, create = false) {
  const folder = await directory(root, create);
  return { ...folder, file: path.join(folder.dir, `task-${id(taskId)}.json`) };
}

async function readFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
    throw Error('任务文件必须是小于 2 MB 的普通文件');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  if (
    !task ||
    typeof task !== 'object' ||
    task.schemaVersion !== 1 ||
    !validId(task.id) ||
    !Number.isSafeInteger(task.revision)
  )
    throw Error('任务记录格式不受支持');
  if (
    typeof task.root !== 'string' ||
    typeof task.title !== 'string' ||
    !['requirements', 'notes', 'decisions', 'blockers', 'handoffs'].every(
      (key) => Array.isArray(task[key]),
    )
  )
    throw Error('任务记录缺少有效的目标、需求或事项数组');
  if (
    task.requirements.some(
      (requirement) =>
        !requirement ||
        !validId(requirement.id) ||
        typeof requirement.description !== 'string' ||
        !Array.isArray(requirement.profiles) ||
        requirement.profiles.some((profile) => !validId(profile)),
    )
  )
    throw Error('任务需求记录格式不受支持');
  for (const key of ['notes', 'decisions', 'blockers'])
    if (
      task[key].some(
        (item) =>
          !item || typeof item.id !== 'string' || typeof item.text !== 'string',
      )
    )
      throw Error('任务事项记录格式不受支持');
  return task;
}

/** 排他写锁与 revision 共同防止多个会话丢失更新；遗留锁不自动清除。 */
async function transact(root, taskId, change) {
  const { file, root: actualRoot } = await location(root, taskId, true);
  let lock;
  try {
    lock = await fs.open(file + '.lock', 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(`任务正在更新或有遗留锁，请核对后重试：${file}.lock`);
    throw error;
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    let previous;
    try {
      previous = await readFile(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous && (previous.root !== actualRoot || previous.id !== taskId))
      throw Error('任务记录与当前工作区或 ID 不一致');
    const updated = await change(previous);
    const now = new Date().toISOString();
    const task = {
      ...updated,
      schemaVersion: 1,
      id: taskId,
      root: actualRoot,
      revision: (previous?.revision || 0) + 1,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(task, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 2_000_000)
      throw Error('任务记录超过 2 MB，请创建后续阶段任务');
    await fs.writeFile(temporary, serialized, { flag: 'wx' });
    await fs.rename(temporary, file);
    return task;
  } finally {
    try {
      await fs.unlink(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await lock.close();
    await fs.unlink(file + '.lock');
  }
}

export async function createTask(root, input) {
  fields(input, ['id', 'title', 'requirements']);
  const taskId = id(input.id);
  const title = text(input.title, '目标');
  if (!Array.isArray(input.requirements) || input.requirements.length > 100)
    throw Error('requirements 必须为最多 100 项的数组');
  const seen = new Set();
  const requirements = input.requirements.map((requirement) => {
    fields(requirement, ['id', 'description', 'profiles']);
    const requirementId = id(requirement.id);
    if (seen.has(requirementId)) throw Error('需求 ID 重复');
    seen.add(requirementId);
    if (
      !Array.isArray(requirement.profiles) ||
      requirement.profiles.some((profile) => !validId(profile))
    )
      throw Error('需求 profiles 必须为验收项 ID 数组');
    return {
      id: requirementId,
      description: text(requirement.description, '需求说明'),
      profiles: [...new Set(requirement.profiles)],
    };
  });
  return transact(root, taskId, (previous) => {
    if (previous) throw Error('任务已经存在；不能覆盖既有目标与验收要求');
    return {
      title,
      requirements,
      notes: [],
      decisions: [],
      blockers: [],
      handoffs: [],
    };
  });
}

export async function readTask(root, input) {
  const { file, root: actualRoot } = await location(root, input.id);
  const task = await readFile(file);
  if (task.root !== actualRoot || task.id !== input.id)
    throw Error('任务记录与当前工作区不一致');
  return task;
}

/** 追加决策、事项及备注；不允许模型直接修改 passed 或删掉验收要求。 */
export async function updateTask(root, input) {
  fields(input, [
    'id',
    'expectedRevision',
    'note',
    'decision',
    'blocker',
    'resolveBlocker',
  ]);
  if (
    !['note', 'decision', 'blocker', 'resolveBlocker'].some(
      (key) => input[key] !== undefined,
    )
  )
    throw Error('必须指定需要追加或解决的事项');
  return transact(root, id(input.id), (task) => {
    if (!task) throw Error('任务不存在');
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== task.revision
    )
      throw Error('任务版本冲突，请重新读取后再更新');
    const createdAt = new Date().toISOString();
    for (const [key, target] of [
      ['note', 'notes'],
      ['decision', 'decisions'],
      ['blocker', 'blockers'],
    ]) {
      if (input[key] !== undefined)
        task[target].push({
          id: crypto.randomUUID(),
          text: text(input[key], key),
          createdAt,
        });
    }
    if (input.resolveBlocker !== undefined) {
      fields(input.resolveBlocker, ['id', 'resolution']);
      const item = task.blockers.find(
        (blocker) => blocker.id === input.resolveBlocker.id,
      );
      if (!item || item.resolvedAt) throw Error('未找到尚未解决的阻塞事项');
      item.resolution = text(input.resolveBlocker.resolution, '解决说明');
      item.resolvedAt = createdAt;
    }
    return task;
  });
}

export async function listTasks(root) {
  const { dir, root: actualRoot, exists } = await directory(root);
  if (!exists) return [];
  const tasks = [];
  for (const name of await fs.readdir(dir)) {
    if (!/^task-[a-z0-9][a-z0-9._-]{0,63}\.json$/i.test(name)) continue;
    const task = await readFile(path.join(dir, name));
    if (task.root !== actualRoot || name !== `task-${task.id}.json`)
      throw Error('任务列表包含其他工作区或 ID 不匹配的记录');
    tasks.push({
      id: task.id,
      title: task.title,
      revision: task.revision,
      updatedAt: task.updatedAt,
      requirementCount: task.requirements.length,
      openBlockers: task.blockers.filter((blocker) => !blocker.resolvedAt)
        .length,
    });
  }
  return tasks.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function recordHandoff(root, input) {
  fields(input, ['id', 'requirementIds', 'brief', 'files']);
  if (
    typeof input.brief !== 'string' ||
    !input.brief.trim() ||
    input.brief.length > 60000
  )
    throw Error('交接正文必须为非空文本，最多 60000 字符');
  if (!Array.isArray(input.requirementIds) || !input.requirementIds.length)
    throw Error('交接必须关联至少一个验收需求 ID');
  if (
    !Array.isArray(input.files) ||
    input.files.some((file) => typeof file !== 'string')
  )
    throw Error('交接文件必须为路径数组');
  const actualRoot = await fs.realpath(root);
  for (const file of input.files) {
    const relative = path.relative(actualRoot, path.resolve(actualRoot, file));
    if (
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith('..' + path.sep)
    )
      throw Error('交接文件超出任务工作区');
    await safeAcceptancePath(actualRoot, relative);
  }
  return transact(root, id(input.id), (task) => {
    if (!task) throw Error('任务不存在');
    if (
      input.requirementIds.some(
        (requirement) =>
          !task.requirements.some((item) => item.id === requirement),
      )
    )
      throw Error('交接引用了不存在的验收需求');
    task.handoffs.push({
      id: crypto.randomUUID(),
      requirementIds: [...new Set(input.requirementIds)],
      briefHash: crypto.createHash('sha256').update(input.brief).digest('hex'),
      files: input.files,
      reviewState: 'unverified',
      createdAt: new Date().toISOString(),
    });
    return task;
  });
}

/** 当前验收状态每次从实际证据重新推导；历史笔记和子代理声明不能设置通过。 */
export async function taskStatus(root, input) {
  const task = await readTask(root, input);
  const profileIds = [
    ...new Set(
      task.requirements.flatMap((requirement) => requirement.profiles),
    ),
  ];
  const acceptance = profileIds.length
    ? await getAcceptanceStatus(root, { profileIds })
    : { configured: false, profiles: [], ok: false };
  const current = await readTask(root, input);
  if (current.revision !== task.revision)
    throw Error('验收核对期间任务已更新，请重新查询当前 revision');
  const requirements = task.requirements.map((requirement) => {
    const profiles = requirement.profiles.map(
      (profileId) =>
        acceptance.profiles.find((profile) => profile.id === profileId) || {
          id: profileId,
          status: acceptance.status || 'unconfigured',
          reason: acceptance.reason,
        },
    );
    return {
      ...requirement,
      profiles,
      status:
        profiles.length &&
        profiles.every((profile) => profile.status === 'passed')
          ? 'passed'
          : profiles.find((profile) => profile.status !== 'passed')?.status ||
            'unconfigured',
    };
  });
  const openBlockers = task.blockers.filter((blocker) => !blocker.resolvedAt);
  const status = openBlockers.length
    ? 'blocked'
    : requirements.length &&
        requirements.every((requirement) => requirement.status === 'passed')
      ? 'passed'
      : requirements.find((requirement) => requirement.status !== 'passed')
          ?.status || 'unconfigured';
  return {
    id: task.id,
    title: task.title,
    revision: task.revision,
    status,
    requirements,
    openBlockers,
    decisions: task.decisions,
    notes: task.notes,
    handoffs: task.handoffs,
    deliveryChecked: false,
  };
}
