/**
 * Catalog 平台无关评分、状态机、过滤与错误历史
 */

const { STATUS, CATALOG_FILTER } = require('./constants');

/**
 * 计算风险评分（0-100，越低风险越高）
 * @param {object} app
 * @returns {number}
 */
function calculateRiskScore(app) {
    let score = 100;

    // 仓库可访问性
    if (app.repoStatus === 'gone') score -= 40;
    if (app.repoStatus === 'private') score -= 30;

    // .canbox-app 校验
    if (!app.hasValidCanboxApp) score -= 20;

    // package.json 校验
    if (!app.hasValidPackageJson) score -= 10;

    // 长期未更新
    if (app.lastCommitAt == null) {
        score -= 10;
    } else {
        const daysSinceUpdate = (Date.now() - new Date(app.lastCommitAt).getTime()) / 86400000;
        if (daysSinceUpdate > 180) score -= 10;
    }

    // 累计失败次数
    score -= Math.min(app.consecutiveFailures * 2, 20);

    return Math.max(0, Math.min(100, score));
}

/**
 * 根据状态和评分计算风险等级
 * @param {string} status
 * @param {number} score
 * @returns {string}
 */
function calculateRiskLevel(status, score) {
    if (status === STATUS.CRITICAL) return 'critical';
    if (status === STATUS.WARNING) return 'medium';
    if (score < 50) return 'high';
    if (score < 80) return 'low';
    return 'none';
}

/**
 * 判断是否显示下载按钮
 * @param {string} status
 * @returns {boolean}
 */
function shouldShowDownload(status) {
    return status === STATUS.ACTIVE || status === STATUS.WARNING;
}

/**
 * 根据检查结果更新 APP 状态
 * @param {object} app - 当前 APP 数据
 * @param {boolean} checkSuccess - 本次检查是否成功
 * @returns {object} { status, consecutiveFailures }
 */
function updateAppStatus(app, checkSuccess) {
    let { status, consecutiveFailures } = app;

    if (checkSuccess) {
        consecutiveFailures = 0;
        if (status === STATUS.WARNING || status === STATUS.UNKNOWN) {
            status = STATUS.ACTIVE;
        }
        // critical 状态恢复需要连续成功（简化：一次成功即恢复为 active）
        if (status === STATUS.CRITICAL) {
            status = STATUS.ACTIVE;
        }
    } else {
        consecutiveFailures = (consecutiveFailures || 0) + 1;
        if (consecutiveFailures >= 5) {
            status = STATUS.CRITICAL;
        } else if (consecutiveFailures >= 3) {
            status = STATUS.WARNING;
        }
    }

    return { status, consecutiveFailures };
}

/**
 * 检查 stale/removed 状态转换
 * @param {object} app
 * @returns {string} 更新后的状态
 */
function checkStaleTransition(app) {
    if (app.status !== STATUS.CRITICAL) return app.status;

    const lastCheck = app.lastCheck ? new Date(app.lastCheck) : null;
    if (!lastCheck) return app.status;

    const daysSinceCheck = (Date.now() - lastCheck.getTime()) / 86400000;
    // critical 超过 30 天 → stale
    if (daysSinceCheck > 30) {
        // stale 超过 365 天 → removed（从 lastCheck 开始算）
        if (daysSinceCheck > 365) {
            return STATUS.REMOVED;
        }
        return STATUS.STALE;
    }

    return app.status;
}

/**
 * 过滤 APP 用于 catalog 展示
 * @param {Array} apps - 所有 APP
 * @returns {Array} 过滤后的 APP
 */
function filterAppsForCatalog(apps) {
    return apps.filter(app => {
        if (CATALOG_FILTER.excludeStatus.includes(app.status)) return false;
        if (!CATALOG_FILTER.includeStatus.includes(app.status)) return false;
        if (app.score < CATALOG_FILTER.includeMinScore) return false;
        return true;
    });
}

/**
 * 添加错误记录
 * @param {object} app
 * @param {string} action - discover / verify / reconcile
 * @param {string} error - 错误描述
 * @param {number|null} statusCode - HTTP 状态码
 * @returns {object} 更新后的 errorHistory
 */
function addErrorRecord(app, action, error, statusCode = null) {
    const history = app.errorHistory || [];
    history.push({
        timestamp: new Date().toISOString(),
        action,
        error,
        statusCode
    });
    // 只保留最近 20 条
    if (history.length > 20) {
        return history.slice(-20);
    }
    return history;
}

module.exports = {
    calculateRiskScore,
    calculateRiskLevel,
    shouldShowDownload,
    updateAppStatus,
    checkStaleTransition,
    filterAppsForCatalog,
    addErrorRecord
};
