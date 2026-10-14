/**
 * Catalog 平台无关校验：.canbox-app / package.json
 */

const { APP_CATEGORIES } = require('./category');

/**
 * 校验 .canbox-app 文件内容
 * @param {object|null} canboxApp
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateCanboxApp(canboxApp) {
    const errors = [];
    const warnings = [];
    if (!canboxApp) {
        return { valid: false, errors: ['.canbox-app file not found'], warnings };
    }
    if (!canboxApp.type) {
        errors.push('Missing required field: type');
    } else if (!['native', 'web', 'pwa'].includes(canboxApp.type)) {
        errors.push(`Invalid type: ${canboxApp.type}, must be native/web/pwa`);
    }
    if (canboxApp.type === 'native' && (!canboxApp.electron || !canboxApp.electron.range)) {
        errors.push('Native app requires electron.range field');
    }
    // category 可选；存在但不在 9 项枚举内时记告警，不阻断校验
    if (canboxApp.category !== undefined && canboxApp.category !== null) {
        const cat = String(canboxApp.category).trim();
        if (cat !== '' && !APP_CATEGORIES.includes(cat)) {
            warnings.push(`Invalid category: ${canboxApp.category}, must be one of: ${APP_CATEGORIES.join(', ')}`);
        }
    }
    return { valid: errors.length === 0, errors, warnings };
}

/**
 * 校验 package.json 内容
 * @param {object|null} pkg
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePackageJson(pkg) {
    const errors = [];
    if (!pkg) {
        return { valid: false, errors: ['package.json not found'] };
    }
    if (!pkg.name) errors.push('Missing required field: name');
    if (!pkg.version) errors.push('Missing required field: version');
    if (!pkg.main) errors.push('Missing required field: main');
    return { valid: errors.length === 0, errors };
}

module.exports = {
    validateCanboxApp,
    validatePackageJson
};
