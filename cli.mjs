#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig, plan, getStatus, runOnce } from './src/core.mjs';
import { savedEnvironment } from './src/local-state.mjs';

const HELP = `HTTPS 免费证书工具（CLI）

用法：node cli.mjs <命令> [选项]

命令：
  init       创建配置模板；已有文件不会被覆盖
  plan       检查配置并显示执行计划，不申请证书
  status     显示本地证书和任务状态，不申请证书
  run        执行一轮申请、续期和已配置的部署
  watch      立即执行一轮，然后每 12 小时加 0–30 分钟随机延时执行

选项：
  --config <文件>  配置路径，默认 cert-config.json
  --only <任务ID>  仅执行指定任务（run/watch）
  --retry          忽略失败退避，不强制续期（run/watch）
  -h, --help       显示帮助

先运行 init、修改域名和邮箱，再运行 plan。实际申请需要 lego v5。
失败会根据退避时间提前重试；配置错误等整轮异常约 5 分钟后重试。
watch 收到 Ctrl+C / SIGTERM 后停止调度，等待当前一轮结束。`;

export function parseCli(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string', default: 'cert-config.json' },
      only: { type: 'string' },
      retry: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length === 0) return { command: 'help' };
  if (positionals.length !== 1) throw new Error('每次只能执行一个命令。使用 --help 查看用法。');
  const command = positionals[0];
  if (!['init', 'plan', 'status', 'run', 'watch'].includes(command)) {
    throw new Error(`未知命令：${command}。使用 --help 查看用法。`);
  }
  if (!values.config.trim()) throw new Error('--config 不能为空。');
  if (values.only !== undefined && !values.only.trim()) throw new Error('--only 不能为空。');
  if (!['run', 'watch'].includes(command) && (values.only !== undefined || values.retry)) {
    throw new Error('--only 和 --retry 仅支持 run/watch 命令。');
  }
  return { command, configPath: path.resolve(values.config), only: values.only, ignoreBackoff: values.retry };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
}

async function initialize(configPath) {
  const template = await readFile(new URL('./cert-config.example.json', import.meta.url), 'utf8');
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, template, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`配置文件已存在，未覆盖：${configPath}`);
    throw error;
  }
  process.stdout.write(`已创建配置：${configPath}\n请修改域名、邮箱与验证方式，然后运行 plan。\n`);
}

export function nextWatchDelay(results = [], { now = Date.now(), cycleFailed = false, random = Math.random } = {}) {
  const jitter = random();
  if (cycleFailed) return 5 * 60 * 1000 + Math.floor(jitter * 30 * 1000);
  const regular = 12 * 60 * 60 * 1000 + Math.floor(jitter * 30 * 60 * 1000);
  const retryTimes = results.filter((result) => !result.ok)
    .map((result) => Date.parse(result.nextAttemptAt)).filter(Number.isFinite);
  if (retryTimes.length === 0) return regular;
  const retryDelay = Math.max(5000, Math.min(...retryTimes) - now + Math.floor(jitter * 30 * 1000));
  return Math.min(regular, retryDelay);
}

export async function watch(configPath, options = {}) {
  let stopping = false;
  let wake = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stderr.write('已停止后续调度，等待当前一轮完成后退出。\n');
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      let results = [];
      let cycleFailed = false;
      try {
        const config = await loadConfig(configPath);
        if (stopping) break;
        results = await runOnce(config, { ...options, env: await savedEnvironment(configPath, options.env ?? process.env) });
        printJson({ at: new Date().toISOString(), results });
      } catch (error) {
        cycleFailed = true;
        printError(error);
      }
      if (stopping) break;
      const delay = nextWatchDelay(results, { cycleFailed });
      process.stderr.write(`下一轮：${new Date(Date.now() + delay).toISOString()}\n`);
      await new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, delay);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export async function main(args = process.argv.slice(2)) {
  const { command, configPath, only, ignoreBackoff } = parseCli(args);
  if (command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === 'init') return initialize(configPath);
  if (command === 'watch') return watch(configPath, { only, ignoreBackoff });
  const config = await loadConfig(configPath);
  if (command === 'plan') return printJson(await plan(config));
  if (command === 'status') return printJson(await getStatus(config));
  const results = await runOnce(config, { only, ignoreBackoff, env: await savedEnvironment(configPath) });
  printJson(results);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    printError(error);
    process.exitCode = 1;
  });
}
