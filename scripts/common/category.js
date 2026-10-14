/**
 * canbox-catalog/scripts/common/category.js — APP 分类枚举与归一化（本地副本）
 *
 * 枚举值与 canbox-core/lib/category.js 的 APP_CATEGORIES 必须完全一致。
 * canbox-catalog 不依赖 canbox-core，故在此复制一份。
 */
const APP_CATEGORIES = [
    'development',
    'utility',
    'office',
    'network',
    'audio',
    'video',
    'game',
    'graphics',
    'education'
];

const CATEGORY_OTHER = 'other';
const VALID_CATEGORY_SET = new Set(APP_CATEGORIES);

function normalizeCategory(value) {
    if (typeof value !== 'string') return CATEGORY_OTHER;
    const trimmed = value.trim();
    if (VALID_CATEGORY_SET.has(trimmed)) return trimmed;
    return CATEGORY_OTHER;
}

module.exports = { APP_CATEGORIES, CATEGORY_OTHER, normalizeCategory };
