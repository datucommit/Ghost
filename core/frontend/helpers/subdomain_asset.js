// # Subdomain Asset helper
// Usage: `{{subdomain_asset "css/SUBDOMAIN.css"}}` where SUBDOMAIN is replaced by, well, the subdomain
//
// Returns the path to the specified asset.
const {SafeString, metaData, errors, i18n} = require('../services/proxy');
const get = require('lodash/get');
const {getAssetUrl} = metaData;

module.exports = function subdomain_asset(path, options) {
    path = path.replace('SUBDOMAIN', process.env.subdomain)
    const hasMinFile = get(options, 'hash.hasMinFile');

    if (!path) {
        throw new errors.IncorrectUsageError({
            message: i18n.t('warnings.helpers.subdomain_asset.pathIsRequired')
        });
    }

    return new SafeString(
        getAssetUrl(path, hasMinFile)
    );
};
