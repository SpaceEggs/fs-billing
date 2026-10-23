import { readFileSync } from 'node:fs';
import process from 'node:process';

// 把一次 vitest JSON 报告压成一行：序号、退出码、测试数、目标测试状态与耗时、整体 ok/FAIL、失败的测试名、文件级错误。
const [file, index, code] = process.argv.slice(2);
let line;
try {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const tests = report.testResults.flatMap((f) => f.assertionResults);
  const target = tests.find((t) => t.title.includes('启动维护立即建分区'));
  const failed = tests
    .filter((t) => t.status !== 'passed')
    .map((t) => t.title.slice(0, 40));
  const fileMessage = report.testResults
    .map((f) => f.message)
    .filter(Boolean)
    .join('|')
    .slice(0, 200)
    .replace(/\s+/g, ' ');
  line = [
    index,
    `exit=${code}`,
    `n=${tests.length}`,
    `target=${target?.status ?? 'missing'}`,
    `ms=${Math.round(target?.duration ?? -1)}`,
    failed.length || code !== '0' ? 'FAIL' : 'ok',
    failed.join(';'),
    fileMessage,
  ].join('\t');
} catch (error) {
  line = [
    index,
    `exit=${code}`,
    'n=?',
    'target=?',
    'ms=?',
    'FAIL',
    'no-json',
    String(error).slice(0, 100),
  ].join('\t');
}
process.stdout.write(`${line}\n`);
