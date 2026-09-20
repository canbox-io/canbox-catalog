/**
 * Catalog 平台无关校验：.canbox-app / package.json
 */

/**
 * 校验 .canbox-app 文件内容
 * @param {object|null} canboxApp
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateCanboxApp(canboxApp) {
    const errors = [];
    if (!canboxApp) {
        return { valid: false, errors: ['.canbox-app file not found'] };
    }
    if (!canboxApp.type) {
        errors.push('Missing required field: type');
    } else if (!['native', 'web', 'pwa'].includes(canboxApp.type)) {
        errors.push(`Invalid type: ${canboxApp.type}, must be native/web/pwa`);
    }
    if (canboxApp.type === 'native' && (!canboxApp.electron || !canboxApp.electron.range)) {
        errors.push('Native app requires electron.range field');
    }
    return { valid: errors.length === 0, errors };
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
