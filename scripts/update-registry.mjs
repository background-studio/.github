#!/usr/bin/env node
// 用法：
//   GITHUB_TOKEN=... node scripts/update-registry.mjs [--dry-run] [--allow-rollback]
//   node scripts/update-registry.mjs --validate [--strict]
//     离线校验 catalog、图标与现有 registry/v1.json（结构 + 稳定输出）。
//     catalog 已修改但清单尚未重新生成时只告警；--strict 时视为错误。
// 环境变量 ALLOW_ROLLBACK=1 等价于 --allow-rollback。令牌只从环境读取，绝不输出。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_FILE,
  createGitHubClient,
  diffCatalog,
  loadCatalog,
  readJson,
  runUpdate,
  serializeRegistry,
  validateRegistry,
} from './registry-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const inActions = process.env.GITHUB_ACTIONS === 'true';

function warn(message) {
  console.warn(inActions ? `::warning::${message.replace(/\r?\n/g, '%0A')}` : `warning: ${message}`);
}

function fail(message) {
  console.error(inActions ? `::error::${message.replace(/\r?\n/g, '%0A')}` : `error: ${message}`);
  process.exitCode = 1;
}

function summarize(registry) {
  const fmt = (r) => (r ? `${r.version}${r.sha256 ? '' : ' (sha256=null)'}` : '-');
  for (const plugin of registry.plugins) {
    console.log(`${plugin.id.padEnd(14)} stable=${fmt(plugin.releases.stable)} prerelease=${fmt(plugin.releases.prerelease)}`);
  }
  console.log(`${'host'.padEnd(14)} stable=${fmt(registry.host.stable)} prerelease=${fmt(registry.host.prerelease)}`);
}

async function main() {
  for (const arg of args) {
    if (!['--dry-run', '--allow-rollback', '--validate', '--strict'].includes(arg)) throw new Error(`未知参数 ${arg}`);
  }
  if (args.has('--strict') && !args.has('--validate')) throw new Error('--strict 只能与 --validate 一起使用');

  if (args.has('--validate')) {
    const catalog = loadCatalog(root);
    const file = path.join(root, REGISTRY_FILE);
    if (!fs.existsSync(file)) {
      if (args.has('--strict')) throw new Error(`${REGISTRY_FILE} 尚未生成`);
      console.log(`catalog 有效；${REGISTRY_FILE} 尚未生成`);
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    const registry = validateRegistry(readJson(file));
    if (serializeRegistry(registry) !== text) throw new Error(`${REGISTRY_FILE} 不是生成器的稳定输出（被手改或换行被转换）`);
    const diffs = diffCatalog(registry, catalog);
    if (diffs.length) {
      const message = `${REGISTRY_FILE} 与 catalog 未同步（合并后由 Update registry 工作流重新生成）：\n- ${diffs.join('\n- ')}`;
      if (args.has('--strict')) throw new Error(message);
      warn(message);
    }
    summarize(registry);
    console.log(`${REGISTRY_FILE} 有效`);
    return;
  }

  const client = createGitHubClient({ token: process.env.GITHUB_TOKEN, warn });
  const result = await runUpdate({
    root,
    client,
    allowRollback: args.has('--allow-rollback') || process.env.ALLOW_ROLLBACK === '1',
    dryRun: args.has('--dry-run'),
    warn,
  });
  summarize(result.registry);
  if (args.has('--dry-run')) {
    process.stdout.write(result.text);
  } else {
    console.log(result.written ? `已写入 ${REGISTRY_FILE}` : `${REGISTRY_FILE} 无变化`);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
