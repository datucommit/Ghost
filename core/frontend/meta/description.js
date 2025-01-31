const _ = require('lodash');
const settingsCache = require('../../server/services/settings/cache');
const getExcerpt = require('./excerpt');

function getDescription(data, root, options = {}) {
    const context = root ? root.context : null;

    let description = '';

    // We only return meta_description if provided
    if (_.includes(context, 'post') && data.post) {
        if (options.property) {
            description = data.post[`${options.property}_description`]
                || data.post.meta_description
                || settingsCache.get('description')
                || '';
        } else {
            description = data.post.meta_description || '';
        }
    } else if (_.includes(context, 'page') && data.post) {
        // Page description dependent on legacy object formatting (https://github.com/TryGhost/Ghost/issues/10042)
        if (options.property) {
            description = data.post[`${options.property}_description`]
                || data.post.meta_description
                || settingsCache.get('description')
                || '';
        } else {
            description = data.post.meta_description || '';
        }
    } else if (_.includes(context, 'page') && data.page) {
        if (options.property) {
            description = data.page[`${options.property}_description`]
                || data.page.meta_description
                || settingsCache.get('description')
                || '';
        } else {
            description = data.page.meta_description || '';
        }
    } else if (data.meta_description) {
        description = data.meta_description;
    } else if (_.includes(context, 'home')) {
        const siteDescription = settingsCache.get('meta_description') || settingsCache.get('description');

        if (options.property) {
            // options.property = null/'og'/'twitter'
            const optionsPropertyName = `${options.property || 'meta'}_description`;
            description = settingsCache.get(optionsPropertyName) || siteDescription || '';
        } else {
            description = siteDescription;
        }
    } else if (_.includes(context, 'author') && data.author) {
        if (!options.property && _.includes(context, 'paged')) {
            description = '';
        } else {
            // The usage of meta data fields for author is currently not implemented.
            // We do have meta_description and meta_title fields
            // in the users table, but there's no UI to populate those.
            description = data.author.meta_description
                || data.author.bio
                || (options.property ? settingsCache.get('meta_description') : '')
                || '';
        }
    } else if (_.includes(context, 'tag') && data.tag) {
        if (!options.property && _.includes(context, 'paged')) {
            description = '';
        } else {
            description = data.tag[`${options.property}_description`]
                || data.tag.meta_description
                || data.tag.description
                || (options.property ? settingsCache.get('meta_description') : '')
                || '';
        }
    }

    return (description || '').trim() || null;
}

module.exports = getDescription;
