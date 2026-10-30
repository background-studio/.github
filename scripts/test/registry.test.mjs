// 运行：node --test scripts/test/
// 只用 Node 内置模块；fixture 模拟 GitHub Releases API 的真实字段形状，不含任何真实令牌。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_FILE,
  compareSemver,
  createGitHubClient,
  diffCatalog,
  findRollbacks,
  finalizeRegistry,
  hostAssetName,
  loadCatalog,
  parseSidecar,
  resolveSha256,
  runUpdate,
  selectChannels,
  serializeRegistry,
  validateCatalog,
  validateRegistry,
} from '../registry-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_TOKEN = 'test-token-not-a-secret';
const OWNER = 'background-studio';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

let nextId = 1000;
function asset(repo, tag, name, { digest = null, state = 'uploaded', size = 123456 } = {}) {
  const id = nextId++;
  return {
    url: `https://api.github.com/repos/${OWNER}/${repo}/releases/assets/${id}`,
    id,
    node_id: `RA_${id}`,
    name,
    label: '',
    uploader: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
    content_type: 'application/zip',
    state,
    size,
    digest,
    download_count: 3,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    browser_download_url: `https://github.com/${OWNER}/${repo}/releases/download/${tag}/${name}`,
  };
}

function release(repo, tag, { prerelease = false, draft = false, assets = [] } = {}) {
  const id = nextId++;
  return {
    url: `https://api.github.com/repos/${OWNER}/${repo}/releases/${id}`,
    html_url: `https://github.com/${OWNER}/${repo}/releases/tag/${tag}`,
    assets_url: `https://api.github.com/repos/${OWNER}/${repo}/releases/${id}/assets`,
    id,
    node_id: `RE_${id}`,
    tag_name: tag,
    target_commitish: 'main',
    name: tag,
    draft,
    prerelease,
    immutable: false,
    created_at: '2026-10-01T00:00:00Z',
    published_at: draft ? null : '2026-10-01T00:00:00Z',
    author: { login: 'someone', id: 1, type: 'User' },
    assets: assets.map((a) => (typeof a === 'function' ? a(tag) : a)),
    tarball_url: `https://api.github.com/repos/${OWNER}/${repo}/tarball/${tag}`,
    zipball_url: `https://api.github.com/repos/${OWNER}/${repo}/zipball/${tag}`,
    body: '',
  };
}

const CODEX = {
  id: 'codex',
  displayName: 'Codex Background Studio',
  owner: OWNER,
  repo: 'codex_desktop_background',
  assetPrefix: 'CodexBackgroundStudio-',
  exeName: 'Codex Background Studio.exe',
  pipeName: '\\\\.\\pipe\\background-studio-codex',
  targetHint: 'OpenAI Codex 桌面应用',
  icon: 'codex.png',
};

function pluginRelease(tag, opts = {}) {
  const version = tag.slice(1);
  const name = `CodexBackgroundStudio-${version}-plugin.zip`;
  return release(CODEX.repo, tag, {
    prerelease: opts.prerelease ?? version.includes('-'),
    draft: opts.draft,
    assets: opts.assets ?? [asset(CODEX.repo, tag, name, { digest: 'digest' in opts ? opts.digest : `sha256:${HEX_A}` })],
  });
}

function hostRelease(tag, opts = {}) {
  const version = tag.slice(1);
  return release('background-studio', tag, {
    prerelease: version.includes('-'),
    assets: [asset('background-studio', tag, hostAssetName(version), { digest: opts.digest ?? `sha256:${HEX_B}` })],
  });
}

const selectOpts = (warnings = []) => ({
  owner: OWNER,
  repo: CODEX.repo,
  assetNameFor: (v) => `CodexBackgroundStudio-${v}-plugin.zip`,
  label: 'codex',
  warn: (m) => warnings.push(m),
});

