# background-studio/.github

组织主页（`profile/README.md`）与 Background Studio **官方插件/壳清单**。

## 官方清单

- 地址（固定）：`https://raw.githubusercontent.com/background-studio/.github/main/registry/v1.json`
- 官方图标：`https://raw.githubusercontent.com/background-studio/.github/main/registry/icons/<id>.png`（清单里 `icon` 字段是文件名 `<id>.png`）
- 生成器：`scripts/update-registry.mjs`（逻辑在 `scripts/registry-lib.mjs`，无第三方依赖）
- 工作流：`.github/workflows/update-registry.yml`

协议 `schemaVersion: 1`：

```text
{ schemaVersion: 1, generatedAt: ISO8601(UTC),
  plugins: [ { id, displayName, owner, repo, assetPrefix, exeName, pipeName, targetHint, icon,
               releases: { stable: Release|null, prerelease: Release|null } } ],
  host: { stable: Release|null, prerelease: Release|null } }
Release = { version, tag, assetName, downloadUrl, releaseUrl, sha256: 64位小写hex | null }
```

选版规则（每个仓库、每个通道独立）：

- 过滤 draft；tag 必须是 `v<semver>`，且 GitHub `prerelease` 标志必须与版本号是否带预发布段一致，否则跳过并告警。
- `stable` / `prerelease` 各取 **semver 最高** 且带精确匹配资产的版本（不按发布时间）：插件 `<assetPrefix><version>-plugin.zip`，壳 `Background.Studio_<version>_x64-setup.exe`；资产须为 `uploaded`，URL 精确为 `https://github.com/background-studio/<repo>/releases/download/<tag>/<asset>` 与 `.../releases/tag/<tag>`。
- 两个通道互相独立，`prerelease` 可能低于 `stable`；如何使用由客户端决定（当前客户端：beta 通道只取 `prerelease`，壳只用 `host.stable`）。
- `sha256` 优先取 GitHub 资产 `digest`（不额外请求）；没有时下载同 Release 的 `<asset>.sha256` 侧车（校验文件名，侧车有 digest 时再校验侧车本身）；两者都没有的**旧资产记为 `null`**（较早上传的资产可能没有 GitHub digest），客户端应视为"无法校验"。绝不推算或伪造 hash；侧车下载失败或格式不符会让整次生成失败。
- 只扫描每个仓库最近 500 个 Release（100/页 × 5 页）。

## 维护

插件列表**唯一来源**是 `catalog/plugins.json`（字段与壳 `src-tauri/resources/catalog.json` 的 PluginDef 相同，`icon` 必须为 `<id>.png`）。新增插件：

1. 在 `catalog/plugins.json` 追加条目（`owner` 必须是 `background-studio`，`id` 不能是 `console`/`host`）。
2. 把 PNG 图标（≤2 MiB）放到 `registry/icons/<id>.png`。
3. 提交后在 Actions 手动运行 **Update registry**（或等下一次定时）。

`registry/v1.json` 由工作流生成，**不要手改**。本地检查：

```sh
node --test "scripts/test/*.test.mjs"
node scripts/update-registry.mjs --validate          # 离线校验现有文件；catalog 待重新生成时只告警
node scripts/update-registry.mjs --validate --strict # 同上，但要求清单与 catalog 完全同步
GITHUB_TOKEN=... node scripts/update-registry.mjs --dry-run   # 不写文件，打印结果
```

CI：

- `.github/workflows/validate.yml`：每次 push / PR 运行（权限 `contents: read`，不使用令牌、不访问 API），跑测试和 `--validate`。修改 catalog 的 PR 不需要附带重新生成的清单，合并后由 Update registry 生成。
- `.github/workflows/update-registry.yml`：每次尝试（包括 push 冲突后 reset 到最新 `main` 的重试）都先跑测试，再生成，生成后执行 `--validate --strict`。

安全约束：

- 任一仓库请求失败（网络、5xx 重试后仍失败、403/429 限流、404）、响应形状异常或校验失败，脚本非零退出且**不改动**现有文件；全部成功后才校验并原子写入（临时文件 + rename）。
- 回滚保护：与现有清单相比，某通道版本降低、变为 `null`、或同版本 tag/资产/URL/非空 sha256 改变，都会拒绝写入。确实删除/撤回了 Release 时，手动运行工作流并勾选 `allow_rollback`。
- 输出键序固定；内容未变化时保留原 `generatedAt`，不产生提交。
- 工作流只提交 `registry/v1.json`；`concurrency` 串行执行；push 被拒时基于最新 `main` 重新生成，最多 3 次，**不使用 force push**。

## 时效

- 定时每小时一次（`7 * * * *`）；GitHub 定时任务可能延迟，高峰时延迟数十分钟。
- raw.githubusercontent.com 有约 5 分钟 CDN 缓存。正常情况下新 Release 在约 1 小时内出现在清单里。
- 需要立即生效：在 Actions 手动运行，或由发布流水线发送 `repository_dispatch`（类型 `refresh-registry`）：

  ```sh
  gh api repos/background-studio/.github/dispatches -f event_type=refresh-registry
  ```

  调用方需要对本仓库有 `contents: write` 的令牌（各插件仓库自带的 `GITHUB_TOKEN` 无权触发其他仓库，需要单独的 PAT/App 令牌；不配置也只是等待定时任务）。
- 公开仓库 60 天无活动时 GitHub 会自动停用定时工作流；若长期无新版本，需要在 Actions 页面重新启用。

## 令牌边界

- 只有本仓库的 GitHub Actions 使用自动注入的 `GITHUB_TOKEN`（权限 `contents: write`，仅用于读取公开仓库 Releases API 和提交 `registry/v1.json`）。令牌只发往 `api.github.com`，下载侧车不带令牌，日志不输出令牌。
- 所有白名单仓库必须是公开仓库（`GITHUB_TOKEN` 无法读取组织内其他私有仓库）。
- 对**官方组件**（本清单列出的官方插件与壳本身），客户端（Background Studio 壳）检查更新时**不访问 GitHub API、不需要登录 gh**，只读取上述静态 JSON 和图标，并按 `sha256` 校验下载。
- 用户在本地 catalog 中自行添加的**自定义/第三方插件**不在本清单内，客户端仍按原方式通过 GitHub API 查询其 Release（可能受匿名限流影响，可登录 gh 提升额度）。
- 测试只用模拟数据，不含任何真实令牌。
