// 官方插件/壳清单（registry/v1.json）生成逻辑。
// 仅在 GitHub Actions 服务端使用 GITHUB_TOKEN 查询 Releases API；客户端只读取生成后的静态 JSON。
// 无第三方依赖，Node >= 20。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const PLUGIN_PROTOCOL = 1;
export const ORG = 'background-studio';
export const REGISTRY_URL =
  'https://raw.githubusercontent.com/background-studio/.github/main/registry/v1.json';
export const ICON_BASE_URL =
  'https://raw.githubusercontent.com/background-studio/.github/main/registry/icons/';
export const API_BASE = 'https://api.github.com';
export const PER_PAGE = 100;
/** 每个仓库最多翻页数（100 * 5 = 最近 500 个 Release，按创建时间倒序，足够覆盖最高版本）。 */
export const MAX_RELEASE_PAGES = 5;
export const SIDECAR_MAX_BYTES = 4096;
/** 与客户端校验保持一致的上限。 */
export const MAX_REGISTRY_BYTES = 1024 * 1024;
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_PLUGINS = 256;
export const RESERVED_IDS = Object.freeze(['console', 'host']);

export const CATALOG_FILE = path.join('catalog', 'plugins.json');
export const ICONS_DIR = path.join('registry', 'icons');
export const REGISTRY_FILE = path.join('registry', 'v1.json');

export const HOST = Object.freeze({
  owner: ORG,
  repo: 'background-studio',
});

export function pluginAssetName(def, version) {
  return `${def.assetPrefix}${version}-plugin.zip`;
}

export function hostAssetName(version) {
  return `Background.Studio_${version}_x64-setup.exe`;
}

/** 清单中的 icon 是安全文件名 `<id>.png`；客户端固定从 ICON_BASE_URL + `<id>.png` 拉取。 */
export function iconFileName(id) {
  return `${id}.png`;
}

// ---------------------------------------------------------------------------
// semver
// ---------------------------------------------------------------------------

