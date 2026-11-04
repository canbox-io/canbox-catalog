/**
 * APP 登记：按需校验单个仓库、写入原始分片并立即组装
 *
 * 与 Verify 的区别只有三点：
 * 1. 只处理一个仓库，不做分片轮询；
 * 2. 允许没有 canbox-app topic 的仓库入库（前提是提交者是仓库 owner）；
 * 3. 已存在的条目做 upsert，而不是新增。
 *
 * 校验逻辑与 Verify 共用 app-check.js，保证两条路径产出的记录形状一致。
 *
 * 入参（均为环境变量，避免把 Issue 内容拼进 shell）：
 *   REPO_URL      仓库地址（必填）
 *   ISSUE_NUMBER  关联 Issue 编号（可选）
 *   ACTOR         提交者 GitHub 登录名（可选，Issue 事件时由 workflow 传入）
 * 输出：
 *   .register-result.json（供 workflow 生成 Issue 评论）
 */

const helpers = require('./helpers');
const { checkApp } = require('./app-check');

const PLATFORM = helpers.getPlatformArg();
const dataRepoRoot = helpers.getDataRepoRoot();
const paths = helpers.getPaths(PLATFORM, dataRepoRoot);
const ADAPTER = helpers.getPlatformAdapter(PLATFORM);

const RESULT_FILE = paths.triggerFile('register-result');

/**
 * 解析并规范化仓库地址
 * @param {string} raw
 * @returns {{owner: string, repo: string, url: string}|null}
 */
