/**
 * Gitee APP 登记：按需校验单个仓库、写入原始分片并立即组装
 *
 * Gitee 没有与 GitHub topic 等价的公开身份信号，首期采用维护者审核制：
 * 只有维护者在登记 Issue 评论 `/approve`、由 approve workflow 以
 * REVIEW_APPROVED=true 触发时才会真正写入目录。
 *
 * 入参（环境变量）：
 *   REPO_URL        仓库地址（必填）
 *   ISSUE_NUMBER    关联 Issue 编号（可选）
 *   ACTOR           提交者 GitHub 登录名（可选）
 *   REVIEW_APPROVED 维护者审核通过标记（必须为 true）
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
 * 解析并规范化 Gitee 仓库地址
 * @param {string} raw
 * @returns {{owner: string, repo: string, url: string}|null}
 */
function normalizeRepoUrl(raw) {
    const trimmed = String(raw || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = trimmed.match(/^https:\/\/gitee\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
    if (!match) return null;
    return {
        owner: match[1],
        repo: match[2],
        url: `${ADAPTER.siteBase}/${match[1]}/${match[2]}`
    };
}

function finish(result, exitCode = 0) {
    const payload = {
        ok: false,
        platform: PLATFORM,
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
    const reviewApproved = /^(true|1)$/i.test(String(process.env.REVIEW_APPROVED || '').trim());
    const repoInput = normalizeRepoUrl(process.env.REPO_URL);

    if (!reviewApproved) {
        return reject(
            'review_required',
            '未登记：Gitee 仓库需要维护者审核。请在登记 Issue 中等待维护者评论 `/approve` 后自动处理。',
            { issue: issueNumber, actor, checks: { review: 'pending' } }
        );
    }

    if (!repoInput) {
        return reject(
            'unsupported_repo_url',
            '未登记：只支持 `https://gitee.com/owner/repo` 形式的公开仓库，请检查仓库地址后重新提交。',
            { issue: issueNumber, actor, checks: { repo: 'invalid_url' } }
        );
    }

    // 1. 仓库可访问性
    let accessResult;
    try {
        accessResult = await helpers.checkRepoAccess(repoInput.owner, repoInput.repo);
    } catch (err) {
        return finish({
            ok: false,
            reason: 'system_error',
            message: `登记任务未能完成：访问 Gitee API 失败（${err.message}）。请稍后重新提交，或联系维护者。`,
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
            '未登记：仓库不存在、已删除或无权访问（404）。请确认仓库公开可访问后重新提交。',
            { issue: issueNumber, actor, repo: repoInput.url, checks: { repo: 'gone' } }
        );
    }
    if (accessResult.status === 'private') {
        return reject(
            'repo_private',
            '未登记：仓库为私有或无权访问。请将仓库设为公开后重新提交。',
            { issue: issueNumber, actor, repo: repoInput.url, checks: { repo: 'private' } }
        );
    }

    const repoData = accessResult.repoData;
    const canonicalOwner = repoData.owner?.login || repoInput.owner;
    const canonicalRepo = repoData.name || repoInput.repo;
    const canonicalUrl = repoData.html_url || `${ADAPTER.siteBase}/${canonicalOwner}/${canonicalRepo}`;

    // 2. 组装种子记录（已存在时保留首次发现信息与失败历史）
    const now = new Date().toISOString();
    const existing = helpers.findExistingApp(helpers.readAllApps(paths), repoData.id, canonicalUrl);
    const app = existing ? { ...existing } : {
        id: helpers.generateAppId(canonicalUrl, PLATFORM),
        githubRepoId: repoData.id,
        platform: PLATFORM,
        repo: canonicalUrl,
        defaultBranch: repoData.default_branch || null,
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
    app.platform = PLATFORM;
    app.githubRepoId = repoData.id;
    app.defaultBranch = repoData.default_branch || app.defaultBranch || null;
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
            { issue: issueNumber, actor, repo: checked.repo, checks: { repo: checked.repoStatus } }
        );
    }
    if (!canboxValidation.valid) {
        return reject(
            'invalid_canbox_app',
            `未登记：\`.canbox-app\` 缺失或非法。\n\n${(canboxValidation.errors || []).map(e => `- ${e}`).join('\n')}`,
            {
                issue: issueNumber,
                actor,
                repo: checked.repo,
                checks: { repo: 'ok', canboxApp: 'invalid', packageJson: pkgValidation.valid ? 'ok' : 'invalid' }
            }
        );
    }
    if (!pkgValidation.valid) {
        return reject(
            'invalid_package_json',
            `未登记：\`package.json\` 缺失或非法。\n\n${(pkgValidation.errors || []).map(e => `- ${e}`).join('\n')}`,
            {
                issue: issueNumber,
                actor,
                repo: checked.repo,
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
    // 仓库改名时 checkApp 会更新 checked.repo，这里以更新后的地址为准
    const releaseMatch = checked.repo.match(ADAPTER.hostPattern);
    const releaseOwner = releaseMatch ? releaseMatch[1] : canonicalOwner;
    const releaseRepo = releaseMatch ? releaseMatch[2] : canonicalRepo;
    try {
        release = await helpers.findReleaseAsset(releaseOwner, releaseRepo, version, identifiers);
    } catch (err) {
        releaseCheckError = err.message;
    }

    // 5. 写入原始分片 + 立即组装
    const upsert = helpers.upsertApp(checked, paths);
    try {
        helpers.assembleCatalog(paths, { sourceName: 'Gitee 社区 APP 目录' });
    } catch (err) {
        return finish({
            ok: false,
            reason: 'system_error',
            message: `登记未完成：生成目录数据时失败（${err.message}）。数据尚未提交，请稍后重新提交，或联系维护者。`,
            closeIssue: false,
            issue: issueNumber,
            actor,
            repo: checked.repo,
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
        `${actionText}：\`${checked._pkg.name}\` v${version} 已写入 Gitee 目录（${upsert.action === 'added' ? '新增' : '原地更新'}）。`,
        '',
        `- 仓库：${checked.repo}`,
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
        repo: checked.repo,
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