const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?$`,
);

/** 解析严格 semver（不允许 build 元数据 `+...`，不允许 v 前缀）。 */
export function parseSemver(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const nums = [match[1], match[2], match[3]].map(Number);
  if (!nums.every(Number.isSafeInteger)) return null;
  return {
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    pre: match[4] ? match[4].split('.') : [],
  };
}

function compareIdent(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (an) return -1;
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** 比较两个 semver 字符串；任一无效时抛错。 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`无效 semver 比较：${a} / ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const len = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < len; i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = compareIdent(x.pre[i], y.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** tag 必须是 `vX.Y.Z[-pre]`（客户端要求 tag = "v" + version），返回去掉 v 的版本号。 */
export function versionFromTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  return parseSemver(version) ? version : null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(obj, keys, where) {
  assert(isPlainObject(obj), `${where} 必须是对象`);
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  assert(
    actual.length === expected.length && actual.every((k, i) => k === expected[i]),
    `${where} 字段必须恰好为 [${expected.join(', ')}]，实际为 [${actual.join(', ')}]`,
  );
}

function nonEmptyString(value, where, max = 256) {
  assert(typeof value === 'string' && value.trim() !== '' && value.length <= max, `${where} 必须是非空字符串（≤${max}）`);
  assert(!/[\u0000-\u001f]/.test(value), `${where} 不能包含控制字符`);
}

// 所有参与拼接的片段（owner/repo/tag/assetName）都已被限制为 [A-Za-z0-9._-]，
// 因此用精确字符串比较即可，与客户端规则一致。
export function expectedDownloadUrl(owner, repo, tag, assetName) {
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${assetName}`;
}

export function expectedReleaseUrl(owner, repo, tag) {
  return `https://github.com/${owner}/${repo}/releases/tag/${tag}`;
}

export function isDownloadUrl(url, owner, repo, tag, assetName) {
  return url === expectedDownloadUrl(owner, repo, tag, assetName);
}

export function isReleaseUrl(url, owner, repo, tag) {
  return url === expectedReleaseUrl(owner, repo, tag);
}

/** 键排序后的稳定 JSON，用于语义比较。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function serializeRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// catalog（唯一的插件列表）
// ---------------------------------------------------------------------------

const PLUGIN_DEF_KEYS = ['id', 'displayName', 'owner', 'repo', 'assetPrefix', 'exeName', 'pipeName', 'targetHint', 'icon'];

/** 校验 catalog/plugins.json。iconsDir 给定时同时检查 registry/icons/<id>.png 是 PNG。 */
export function validateCatalog(catalog, { iconsDir } = {}) {
  assertExactKeys(catalog, ['pluginProtocol', 'plugins'], 'catalog');
  assert(catalog.pluginProtocol === PLUGIN_PROTOCOL, `catalog.pluginProtocol 必须为 ${PLUGIN_PROTOCOL}`);
  assert(Array.isArray(catalog.plugins) && catalog.plugins.length > 0, 'catalog.plugins 必须是非空数组');
  assert(catalog.plugins.length <= MAX_PLUGINS, `catalog.plugins 不能超过 ${MAX_PLUGINS} 个`);
  const ids = new Set();
  const repos = new Set();
  const prefixes = new Set();
  catalog.plugins.forEach((def, index) => {
    const where = `catalog.plugins[${index}]`;
    assertExactKeys(def, PLUGIN_DEF_KEYS, where);
    for (const key of PLUGIN_DEF_KEYS) {
      if (key !== 'targetHint') nonEmptyString(def[key], `${where}.${key}`);
    }
    assert(typeof def.targetHint === 'string' && def.targetHint.length <= 256, `${where}.targetHint 必须是字符串`);
    assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.id), `${where}.id 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$`);
    assert(!RESERVED_IDS.includes(def.id), `${where}.id 不能使用保留名 ${def.id}`);
    assert(def.owner === ORG, `${where}.owner 必须是白名单组织 ${ORG}`);
    assert(/^[A-Za-z0-9._-]{1,100}$/.test(def.repo) && def.repo !== '.' && def.repo !== '..', `${where}.repo 非法`);
    assert(def.repo !== HOST.repo, `${where}.repo 不能是壳仓库`);
    assert(/^[A-Za-z0-9._-]{1,64}$/.test(def.assetPrefix) && def.assetPrefix.endsWith('-'), `${where}.assetPrefix 必须匹配 [A-Za-z0-9._-]{1,64} 且以 - 结尾`);
    assert(/^[^\\/:*?"<>|]+\.exe$/.test(def.exeName), `${where}.exeName 必须是不含路径的 .exe 文件名`);
    assert(/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(def.pipeName), `${where}.pipeName 必须形如 \\\\.\\pipe\\name`);
    assert(def.icon === iconFileName(def.id), `${where}.icon 必须为 ${iconFileName(def.id)}（官方图标放在 registry/icons/<id>.png）`);
    assert(!ids.has(def.id), `${where}.id 重复：${def.id}`);
    assert(!repos.has(def.repo.toLowerCase()), `${where}.repo 重复：${def.repo}`);
    assert(!prefixes.has(def.assetPrefix), `${where}.assetPrefix 重复：${def.assetPrefix}`);
    ids.add(def.id);
    repos.add(def.repo.toLowerCase());
    prefixes.add(def.assetPrefix);
    if (iconsDir) {
      const file = path.join(iconsDir, `${def.id}.png`);
      assert(fs.existsSync(file), `缺少官方图标 ${file}`);
      const bytes = fs.readFileSync(file);
      assert(bytes.length > 0 && bytes.length <= MAX_ICON_BYTES, `${file} 大小超过 ${MAX_ICON_BYTES} 字节`);
      const head = bytes.subarray(0, 8);
      assert(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file} 不是 PNG`);
    }
  });
  return catalog;
}

// ---------------------------------------------------------------------------
// Release 选择
// ---------------------------------------------------------------------------

function validateRawRelease(release, where) {
  assert(isPlainObject(release), `${where} 不是对象`);
  assert(typeof release.draft === 'boolean', `${where}.draft 缺失`);
  assert(typeof release.prerelease === 'boolean', `${where}.prerelease 缺失`);
  assert(typeof release.tag_name === 'string', `${where}.tag_name 缺失`);
  assert(typeof release.html_url === 'string', `${where}.html_url 缺失`);
  assert(Array.isArray(release.assets), `${where}.assets 缺失`);
  release.assets.forEach((asset, i) => {
    assert(isPlainObject(asset) && typeof asset.name === 'string', `${where}.assets[${i}].name 缺失`);
  });
}

/** 匹配资产的合法性问题；返回 null 表示可用。 */
function assetProblem(asset, { owner, repo, tag }) {
  if (asset.state !== 'uploaded') return `资产状态为 ${asset.state}`;
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) return '资产大小无效';
  if (!isDownloadUrl(asset.browser_download_url, owner, repo, tag, asset.name)) return `下载地址不符合预期：${asset.browser_download_url}`;
  return null;
}

/**
 * 从 Releases API 原始数组中选出 stable / prerelease 各自 semver 最高且带匹配资产的版本。
 * 返回 { stable, prerelease }，每项为 { version, tag, release, asset } 或 null。
 */
export function selectChannels(rawReleases, { owner, repo, assetNameFor, label, warn = () => {} }) {
  assert(Array.isArray(rawReleases), `${label}: Releases 响应不是数组`);
  const seen = new Map();
  const candidates = [];
  rawReleases.forEach((release, index) => {
    validateRawRelease(release, `${label} releases[${index}]`);
    if (release.draft) return;
    const version = versionFromTag(release.tag_name);
    if (!version) {
      warn(`${label}: 跳过不符合 v<semver> 的 tag ${release.tag_name}`);
      return;
    }
    const isPre = parseSemver(version).pre.length > 0;
    if (isPre !== release.prerelease) {
      warn(`${label}: 跳过 ${release.tag_name}（GitHub prerelease=${release.prerelease} 与版本号不一致）`);
      return;
    }
    if (seen.has(version)) {
      throw new Error(`${label}: 版本 ${version} 存在多个 Release（${seen.get(version)} / ${release.tag_name}），拒绝猜测`);
    }
    seen.set(version, release.tag_name);
    candidates.push({ version, isPre, release });
  });
  candidates.sort((a, b) => compareSemver(b.version, a.version));

  const pick = (wantPre) => {
    for (const candidate of candidates) {
      if (candidate.isPre !== wantPre) continue;
      const { release, version } = candidate;
      const expected = assetNameFor(version);
      const matches = release.assets.filter((asset) => asset.name === expected);
      if (matches.length !== 1) {
        warn(`${label}: ${release.tag_name} 没有唯一的 ${expected}，继续查找更低版本`);
        continue;
      }
      const problem = assetProblem(matches[0], { owner, repo, tag: release.tag_name });
      if (problem) {
        warn(`${label}: ${release.tag_name} 的 ${expected} 不可用（${problem}），继续查找更低版本`);
        continue;
      }
      if (!isReleaseUrl(release.html_url, owner, repo, release.tag_name)) {
        warn(`${label}: ${release.tag_name} 的 html_url 不符合预期，继续查找更低版本`);
        continue;
      }
      return { version, tag: release.tag_name, release, asset: matches[0] };
    }
    return null;
  };

  return { stable: pick(false), prerelease: pick(true) };
}

/** 解析 `.sha256` 侧车文本：`<hex>` 或 `<hex>  [*]<filename>`，文件名若存在必须等于资产名。 */
export function parseSidecar(text, assetName) {
  assert(typeof text === 'string', 'sha256 侧车内容无效');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  assert(lines.length === 1, `sha256 侧车应只有一行，实际 ${lines.length} 行`);
  const match = /^\s*([0-9A-Fa-f]{64})(?:\s+\*?(.+?))?\s*$/.exec(lines[0]);
  assert(match, 'sha256 侧车格式无效');
  if (match[2] !== undefined) {
    const name = match[2].split(/[\\/]/).pop();
    assert(name === assetName, `sha256 侧车文件名 ${name} 与资产 ${assetName} 不一致`);
  }
  return match[1].toLowerCase();
}

function parseDigest(digest, where) {
  if (digest === undefined || digest === null) return { kind: 'none' };
  assert(typeof digest === 'string', `${where} digest 字段类型无效`);
  const lower = digest.toLowerCase();
  if (lower.startsWith('sha256:')) {
    const hex = lower.slice('sha256:'.length);
    assert(HEX64_RE.test(hex), `${where} digest 不是合法 sha256：${digest}`);
    return { kind: 'sha256', hex };
  }
  return { kind: 'other' };
}

/**
 * 取资产 sha256：优先 GitHub asset.digest（不额外请求）；否则下载同 Release 的 `<asset>.sha256` 侧车；
 * 两者都没有（旧资产）返回 null。任何下载/格式错误直接抛错，绝不伪造。
 */
export async function resolveSha256(picked, { owner, repo, downloadText, label, warn = () => {} }) {
  const { asset, release } = picked;
  const where = `${label}: ${asset.name}`;
  const digest = parseDigest(asset.digest, where);
  if (digest.kind === 'sha256') return digest.hex;

  const sidecarName = `${asset.name}.sha256`;
  const sidecars = release.assets.filter((a) => a.name === sidecarName);
  if (sidecars.length === 0) {
    warn(`${where} 没有 GitHub digest，也没有 ${sidecarName}，sha256 记为 null`);
    return null;
  }
  assert(sidecars.length === 1, `${where} 存在多个 ${sidecarName}`);
  const sidecar = sidecars[0];
  const problem = assetProblem(sidecar, { owner, repo, tag: release.tag_name });
  assert(!problem, `${where} 的侧车不可用：${problem}`);
  assert(sidecar.size <= SIDECAR_MAX_BYTES, `${where} 的侧车过大（${sidecar.size} 字节）`);
  const bytes = await downloadText(sidecar.browser_download_url, SIDECAR_MAX_BYTES);
  const sidecarDigest = parseDigest(sidecar.digest, `${where}.sha256`);
  if (sidecarDigest.kind === 'sha256') {
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert(actual === sidecarDigest.hex, `${where} 侧车内容与其 GitHub digest 不一致`);
  }
  return parseSidecar(bytes.toString('utf8'), asset.name);
}

function toRelease(picked, sha256) {
  if (!picked) return null;
  return {
    version: picked.version,
    tag: picked.tag,
    assetName: picked.asset.name,
    downloadUrl: picked.asset.browser_download_url,
    releaseUrl: picked.release.html_url,
    sha256,
  };
}

async function resolveChannels(rawReleases, { owner, repo, assetNameFor, label, downloadText, warn }) {
  const channels = selectChannels(rawReleases, { owner, repo, assetNameFor, label, warn });
  const out = {};
  for (const name of ['stable', 'prerelease']) {
    const picked = channels[name];
    out[name] = picked
      ? toRelease(picked, await resolveSha256(picked, { owner, repo, downloadText, label, warn }))
      : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub 客户端（仅服务端）
// ---------------------------------------------------------------------------

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match) return match[1];
  }
  return null;
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {string} options.token  GitHub Actions GITHUB_TOKEN；只发往 api.github.com。
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createGitHubClient({
  token,
  fetchImpl = globalThis.fetch,
  apiBase = API_BASE,
  retries = 2,
  timeoutMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPages = MAX_RELEASE_PAGES,
  warn = () => {},
}) {
  assert(typeof token === 'string' && token.length > 0, '缺少 GITHUB_TOKEN');
  const apiOrigin = new URL(apiBase).origin;

  async function request(url, { auth, accept }) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      let response;
      try {
        const headers = { 'User-Agent': 'background-studio-registry', Accept: accept };
        if (auth) {
          assert(new URL(url).origin === apiOrigin, '拒绝把令牌发送到非 API 主机');
          headers.Authorization = `Bearer ${token}`;
          headers['X-GitHub-Api-Version'] = '2022-11-28';
        }
        response = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        lastError = new Error(`请求 ${url} 失败：${error?.message ?? error}`);
        continue;
      }
      if (response.ok) return response;
      let detail = '';
      try {
        const body = await response.text();
        detail = JSON.parse(body)?.message ?? '';
      } catch {
        // 忽略：只用于错误提示
      }
      lastError = new HttpError(`请求 ${url} 返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 200)}` : ''}`, response.status);
      // 5xx 可重试；4xx（含 403/429 限流、404 仓库不可见）立即失败。
      if (response.status < 500) break;
    }
    throw lastError;
  }

  async function listReleases(owner, repo) {
    let url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${PER_PAGE}`;
    const all = [];
    for (let page = 1; url; page += 1) {
      if (page > maxPages) {
        warn(`${owner}/${repo}: Release 超过 ${maxPages} 页，只检查最近 ${maxPages * PER_PAGE} 个`);
        break;
      }
      const response = await request(url, { auth: true, accept: 'application/vnd.github+json' });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(`${owner}/${repo}: Releases 响应不是 JSON：${error.message}`);
      }
      assert(Array.isArray(body), `${owner}/${repo}: Releases 响应不是数组`);
      all.push(...body);
      const next = parseNextLink(response.headers.get('link'));
      if (next) assert(new URL(next).origin === apiOrigin, `${owner}/${repo}: 分页链接主机异常`);
      url = next;
    }
    return all;
  }

  /** 下载公开 Release 资产（不带令牌），限制大小，返回 Buffer。 */
  async function downloadText(url, maxBytes) {
    assert(new URL(url).protocol === 'https:', '只允许 https 下载');
    const response = await request(url, { auth: false, accept: 'application/octet-stream' });
    const buffer = Buffer.from(await response.arrayBuffer());
    assert(buffer.length > 0 && buffer.length <= maxBytes, `下载内容大小异常（${buffer.length} 字节）：${url}`);
    return buffer;
  }

  return { listReleases, downloadText };
}

// ---------------------------------------------------------------------------
// 生成 / 校验 / 回滚检查
// ---------------------------------------------------------------------------

/** 拉取全部仓库并生成 { plugins, host }（不含 schemaVersion/generatedAt）。任一失败即抛错。 */
export async function buildRegistryBody(catalog, { client, warn = () => {} }) {
  const pluginTasks = catalog.plugins.map(async (def) => {
    const raw = await client.listReleases(def.owner, def.repo);
    const releases = await resolveChannels(raw, {
      owner: def.owner,
      repo: def.repo,
      assetNameFor: (version) => pluginAssetName(def, version),
      label: def.id,
      downloadText: client.downloadText,
      warn,
    });
    return {
      id: def.id,
      displayName: def.displayName,
      owner: def.owner,
      repo: def.repo,
      assetPrefix: def.assetPrefix,
      exeName: def.exeName,
      pipeName: def.pipeName,
      targetHint: def.targetHint,
      icon: iconFileName(def.id),
      releases,
    };
  });
  const hostTask = (async () => {
    const raw = await client.listReleases(HOST.owner, HOST.repo);
    return resolveChannels(raw, {
      owner: HOST.owner,
      repo: HOST.repo,
      assetNameFor: hostAssetName,
      label: 'host',
      downloadText: client.downloadText,
      warn,
    });
  })();
  const [plugins, host] = await Promise.all([Promise.all(pluginTasks), hostTask]);
  return { plugins, host };
}

const RELEASE_KEYS = ['version', 'tag', 'assetName', 'downloadUrl', 'releaseUrl', 'sha256'];
const PLUGIN_KEYS = [...PLUGIN_DEF_KEYS, 'releases'];

function validateRelease(release, { owner, repo, channel, assetNameFor, where }) {
  if (release === null) return;
  assertExactKeys(release, RELEASE_KEYS, where);
  const parsed = parseSemver(release.version);
  assert(parsed, `${where}.version 不是 semver：${release.version}`);
  assert(channel === 'prerelease' ? parsed.pre.length > 0 : parsed.pre.length === 0, `${where}.version 与通道 ${channel} 不符`);
  assert(release.tag === `v${release.version}`, `${where}.tag 必须为 v${release.version}`);
  assert(release.assetName === assetNameFor(release.version), `${where}.assetName 与 version 不符`);
  assert(isDownloadUrl(release.downloadUrl, owner, repo, release.tag, release.assetName), `${where}.downloadUrl 非法`);
  assert(isReleaseUrl(release.releaseUrl, owner, repo, release.tag), `${where}.releaseUrl 非法`);
  assert(release.sha256 === null || (typeof release.sha256 === 'string' && HEX64_RE.test(release.sha256)), `${where}.sha256 必须为 64 位小写十六进制或 null`);
}

function validateChannels(channels, ctx, where) {
  assertExactKeys(channels, ['stable', 'prerelease'], where);
  for (const channel of ['stable', 'prerelease']) {
    validateRelease(channels[channel], { ...ctx, channel, where: `${where}.${channel}` });
  }
}

/** 完整校验 v1 清单结构；catalog 给定时要求插件列表与 catalog 完全一致。 */
export function validateRegistry(registry, { catalog } = {}) {
  assertExactKeys(registry, ['schemaVersion', 'generatedAt', 'plugins', 'host'], 'registry');
  assert(registry.schemaVersion === SCHEMA_VERSION, `schemaVersion 必须为 ${SCHEMA_VERSION}`);
  assert(
    typeof registry.generatedAt === 'string' && ISO_RE.test(registry.generatedAt) && !Number.isNaN(Date.parse(registry.generatedAt)),
    'generatedAt 必须是 UTC ISO8601',
  );
  assert(Array.isArray(registry.plugins), 'plugins 必须是数组');
  assert(registry.plugins.length <= MAX_PLUGINS, `plugins 不能超过 ${MAX_PLUGINS} 个`);
  const defs = registry.plugins.map(({ releases, ...def }) => def);
  registry.plugins.forEach((plugin, index) => {
    const where = `plugins[${index}]`;
    assertExactKeys(plugin, PLUGIN_KEYS, where);
    validateChannels(
      plugin.releases,
      { owner: plugin.owner, repo: plugin.repo, assetNameFor: (v) => pluginAssetName(plugin, v) },
      `${where}.releases`,
    );
  });
  // 复用 catalog 校验字段格式与唯一性。
  validateCatalog({ pluginProtocol: PLUGIN_PROTOCOL, plugins: defs });
  if (catalog) {
    const diffs = diffCatalog(registry, catalog);
    assert(diffs.length === 0, `registry.plugins 与 catalog/plugins.json 不一致：\n- ${diffs.join('\n- ')}`);
  }
  validateChannels(registry.host, { owner: HOST.owner, repo: HOST.repo, assetNameFor: hostAssetName }, 'host');
  return registry;
}

/**
 * 列出 registry.plugins 与 catalog 的差异（新增/移除/字段变化/顺序）。
 * 空数组表示已同步；非空表示 catalog 已修改、等待工作流重新生成。
 */
export function diffCatalog(registry, catalog) {
  const diffs = [];
  const defs = registry.plugins.map(({ releases, ...def }) => def);
  const registryById = new Map(defs.map((d) => [d.id, d]));
  const catalogIds = new Set(catalog.plugins.map((d) => d.id));
  for (const def of catalog.plugins) {
    const current = registryById.get(def.id);
    if (!current) {
      diffs.push(`${def.id}: catalog 新增，清单尚未生成`);
      continue;
    }
    for (const key of PLUGIN_DEF_KEYS) {
      if (current[key] !== def[key]) diffs.push(`${def.id}.${key}: 清单为 ${JSON.stringify(current[key])}，catalog 为 ${JSON.stringify(def[key])}`);
    }
  }
  for (const def of defs) {
    if (!catalogIds.has(def.id)) diffs.push(`${def.id}: 已从 catalog 移除，清单尚未更新`);
  }
  const sharedCatalog = catalog.plugins.map((d) => d.id).filter((id) => registryById.has(id));
  const sharedRegistry = defs.map((d) => d.id).filter((id) => catalogIds.has(id));
  if (sharedCatalog.join('\n') !== sharedRegistry.join('\n')) diffs.push('插件顺序与 catalog 不一致');
  return diffs;
}

/** 与旧清单比较，返回回滚/异常变化列表（空数组表示安全）。 */
export function findRollbacks(previous, next) {
  if (!previous) return [];
  const problems = [];
  const compare = (label, before, after) => {
    for (const channel of ['stable', 'prerelease']) {
      const a = before?.[channel] ?? null;
      const b = after?.[channel] ?? null;
      const where = `${label}.${channel}`;
      if (!a) continue;
      if (!b) {
        problems.push(`${where}: ${a.version} 消失（新结果为 null）`);
        continue;
      }
      const order = compareSemver(b.version, a.version);
      if (order < 0) {
        problems.push(`${where}: 版本从 ${a.version} 回退到 ${b.version}`);
      } else if (order === 0) {
        for (const key of ['tag', 'assetName', 'downloadUrl']) {
          if (a[key] !== b[key]) problems.push(`${where}: 同版本 ${a.version} 的 ${key} 改变`);
        }
        if (a.sha256 !== null && a.sha256 !== b.sha256) {
          problems.push(`${where}: 同版本 ${a.version} 的 sha256 改变（${a.sha256} -> ${b.sha256}）`);
        }
      }
    }
  };
  const oldPlugins = new Map(previous.plugins.map((p) => [p.id, p]));
  for (const plugin of next.plugins) {
    if (oldPlugins.has(plugin.id)) compare(plugin.id, oldPlugins.get(plugin.id).releases, plugin.releases);
  }
  compare('host', previous.host, next.host);
  return problems;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 内容无变化时保留旧 generatedAt，避免无意义提交。 */
export function finalizeRegistry(previous, body, now) {
  if (previous) {
    const { schemaVersion, generatedAt, ...oldBody } = previous;
    if (schemaVersion === SCHEMA_VERSION && canonicalJson(oldBody) === canonicalJson(body)) {
      return { registry: { schemaVersion, generatedAt, plugins: body.plugins, host: body.host }, changed: false };
    }
  }
  return {
    registry: { schemaVersion: SCHEMA_VERSION, generatedAt: formatTimestamp(now), plugins: body.plugins, host: body.host },
    changed: true,
  };
}

/** 原子写：同目录临时文件 + fsync + rename。 */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function loadCatalog(root) {
  return validateCatalog(readJson(path.join(root, CATALOG_FILE)), { iconsDir: path.join(root, ICONS_DIR) });
}

/**
 * 完整更新流程。全部仓库拉取并校验成功后才原子写入；任何错误抛出且不触碰现有文件。
 * @returns {{ changed: boolean, written: boolean, registry: object, text: string }}
 */
export async function runUpdate({ root, client, now = new Date(), allowRollback = false, dryRun = false, warn = () => {} }) {
  const catalog = loadCatalog(root);
  const registryFile = path.join(root, REGISTRY_FILE);
  let previous = null;
  if (fs.existsSync(registryFile)) {
    try {
      previous = validateRegistry(readJson(registryFile));
    } catch (error) {
      if (!allowRollback) throw new Error(`现有 ${REGISTRY_FILE} 无效，拒绝覆盖（请先回退到有效版本）：${error.message}`);
      warn(`现有 ${REGISTRY_FILE} 无效，按 allow_rollback 重建：${error.message}`);
    }
  }

  const body = await buildRegistryBody(catalog, { client, warn });

  const problems = findRollbacks(previous, body);
  if (problems.length) {
    if (!allowRollback) throw new Error(`检测到回滚/异常变化，拒绝写入：\n- ${problems.join('\n- ')}`);
    for (const problem of problems) warn(`allow_rollback 已允许：${problem}`);
  }

  const { registry, changed } = finalizeRegistry(previous, body, now);
  validateRegistry(registry, { catalog });
  const text = serializeRegistry(registry);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_REGISTRY_BYTES) throw new Error(`清单 ${size} 字节，超过客户端上限 ${MAX_REGISTRY_BYTES}`);
  const current = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, 'utf8') : null;
  const written = !dryRun && current !== text;
  if (written) writeFileAtomic(registryFile, text);
  return { changed, written, registry, text };
}
