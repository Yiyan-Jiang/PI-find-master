// 示例只验证临时文件写读；接入真实项目时请替换为实际验收。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const report = path.resolve('.local/pi-find/reports/smoke.xml');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-find-example-'));
let failed = false;
try {
  await fs.writeFile(path.join(temporary, 'probe.txt'), 'real-file-probe');
  assert.equal(
    await fs.readFile(path.join(temporary, 'probe.txt'), 'utf8'),
    'real-file-probe',
  );
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(path.dirname(report), { recursive: true });
  await fs.writeFile(
    report,
    `<?xml version="1.0" encoding="UTF-8"?><testsuite name="example-smoke" tests="1" failures="${failed ? 1 : 0}" errors="0" skipped="0"><testcase name="temporary file round trip">${failed ? '<failure message="probe failed"/>' : ''}</testcase></testsuite>`,
  );
}
process.exitCode = failed ? 1 : 0;