describe('semver', () => {
  test('按 semver 2.0 排序', () => {
    assert.equal(compareSemver('0.3.10', '0.3.9'), 1);
    assert.equal(compareSemver('0.5.4', '0.5.4-beta.1'), 1);
    assert.equal(compareSemver('0.5.4-beta.10', '0.5.4-beta.2'), 1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(compareSemver('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1);
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    assert.throws(() => compareSemver('v1.2.3', '1.2.3'));
  });
});

describe('selectChannels', () => {
  test('各通道取 semver 最高而非列表顺序，跳过 draft 和缺资产版本', () => {
    const warnings = [];
    const releases = [
      pluginRelease('v0.6.4'), // 创建时间更晚但版本更低
      pluginRelease('v0.7.0', { draft: true }),
      pluginRelease('v0.6.6', { assets: [] }),
      pluginRelease('v0.6.5'),
      pluginRelease('v0.6.6-beta.1'),
      pluginRelease('v0.6.5-beta.2'),
      pluginRelease('v0.6.10-beta.1', { assets: [asset(CODEX.repo, 'v0.6.10-beta.1', 'CodexBackgroundStudio-0.6.10-beta.1-plugin.zip', { state: 'starter' })] }),
    ];
    const { stable, prerelease } = selectChannels(releases, selectOpts(warnings));
    assert.equal(stable.version, '0.6.5');
    assert.equal(prerelease.version, '0.6.6-beta.1');
    assert.ok(warnings.some((w) => w.includes('v0.6.6') && w.includes('没有唯一')));
    assert.ok(warnings.some((w) => w.includes('v0.6.10-beta.1') && w.includes('starter')));
  });

  test('prerelease 标志与版本号不一致、无 v 前缀的 tag 被跳过', () => {
    const warnings = [];
    const releases = [
      pluginRelease('v0.1.5'),
      pluginRelease('v0.1.9', { prerelease: true }),
      release(CODEX.repo, '0.2.0', { assets: [asset(CODEX.repo, '0.2.0', 'CodexBackgroundStudio-0.2.0-plugin.zip')] }),
    ];
    const { stable, prerelease } = selectChannels(releases, selectOpts(warnings));
    assert.equal(stable.version, '0.1.5');
    assert.equal(prerelease, null);
    assert.equal(warnings.length, 2);
  });

  test('资产名必须精确匹配版本，下载地址必须指向本仓库', () => {
    const tag = 'v0.6.5';
    const wrongName = pluginRelease(tag, { assets: [asset(CODEX.repo, tag, 'CodexBackgroundStudio-0.6.4-plugin.zip')] });
    assert.equal(selectChannels([wrongName], selectOpts()).stable, null);
    const evil = asset(CODEX.repo, tag, 'CodexBackgroundStudio-0.6.5-plugin.zip');
    evil.browser_download_url = 'https://evil.example/CodexBackgroundStudio-0.6.5-plugin.zip';
    assert.equal(selectChannels([pluginRelease(tag, { assets: [evil] })], selectOpts()).stable, null);
  });

  test('同版本多个 Release 拒绝猜测；API 形状异常直接报错', () => {
    assert.throws(() => selectChannels([pluginRelease('v1.0.0'), pluginRelease('v1.0.0')], selectOpts()), /多个 Release/);
    const broken = pluginRelease('v1.0.0');
    delete broken.assets;
    assert.throws(() => selectChannels([broken], selectOpts()), /assets/);
    assert.throws(() => selectChannels({ message: 'Not Found' }, selectOpts()), /不是数组/);
  });
});

describe('sha256', () => {
  const noDownload = async () => {
    throw new Error('不应下载');
  };
  const ctx = (downloadText, warnings = []) => ({ owner: OWNER, repo: CODEX.repo, downloadText, label: 'codex', warn: (m) => warnings.push(m) });

  test('优先使用 asset.digest，不额外请求', async () => {
    const picked = selectChannels([pluginRelease('v1.0.0', { digest: `sha256:${HEX_C.toUpperCase()}` })], selectOpts()).stable;
    assert.equal(await resolveSha256(picked, ctx(noDownload)), HEX_C);
  });

  test('无 digest 时下载侧车并校验文件名与侧车自身 digest', async () => {
    const tag = 'v1.0.0';
    const name = 'CodexBackgroundStudio-1.0.0-plugin.zip';
    const text = `${HEX_B}  ${name}\n`;
    const sidecarDigest = createHash('sha256').update(text).digest('hex');
    const rel = pluginRelease(tag, {
      assets: [asset(CODEX.repo, tag, name), asset(CODEX.repo, tag, `${name}.sha256`, { size: text.length, digest: `sha256:${sidecarDigest}` })],
    });
    const picked = selectChannels([rel], selectOpts()).stable;
    const urls = [];
    const download = async (url) => {
      urls.push(url);
      return Buffer.from(text);
    };
    assert.equal(await resolveSha256(picked, ctx(download)), HEX_B);
    assert.deepEqual(urls, [`https://github.com/${OWNER}/${CODEX.repo}/releases/download/${tag}/${name}.sha256`]);

    await assert.rejects(resolveSha256(picked, ctx(async () => Buffer.from(`${HEX_A}  ${name}\n`))), /digest 不一致/);
  });

  test('侧车下载失败或内容不符时报错，绝不伪造', async () => {
    const tag = 'v1.0.0';
    const name = 'CodexBackgroundStudio-1.0.0-plugin.zip';
    const rel = pluginRelease(tag, { assets: [asset(CODEX.repo, tag, name), asset(CODEX.repo, tag, `${name}.sha256`, { size: 90 })] });
    const picked = selectChannels([rel], selectOpts()).stable;
    await assert.rejects(resolveSha256(picked, ctx(async () => {
      throw new Error('ECONNRESET');
    })), /ECONNRESET/);
    await assert.rejects(resolveSha256(picked, ctx(async () => Buffer.from(`${HEX_A}  other.zip\n`))), /不一致/);
    await assert.rejects(resolveSha256(picked, ctx(async () => Buffer.from('not-a-hash\n'))), /格式无效/);
  });

  test('旧资产既无 digest 也无侧车时为 null 并告警；畸形 digest 报错', async () => {
    const warnings = [];
    const old = selectChannels([pluginRelease('v0.1.0', { digest: null })], selectOpts()).stable;
    assert.equal(await resolveSha256(old, ctx(noDownload, warnings)), null);
    assert.equal(warnings.length, 1);
    const bad = selectChannels([pluginRelease('v0.1.0', { digest: 'sha256:1234' })], selectOpts()).stable;
    await assert.rejects(resolveSha256(bad, ctx(noDownload)), /不是合法 sha256/);
  });

  test('parseSidecar 支持纯 hash 与 sha256sum 二进制标记', () => {
    assert.equal(parseSidecar(`${HEX_A.toUpperCase()}\r\n`, 'x.zip'), HEX_A);
    assert.equal(parseSidecar(`${HEX_A} *x.zip`, 'x.zip'), HEX_A);
    assert.throws(() => parseSidecar(`${HEX_A}\n${HEX_B}\n`, 'x.zip'), /一行/);
  });
});

describe('GitHub 客户端', () => {
  function mockFetch(routes) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const route = routes[url];
      if (!route) throw new Error(`unexpected ${url}`);
      const step = Array.isArray(route) ? route.shift() : route;
      if (step instanceof Error) throw step;
      return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), {
        status: step.status ?? 200,
        headers: step.headers ?? {},
      });
    };
    return { impl, calls };
  }
  const base = 'https://api.github.com/repos/background-studio/codex_desktop_background/releases';

  test('跟随 Link 分页，令牌只发往 API 主机', async () => {
    const { impl, calls } = mockFetch({
      [`${base}?per_page=100`]: { body: [pluginRelease('v1.0.0')], headers: { link: `<${base}?per_page=100&page=2>; rel="next", <${base}?per_page=100&page=2>; rel="last"` } },
      [`${base}?per_page=100&page=2`]: { body: [pluginRelease('v0.9.0')] },
      'https://github.com/x/y/releases/download/v1/a.sha256': { body: HEX_A },
    });
    const client = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: impl, sleep: async () => {} });
    const all = await client.listReleases(OWNER, 'codex_desktop_background');
    assert.equal(all.length, 2);
    assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${FAKE_TOKEN}`));
    await client.downloadText('https://github.com/x/y/releases/download/v1/a.sha256', 4096);
    assert.equal(calls.at(-1).headers.Authorization, undefined);
  });

  test('分页数量受限，异常主机的 next 链接被拒绝', async () => {
    const pages = {};
    for (let i = 1; i <= 3; i += 1) {
      pages[i === 1 ? `${base}?per_page=100` : `${base}?per_page=100&page=${i}`] = {
        body: [],
        headers: { link: `<${base}?per_page=100&page=${i + 1}>; rel="next"` },
      };
    }
    const warnings = [];
    const client = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: mockFetch(pages).impl, maxPages: 2, warn: (m) => warnings.push(m) });
    await client.listReleases(OWNER, 'codex_desktop_background');
    assert.equal(warnings.length, 1);

    const evil = createGitHubClient({
      token: FAKE_TOKEN,
      fetchImpl: mockFetch({ [`${base}?per_page=100`]: { body: [], headers: { link: '<https://evil.example/next>; rel="next"' } } }).impl,
    });
    await assert.rejects(evil.listReleases(OWNER, 'codex_desktop_background'), /主机异常/);
  });

  test('5xx/网络错误重试后仍失败则抛错；4xx 不重试', async () => {
    const flaky = mockFetch({ [`${base}?per_page=100`]: [new TypeError('fetch failed'), { status: 502, body: '' }, { body: [] }] });
    const ok = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: flaky.impl, sleep: async () => {} });
    assert.deepEqual(await ok.listReleases(OWNER, 'codex_desktop_background'), []);

    const down = mockFetch({ [`${base}?per_page=100`]: { status: 503, body: { message: 'Service Unavailable' } } });
    const client = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: down.impl, sleep: async () => {} });
    await assert.rejects(client.listReleases(OWNER, 'codex_desktop_background'), /HTTP 503/);
    assert.equal(down.calls.length, 3);

    const limited = mockFetch({ [`${base}?per_page=100`]: { status: 403, body: { message: 'API rate limit exceeded' } } });
    const c2 = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: limited.impl, sleep: async () => {} });
    await assert.rejects(c2.listReleases(OWNER, 'codex_desktop_background'), /403.*rate limit/);
    assert.equal(limited.calls.length, 1);
    assert.ok(!String(limited.calls[0]).includes(FAKE_TOKEN));
  });

  test('缺少令牌直接失败', () => {
    assert.throws(() => createGitHubClient({ token: '' }), /GITHUB_TOKEN/);
  });
});

describe('runUpdate', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-registry-'));
    fs.mkdirSync(path.join(root, 'catalog'));
    fs.mkdirSync(path.join(root, 'registry', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'catalog', 'plugins.json'), JSON.stringify({ pluginProtocol: 1, plugins: [CODEX] }));
    fs.writeFileSync(path.join(root, 'registry', 'icons', 'codex.png'), PNG);
    return root;
  }
  function fakeClient(map) {
    return {
      listReleases: async (owner, repo) => {
        const value = map[repo];
        if (value instanceof Error) throw value;
        return value;
      },
      downloadText: async () => {
        throw new Error('不应下载');
      },
    };
  }
  const t1 = new Date('2026-11-01T00:00:00.123Z');
  const t2 = new Date('2026-11-01T01:00:00Z');

  test('生成合法清单；无变化时保留 generatedAt 且不重写', async (t) => {
    const root = makeRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const client = fakeClient({
      codex_desktop_background: [pluginRelease('v0.6.5'), pluginRelease('v0.6.6-beta.1')],
      'background-studio': [hostRelease('v0.3.6'), hostRelease('v0.3.6-beta.2')],
    });
    const first = await runUpdate({ root, client, now: t1 });
    assert.equal(first.written, true);
    const file = path.join(root, REGISTRY_FILE);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.generatedAt, '2026-11-01T00:00:00Z');
    assert.deepEqual(saved.plugins[0].releases.stable, {
      version: '0.6.5',
      tag: 'v0.6.5',
      assetName: 'CodexBackgroundStudio-0.6.5-plugin.zip',
      downloadUrl: 'https://github.com/background-studio/codex_desktop_background/releases/download/v0.6.5/CodexBackgroundStudio-0.6.5-plugin.zip',
      releaseUrl: 'https://github.com/background-studio/codex_desktop_background/releases/tag/v0.6.5',
      sha256: HEX_A,
    });
    assert.equal(saved.plugins[0].icon, 'codex.png');
    assert.equal(saved.host.stable.assetName, 'Background.Studio_0.3.6_x64-setup.exe');
    assert.deepEqual(Object.keys(saved), ['schemaVersion', 'generatedAt', 'plugins', 'host']);

    const second = await runUpdate({ root, client, now: t2 });
    assert.equal(second.changed, false);
    assert.equal(second.written, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).generatedAt, '2026-11-01T00:00:00Z');

    const bumped = fakeClient({
      codex_desktop_background: [pluginRelease('v0.6.6'), pluginRelease('v0.6.5'), pluginRelease('v0.6.6-beta.1')],
      'background-studio': [hostRelease('v0.3.6'), hostRelease('v0.3.6-beta.2')],
    });
    const third = await runUpdate({ root, client: bumped, now: t2 });
    assert.equal(third.written, true);
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.generatedAt, '2026-11-01T01:00:00Z');
    assert.equal(updated.plugins[0].releases.stable.version, '0.6.6');
  });

  test('任何仓库网络错误都不写文件、不清空旧清单', async (t) => {
    const root = makeRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, REGISTRY_FILE);
    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: [], 'background-studio': new Error('HTTP 502') }), now: t1 }),
      /502/,
    );
    assert.equal(fs.existsSync(file), false);

    await runUpdate({ root, client: fakeClient({ codex_desktop_background: [pluginRelease('v0.6.5')], 'background-studio': [hostRelease('v0.3.6')] }), now: t1 });
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: new Error('fetch failed'), 'background-studio': [hostRelease('v0.3.6')] }), now: t2 }),
      /fetch failed/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['icons', 'v1.json']);
  });

  test('版本回退、通道消失、同版本 hash 改变被拒绝；allowRollback 可显式放行', async (t) => {
    const root = makeRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, REGISTRY_FILE);
    const host = [hostRelease('v0.3.6')];
    await runUpdate({ root, client: fakeClient({ codex_desktop_background: [pluginRelease('v0.6.5'), pluginRelease('v0.6.6-beta.1')], 'background-studio': host }), now: t1 });
    const before = fs.readFileSync(file, 'utf8');

    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: [pluginRelease('v0.6.4'), pluginRelease('v0.6.6-beta.1')], 'background-studio': host }), now: t2 }),
      /0\.6\.5 回退到 0\.6\.4/,
    );
    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: [], 'background-studio': host }), now: t2 }),
      /消失/,
    );
    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: [pluginRelease('v0.6.5', { digest: `sha256:${HEX_C}` }), pluginRelease('v0.6.6-beta.1')], 'background-studio': host }), now: t2 }),
      /sha256 改变/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    const forced = await runUpdate({
      root,
      client: fakeClient({ codex_desktop_background: [pluginRelease('v0.6.4')], 'background-studio': host }),
      now: t2,
      allowRollback: true,
    });
    assert.equal(forced.written, true);
    assert.equal(forced.registry.plugins[0].releases.prerelease, null);
  });

  test('现有清单损坏时拒绝覆盖', async (t) => {
    const root = makeRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, REGISTRY_FILE), '{"schemaVersion":1,"plugins":[]}');
    await assert.rejects(
      runUpdate({ root, client: fakeClient({ codex_desktop_background: [], 'background-studio': [] }), now: t1 }),
      /拒绝覆盖/,
    );
  });
});

describe('校验', () => {
  const goodRelease = {
    version: '0.6.5',
    tag: 'v0.6.5',
    assetName: 'CodexBackgroundStudio-0.6.5-plugin.zip',
    downloadUrl: 'https://github.com/background-studio/codex_desktop_background/releases/download/v0.6.5/CodexBackgroundStudio-0.6.5-plugin.zip',
    releaseUrl: 'https://github.com/background-studio/codex_desktop_background/releases/tag/v0.6.5',
    sha256: HEX_A,
  };
  const make = (overrides = {}) => ({
    schemaVersion: 1,
    generatedAt: '2026-11-01T00:00:00Z',
    plugins: [{ ...CODEX, releases: { stable: { ...goodRelease, ...overrides }, prerelease: null } }],
    host: { stable: null, prerelease: null },
  });

  test('合法清单通过，字段错误被拒绝', () => {
    validateRegistry(make());
    assert.throws(() => validateRegistry(make({ sha256: 'sha256:' + HEX_A })), /sha256/);
    assert.throws(() => validateRegistry(make({ sha256: HEX_A.toUpperCase() })), /sha256/);
    assert.throws(() => validateRegistry(make({ tag: '0.6.5' })), /tag/);
    assert.throws(() => validateRegistry(make({ extra: 1 })), /字段必须恰好/);
    assert.throws(() => validateRegistry(make({ downloadUrl: goodRelease.downloadUrl.replace('github.com', 'evil.example') })), /downloadUrl/);
    assert.throws(() => validateRegistry(make({ version: '0.6.6-beta.1', tag: 'v0.6.6-beta.1', assetName: 'CodexBackgroundStudio-0.6.6-beta.1-plugin.zip' })), /通道/);
    const missingChannel = make();
    delete missingChannel.plugins[0].releases.prerelease;
    assert.throws(() => validateRegistry(missingChannel), /stable, prerelease|prerelease, stable/);
    const badTime = make();
    badTime.generatedAt = '2026-11-01 00:00:00';
    assert.throws(() => validateRegistry(badTime), /generatedAt/);
  });

  test('catalog 校验保留 id、owner 白名单、pipe 格式', () => {
    const wrap = (def) => ({ pluginProtocol: 1, plugins: [{ ...CODEX, ...def }] });
    validateCatalog(wrap({}));
    assert.throws(() => validateCatalog(wrap({ id: 'host', icon: 'host.png' })), /保留名/);
    assert.throws(() => validateCatalog(wrap({ owner: 'someone-else' })), /白名单/);
    assert.throws(() => validateCatalog(wrap({ pipeName: 'pipe' })), /pipeName/);
    assert.throws(() => validateCatalog(wrap({ exeName: '..\\evil.exe' })), /exeName/);
    assert.throws(() => validateCatalog({ pluginProtocol: 1, plugins: [CODEX, { ...CODEX }] }), /重复/);
  });

  test('仓库内 catalog/plugins.json 与图标有效，现有 registry/v1.json（若有）结构有效且为稳定输出', (t) => {
    // 不硬编码插件列表：以 catalog 为唯一来源。
    const catalog = loadCatalog(repoRoot);
    const file = path.join(repoRoot, REGISTRY_FILE);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const registry = validateRegistry(JSON.parse(text));
      assert.equal(serializeRegistry(registry), text, 'registry/v1.json 必须是生成器的稳定输出');
      // 与 catalog 比对：catalog 刚修改、工作流尚未重新生成时只报告差异，不让测试失败
      // （否则定时工作流会卡在测试步骤，永远无法重新生成）。严格同步由生成后的校验保证。
      const diffs = diffCatalog(registry, catalog);
      for (const diff of diffs) t.diagnostic(`待重新生成：${diff}`);
      if (diffs.length === 0) validateRegistry(registry, { catalog });
    }
  });

  test('diffCatalog 报告新增、移除、字段变化与顺序', () => {
    const NOTION = { ...CODEX, id: 'notion', repo: 'notion_desktop_background', assetPrefix: 'NotionBackgroundStudio-', icon: 'notion.png' };
    const registry = make();
    assert.deepEqual(diffCatalog(registry, { pluginProtocol: 1, plugins: [CODEX] }), []);
    const added = diffCatalog(registry, { pluginProtocol: 1, plugins: [CODEX, NOTION] });
    assert.ok(added.some((d) => d.startsWith('notion: catalog 新增')));
    const removed = diffCatalog(registry, { pluginProtocol: 1, plugins: [NOTION] });
    assert.ok(removed.some((d) => d.startsWith('codex: 已从 catalog 移除')));
    const changed = diffCatalog(registry, { pluginProtocol: 1, plugins: [{ ...CODEX, displayName: 'X' }] });
    assert.ok(changed.some((d) => d.startsWith('codex.displayName')));
    const two = make();
    two.plugins.push({ ...NOTION, releases: { stable: null, prerelease: null } });
    assert.ok(diffCatalog(two, { pluginProtocol: 1, plugins: [NOTION, CODEX] }).includes('插件顺序与 catalog 不一致'));
    assert.throws(() => validateRegistry(two, { catalog: { pluginProtocol: 1, plugins: [NOTION, CODEX] } }), /顺序/);
  });

  test('findRollbacks / finalizeRegistry 基本语义', () => {
    const prev = make();
    const { schemaVersion, generatedAt, ...body } = prev;
    assert.deepEqual(findRollbacks(prev, body), []);
    assert.equal(finalizeRegistry(prev, structuredClone(body), new Date()).registry.generatedAt, generatedAt);
    const nullSha = make({ sha256: null });
    const { schemaVersion: _s, generatedAt: _g, ...withSha } = make();
    assert.deepEqual(findRollbacks(nullSha, withSha), [], 'null -> hash 是补全，不算回滚');
  });
});
