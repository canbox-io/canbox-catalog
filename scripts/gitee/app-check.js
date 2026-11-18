/**
 * Gitee 平台 APP 检查（复用平台无关实现）
 */

const helpers = require('./helpers');
const { createCheckApp } = require('../common/app-check');

const checkApp = createCheckApp(helpers);

module.exports = {
    checkApp
};