function normalizeRepoUrl(raw) {
    const trimmed = String(raw || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
    if (!match) return null;
    return {
        owner: match[1],
        repo: match[2],
        url: `${ADAPTER.siteBase}/${match[1]}/${match[2]}`
    };
}

/**
 * 写入结果文件并结束
 * @param {object} result
 * @param {number} exitCode
 */
function finish(result, exitCode = 0) {
    const payload = {
        issue: result.issue ?? null,
        actor: result.actor ?? null,
        repo: result.repo ?? null,
        appId: result.appId ?? null,
        name: result.name ?? null,
        version: result.version ?? null,
        action: result.action ?? null,
        shardId: result.shardId ?? null,
        downloadable: result.downloadable ?? null,
        expectedAsset: result.expectedAsset ?? null,
        availableAssets: result.availableAssets || [],
        warnings: result.warnings || [],
        checks: result.checks || {},
        timestamp: new Date().toISOString(),
        ...result
    };
    helpers.writeJsonFile(RESULT_FILE, payload);
    console.log(JSON.stringify(payload, null, 2));
    process.exit(exitCode);
}

function reject(reason, message, extra = {}) {
    return finish({
        ok: false,
        reason,
        message,
        closeIssue: true,
        ...extra
    }, 0);
}

async function main() {
    const issueNumber = Number.parseInt(process.env.ISSUE_NUMBER || '', 10) || null;
    const actor = (process.env.ACTOR || '').trim() || null;
    const repoInput = normalizeRepoUrl(process.env.REPO_URL);

    if (!repoInput) {
        return reject(
            'unsupported_repo_url',
            '未登记：只支持 `https://github.com/owner/repo` 形式的公开仓库，请检查仓库地址后重新提交。',
            { issue: issueNumber, actor, checks: { repo: 'invalid_url' } }
        );
    }

    // 1. 仓库可访问性 + 准入信息（topics / owner 类型）
    let accessResult;
    try {
        accessResult = await helpers.checkRepoAccess(repoInput.owner, repoInput.repo);
    } catch (err) {
        return finish({
            ok: false,
            reason: 'system_error',
            message: `登记任务未能完成：访问 GitHub API 失败（${err.message}）。请稍后重新提交，或联系维护者。`,
            closeIssue: false,
            issue: issueNumber,
            actor,
            repo: repoInput.url,
            checks: { repo: 'error' }
        }, 1);
    }

    if (accessResult.status === 'gone') {
        return reject(
            'repo_not_found',
            '未登记：仓库不存在或已被删除（404）。请确认地址后重新提交。',
            { issue: issueNumber, actor, repo: repoInput.url, checks: { repo: 'gone' } }
        );
    }
    if (accessResult.status === 'private') {
        return reject(
            'repo_private',
            '未登记：仓库为私有或无权访问（403）。请将仓库设为公开后重新提交。',
            { issue: issueNumber, actor, repo: repoInput.url, checks: { repo: 'private' } }
        );
    }

    const repoData = accessResult.repoData;
    const canonicalOwner = repoData.owner.login;
    const canonicalRepo = repoData.name;
    const canonicalUrl = repoData.html_url || `${ADAPTER.siteBase}/${canonicalOwner}/${canonicalRepo}`;
    const topics = Array.isArray(repoData.topics) ? repoData.topics : [];
    const hasTopic = topics.includes('canbox-app');
    const isOwner = !!actor && actor.toLowerCase() === canonicalOwner.toLowerCase();
    const isOrganization = repoData.owner?.type === 'Organization';

    // R4：组织仓库必须自带 topic（服务端无法核验成员身份）
    if (!hasTopic && (isOrganization || !isOwner)) {
        return reject(
            'forbidden',
            isOrganization
                ? '未登记：组织仓库必须在仓库 Settings → Topics 中添加 `canbox-app` 后才能自助登记。添加后请重新提交。'
                : '未登记：提交者不是仓库所有者，且仓库没有 `canbox-app` topic。请由仓库所有者提交，或先添加 topic 后重新提交。',
            {
                issue: issueNumber,
                actor,
                repo: canonicalUrl,
                checks: { repo: 'ok', identity: 'forbidden' }
            }
        );
    }

    // 2. 组装种子记录（已存在时保留首次发现信息与失败历史）
    const now = new Date().toISOString();
    const existing = helpers.findExistingApp(helpers.readAllApps(paths), repoData.id, canonicalUrl);
    const app = existing ? { ...existing } : {
        id: helpers.generateAppId(canonicalUrl, PLATFORM),
        githubRepoId: repoData.id,
        repo: canonicalUrl,
        createdAt: null,
        discoveredAt: now,
        status: helpers.STATUS.UNKNOWN,
        score: 100,
        consecutiveFailures: 0,
        lastCheck: now,
        repoStatus: 'active',
        repoStatusDetail: null,
        hasValidCanboxApp: false,
        hasValidPackageJson: false,
        canboxWarnings: [],
        errorHistory: [],
        stars: 0,
        forks: 0,
        lastCommitAt: null
    };

    app.repo = canonicalUrl;
    app.githubRepoId = repoData.id;
    app.origin = existing?.origin || 'submission';
    app.submission = { issue: issueNumber, by: actor, at: now };
    app.lastRegisteredAt = now;

    // 3. 与 Verify 完全相同的检查
    let checked;
    try {
        checked = await checkApp(app, PLATFORM);
    } catch (err) {
        return finish({
            ok: false,
            reason: 'system_error',
            message: `登记任务未能完成：检查仓库时出错（${err.message}）。请稍后重新提交，或联系维护者。`,
            closeIssue: false,
            issue: issueNumber,
            actor,
            repo: canonicalUrl,
            checks: { repo: 'error' }
        }, 1);
    }

    const canboxValidation = helpers.validateCanboxApp(checked._canboxApp);
    const pkgValidation = helpers.validatePackageJson(checked._pkg);

    if (checked.repoStatus !== 'active') {
        return reject(
            'repo_unavailable',
            '未登记：仓库当前不可访问。请确认仓库公开可访问后重新提交。',
            { issue: issueNumber, actor, repo: canonicalUrl, checks: { repo: checked.repoStatus } }
        );
    }
    if (!canboxValidation.valid) {
        return reject(
            'invalid_canbox_app',
            `未登记：\`.canbox-app\` 缺失或非法。\n\n${canboxValidation.errors.map(e => `- ${e}`).join('\n')}`,
            {
                issue: issueNumber,
                actor,
                repo: canonicalUrl,
                checks: { repo: 'ok', canboxApp: 'invalid', packageJson: pkgValidation.valid ? 'ok' : 'invalid' }
            }
        );
    }
    if (!pkgValidation.valid) {
        return reject(
            'invalid_package_json',
            `未登记：\`package.json\` 缺失或非法。\n\n${pkgValidation.errors.map(e => `- ${e}`).join('\n')}`,
            {
                issue: issueNumber,
                actor,
                repo: canonicalUrl,
                checks: { repo: 'ok', canboxApp: 'ok', packageJson: 'invalid' }
            }
        );
    }

    // 4. 探测当前版本的 Release 资产（只提示，不阻断收录）
    const version = checked._pkg.version;
    const identifiers = [checked._pkg.id, checked._pkg.name].filter(Boolean);
    const expectedAsset = identifiers.length ? `${identifiers[0]}-${version}.zip` : null;
    let release = { found: false, assetName: null, available: [] };
    let releaseCheckError = null;
    try {
        release = await helpers.findReleaseAsset(canonicalOwner, canonicalRepo, version, identifiers);
    } catch (err) {
        releaseCheckError = err.message;
    }

    // 5. 写入原始分片 + 立即组装
    const upsert = helpers.upsertApp(checked, paths);
    try {
        helpers.assembleCatalog(paths);
    } catch (err) {
        return finish({
            ok: false,
            reason: 'system_error',
            message: `已写入原始数据，但组装目录失败（${err.message}）。请维护者重新运行 assemble。`,
            closeIssue: false,
            issue: issueNumber,
            actor,
            repo: canonicalUrl,
            appId: checked.id,
            name: checked._pkg.name,
            version,
            action: upsert.action,
            shardId: upsert.shardId,
            checks: { repo: 'ok', canboxApp: 'ok', packageJson: 'ok' }
        }, 1);
    }

    const warnings = [...(checked.canboxWarnings || [])];
    if (releaseCheckError) {
        warnings.push(`Release 资产检查失败：${releaseCheckError}`);
    } else if (!release.found) {
        warnings.push(
            `未找到当前版本的 Release 资产：期望 \`${expectedAsset}\`（带平台后缀的 zip 不会被客户端识别）。` +
            (release.available.length ? `当前可用资产：${release.available.join(', ')}` : '')
        );
    }

    const actionText = upsert.action === 'added' ? '已收录' : '已刷新';
    const messageLines = [
        `${actionText}：\`${checked._pkg.name}\` v${version} 已写入目录（${upsert.action === 'added' ? '新增' : '原地更新'}）。`,
        '',
        `- 仓库：${canonicalUrl}`,
        `- APP ID：\`${checked.id}\``,
        `- 目录分片：\`shard-${String(upsert.shardId).padStart(3, '0')}\``,
        `- Release 资产：${release.found ? `已找到 \`${release.assetName}\`` : '未找到（目录可展示，用户下载会失败）'}`
    ];
    if (warnings.length) {
        messageLines.push('', '**注意事项**', ...warnings.map(w => `- ${w}`));
    }

    return finish({
        ok: true,
        reason: null,
        message: messageLines.join('\n'),
        closeIssue: true,
        issue: issueNumber,
        actor,
        repo: canonicalUrl,
        appId: checked.id,
        name: checked._pkg.name,
        version,
        action: upsert.action,
        shardId: upsert.shardId,
        downloadable: release.found,
        expectedAsset,
        availableAssets: release.available,
        warnings,
        checks: { repo: 'ok', canboxApp: 'ok', packageJson: 'ok' }
    }, 0);
}

main().catch(err => {
    console.error('[register] Fatal error:', err);
    finish({
        ok: false,
        reason: 'system_error',
        message: `登记任务异常结束：${err.message}`,
        closeIssue: false
    }, 1);
});
