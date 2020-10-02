const _ = require('lodash');
const settingsCache = require('../../server/services/settings/cache');

function getMetaKeywords(data, root) {
    const context = root ? root.context : null;
    let keywords = '';

    // If there's a specific meta keyword set
    if (data.meta_keywords) {
        keywords = data.meta_keywords;
    } else if (_.includes(context, 'home')) {
        keywords = settingsCache.get('meta_keywords') || '';
    } else if (_.includes(context, 'post') && data.post) {
        keywords = data.post.meta_keywords;
        // Page title dependent on legacy object formatting (https://github.com/TryGhost/Ghost/issues/10042)
    }

    return (keywords || '').trim();
}

module.exports = getMetaKeywords;
