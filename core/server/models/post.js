// # Post Model
const _ = require('lodash');
const uuid = require('uuid');
const moment = require('moment');
const Promise = require('bluebird');
const {sequence} = require('@tryghost/promise');
const {i18n} = require('../lib/common');
const errors = require('@tryghost/errors');
const htmlToText = require('html-to-text');
const ghostBookshelf = require('./base');
const config = require('../../shared/config');
const settingsCache = require('../services/settings/cache');
const mobiledocLib = require('../lib/mobiledoc');
const relations = require('./relations');
const urlUtils = require('../../shared/url-utils');
const MOBILEDOC_REVISIONS_COUNT = 10;
const ALL_STATUSES = ['published', 'draft', 'scheduled'];

let Post;
let Posts;

Post = ghostBookshelf.Model.extend({

    tableName: 'posts',

    /**
     * @NOTE
     *
     * We define the defaults on the schema (db) and model level.
     *
     * Why?
     *   - when you insert a resource, Knex does only return the id of the created resource
     *     - see https://knexjs.org/#Builder-insert
     *   - that means `defaultTo` is a pure database configuration (!)
     *   - Bookshelf just returns the model values which you have asked Bookshelf to insert
     *      - it can't return the `defaultTo` value from the schema/db level
     *      - but the db defaults defined in the schema are saved in the database correctly
     *   - `models.Post.add` always does to operations:
     *      1. add
     *      2. fetch (this ensures we fetch the whole resource from the database)
     *   - that means we have to apply the defaults on the model layer to ensure a complete field set
     *      1. any connected logic in our model hooks e.g. beforeSave
     *      2. model events e.g. "post.published" are using the inserted resource, not the fetched resource
     */
    defaults: function defaults() {
        let visibility = 'public';

        if (settingsCache.get('labs') && (settingsCache.get('labs').members === true) && settingsCache.get('default_content_visibility')) {
            visibility = settingsCache.get('default_content_visibility');
        }

        return {
            send_email_when_published: false,
            uuid: uuid.v4(),
            status: 'draft',
            featured: false,
            type: 'post',
            visibility: visibility
        };
    },

    relationships: ['tags', 'authors', 'mobiledoc_revisions', 'posts_meta'],

    // NOTE: look up object, not super nice, but was easy to implement
    relationshipBelongsTo: {
        tags: 'tags',
        authors: 'users',
        posts_meta: 'posts_meta'
    },

    relationsMeta: {
        posts_meta: {
            targetTableName: 'posts_meta',
            foreignKey: 'post_id'
        }
    },

    /**
     * The base model keeps only the columns, which are defined in the schema.
     * We have to add the relations on top, otherwise bookshelf-relations
     * has no access to the nested relations, which should be updated.
     */
    permittedAttributes: function permittedAttributes() {
        let filteredKeys = ghostBookshelf.Model.prototype.permittedAttributes.apply(this, arguments);

        this.relationships.forEach((key) => {
            filteredKeys.push(key);
        });

        return filteredKeys;
    },

    orderAttributes: function orderAttributes() {
        let keys = ghostBookshelf.Model.prototype.orderAttributes.apply(this, arguments);

        // extend ordered keys with post_meta keys
        let postsMetaKeys = _.without(ghostBookshelf.model('PostsMeta').prototype.orderAttributes(), 'posts_meta.id', 'posts_meta.post_id');

        return [...keys, ...postsMetaKeys];
    },

    emitChange: function emitChange(event, options = {}) {
        let eventToTrigger;
        let resourceType = this.get('type');

        if (options.usePreviousAttribute) {
            resourceType = this.previous('type');
        }

        eventToTrigger = resourceType + '.' + event;

        ghostBookshelf.Model.prototype.emitChange.bind(this)(this, eventToTrigger, options);
    },

    /**
     * We update the tags after the Post was inserted.
     * We update the tags before the Post was updated, see `onSaving` event.
     * `onCreated` is called before `onSaved`.
     *
     * `onSaved` is the last event in the line - triggered for updating or inserting data.
     * bookshelf-relations listens on `created` + `updated`.
     * We ensure that we are catching the event after bookshelf relations.
     */
    onSaved: function onSaved(model, response, options) {
        ghostBookshelf.Model.prototype.onSaved.apply(this, arguments);

        if (options.method !== 'insert') {
            return;
        }

        const status = model.get('status');

        model.emitChange('added', options);

        if (['published', 'scheduled'].indexOf(status) !== -1) {
            model.emitChange(status, options);
        }
    },

    onUpdated: function onUpdated(model, attrs, options) {
        ghostBookshelf.Model.prototype.onUpdated.apply(this, arguments);

        model.statusChanging = model.get('status') !== model.previous('status');
        model.isPublished = model.get('status') === 'published';
        model.isScheduled = model.get('status') === 'scheduled';
        model.wasPublished = model.previous('status') === 'published';
        model.wasScheduled = model.previous('status') === 'scheduled';
        model.resourceTypeChanging = model.get('type') !== model.previous('type');
        model.publishedAtHasChanged = model.hasDateChanged('published_at');
        model.needsReschedule = model.publishedAtHasChanged && model.isScheduled;

        // Handle added and deleted for post -> page or page -> post
        if (model.resourceTypeChanging) {
            if (model.wasPublished) {
                model.emitChange('unpublished', Object.assign({usePreviousAttribute: true}, options));
            }

            if (model.wasScheduled) {
                model.emitChange('unscheduled', Object.assign({usePreviousAttribute: true}, options));
            }

            model.emitChange('deleted', Object.assign({usePreviousAttribute: true}, options));
            model.emitChange('added', options);

            if (model.isPublished) {
                model.emitChange('published', options);
            }

            if (model.isScheduled) {
                model.emitChange('scheduled', options);
            }
        } else {
            if (model.statusChanging) {
                // CASE: was published before and is now e.q. draft or scheduled
                if (model.wasPublished) {
                    model.emitChange('unpublished', options);
                }

                // CASE: was draft or scheduled before and is now e.q. published
                if (model.isPublished) {
                    model.emitChange('published', options);
                }

                // CASE: was draft or published before and is now e.q. scheduled
                if (model.isScheduled) {
                    model.emitChange('scheduled', options);
                }

                // CASE: from scheduled to something
                if (model.wasScheduled && !model.isScheduled && !model.isPublished) {
                    model.emitChange('unscheduled', options);
                }
            } else {
                if (model.isPublished) {
                    model.emitChange('published.edited', options);
                }

                if (model.needsReschedule) {
                    model.emitChange('rescheduled', options);
                }
            }

            // Fire edited if this wasn't a change between resourceType
            model.emitChange('edited', options);
        }

        if (model.statusChanging && (model.isPublished || model.wasPublished)) {
            this.handleStatusForAttachedModels(model, options);
        }
    },

    onDestroyed: function onDestroyed(model, options) {
        ghostBookshelf.Model.prototype.onDestroyed.apply(this, arguments);

        if (model.previous('status') === 'published') {
            model.emitChange('unpublished', Object.assign({usePreviousAttribute: true}, options));
        }

        model.emitChange('deleted', Object.assign({usePreviousAttribute: true}, options));
    },

    onDestroying: function onDestroyed(model) {
        ghostBookshelf.Model.prototype.onDestroying.apply(this, arguments);

        this.handleAttachedModels(model);
    },

    handleAttachedModels: function handleAttachedModels(model) {
        /**
         * @NOTE:
         * Bookshelf only exposes the object that is being detached on `detaching`.
         * For the reason above, `detached` handler is using the scope of `detaching`
         * to access the models that are not present in `detached`.
         */
        model.related('tags').once('detaching', function detachingTags(collection, tag) {
            model.related('tags').once('detached', function detachedTags(detachedCollection, response, options) {
                tag.emitChange('detached', options);
                model.emitChange('tag.detached', options);
            });
        });

        model.related('tags').once('attaching', function tagsAttaching(collection, tags) {
            model.related('tags').once('attached', function tagsAttached(detachedCollection, response, options) {
                tags.forEach((tag) => {
                    tag.emitChange('attached', options);
                    model.emitChange('tag.attached', options);
                });
            });
        });

        model.related('authors').once('detaching', function authorsDetaching(collection, author) {
            model.related('authors').once('detached', function authorsDetached(detachedCollection, response, options) {
                author.emitChange('detached', options);
            });
        });

        model.related('authors').once('attaching', function authorsAttaching(collection, authors) {
            model.related('authors').once('attached', function authorsAttached(detachedCollection, response, options) {
                authors.forEach(author => author.emitChange('attached', options));
            });
        });
    },

    /**
     * @NOTE:
     * when status is changed from or to 'published' all related authors and tags
     * have to trigger recalculation in URL service because status is applied in filters for
     * these models
     */
    handleStatusForAttachedModels: function handleStatusForAttachedModels(model, options) {
        model.related('tags').forEach((tag) => {
            tag.emitChange('attached', options);
        });

        model.related('authors').forEach((author) => {
            author.emitChange('attached', options);
        });
    },

    onSaving: async function onSaving(model, attr, options) {
        options = options || {};

        const self = this;
        let title;
        let i;

        // Variables to make the slug checking more readable
        const newTitle = this.get('title');

        const newStatus = this.get('status');
        const olderStatus = this.previous('status');
        const prevTitle = this.previous('title');
        const prevSlug = this.previous('slug');
        const publishedAt = this.get('published_at');
        const publishedAtHasChanged = this.hasDateChanged('published_at', {beforeWrite: true});
        const generatedFields = ['html', 'plaintext'];
        let tagsToSave;
        const ops = [];

        // CASE: disallow published -> scheduled
        // @TODO: remove when we have versioning based on updated_at
        if (newStatus !== olderStatus && newStatus === 'scheduled' && olderStatus === 'published') {
            return Promise.reject(new errors.ValidationError({
                message: i18n.t('errors.models.post.isAlreadyPublished', {key: 'status'})
            }));
        }

        if (options.method === 'insert') {
            if (!this.get('comment_id')) {
                this.set('comment_id', this.id);
            }
        }

        // CASE: both page and post can get scheduled
        if (newStatus === 'scheduled') {
            if (!publishedAt) {
                return Promise.reject(new errors.ValidationError({
                    message: i18n.t('errors.models.post.valueCannotBeBlank', {key: 'published_at'})
                }));
            } else if (!moment(publishedAt).isValid()) {
                return Promise.reject(new errors.ValidationError({
                    message: i18n.t('errors.models.post.valueCannotBeBlank', {key: 'published_at'})
                }));
                // CASE: to schedule/reschedule a post, a minimum diff of x minutes is needed (default configured is 2minutes)
            } else if (
                publishedAtHasChanged &&
                moment(publishedAt).isBefore(moment().add(config.get('times').cannotScheduleAPostBeforeInMinutes, 'minutes')) &&
                !options.importing &&
                (!options.context || !options.context.internal)
            ) {
                return Promise.reject(new errors.ValidationError({
                    message: i18n.t('errors.models.post.expectedPublishedAtInFuture', {
                        cannotScheduleAPostBeforeInMinutes: config.get('times').cannotScheduleAPostBeforeInMinutes
                    })
                }));
            }
        }

        // CASE: detect lowercase/uppercase tag slugs
        if (!_.isUndefined(this.get('tags')) && !_.isNull(this.get('tags'))) {
            tagsToSave = [];

            //  and deduplicate upper/lowercase tags
            _.each(this.get('tags'), function each(item) {
                for (i = 0; i < tagsToSave.length; i = i + 1) {
                    if (tagsToSave[i].name && item.name && tagsToSave[i].name.toLocaleLowerCase() === item.name.toLocaleLowerCase()) {
                        return;
                    }
                }

                tagsToSave.push(item);
            });

            this.set('tags', tagsToSave);
        }

        /**
         * CASE: Attach id to update existing posts_meta entry for a post
         * CASE: Don't create new posts_meta entry if post meta is empty
         */
        if (!_.isUndefined(this.get('posts_meta')) && !_.isNull(this.get('posts_meta'))) {
            let postsMetaData = this.get('posts_meta');
            let relatedModelId = model.related('posts_meta').get('id');
            let hasNoData = !_.values(postsMetaData).some(x => !!x);
            if (relatedModelId && !_.isEmpty(postsMetaData)) {
                postsMetaData.id = relatedModelId;
                this.set('posts_meta', postsMetaData);
            } else if (_.isEmpty(postsMetaData) || hasNoData) {
                this.set('posts_meta', null);
            }
        }

        this.handleAttachedModels(model);

        ghostBookshelf.Model.prototype.onSaving.apply(this, arguments);

        // do not allow generated fields to be overridden via the API
        if (!options.migrating) {
            generatedFields.forEach((field) => {
                if (this.hasChanged(field)) {
                    this.set(field, this.previous(field));
                }
            });
        }

        if (!this.get('mobiledoc')) {
            this.set('mobiledoc', JSON.stringify(mobiledocLib.blankDocument));
        }

        // ensure all URLs are stored as relative
        // note: html is not necessary to change because it's a generated later from mobiledoc
        const urlTransformMap = {
            mobiledoc: 'mobiledocAbsoluteToRelative',
            custom_excerpt: 'htmlAbsoluteToRelative',
            codeinjection_head: 'htmlAbsoluteToRelative',
            codeinjection_foot: 'htmlAbsoluteToRelative',
            feature_image: 'absoluteToRelative',
            og_image: 'absoluteToRelative',
            twitter_image: 'absoluteToRelative',
            canonical_url: {
                method: 'absoluteToRelative',
                options: {
                    ignoreProtocol: false
                }
            }
        };

        Object.entries(urlTransformMap).forEach(([attrToTransform, transform]) => {
            let method = transform;
            let transformOptions = {};

            if (typeof transform === 'object') {
                method = transform.method;
                transformOptions = transform.options || {};
            }

            if (this.hasChanged(attrToTransform) && this.get(attrToTransform)) {
                const transformedValue = urlUtils[method](this.get(attrToTransform), transformOptions);
                this.set(attrToTransform, transformedValue);
            }
        });

        // If we're force re-rendering we want to make sure that all image cards
        // have original dimensions stored in the payload for use by card renderers
        if (options.force_rerender) {
            this.set('mobiledoc', await mobiledocLib.populateImageSizes(this.get('mobiledoc')));
        }

        // CASE: mobiledoc has changed, generate html
        // CASE: ?force_rerender=true passed via Admin API
        // CASE: html is null, but mobiledoc exists (only important for migrations & importing)
        if (
            this.hasChanged('mobiledoc')
            || options.force_rerender
            || (!this.get('html') && (options.migrating || options.importing))
        ) {
            try {
                this.set('html', mobiledocLib.mobiledocHtmlRenderer.render(JSON.parse(this.get('mobiledoc'))));
            } catch (err) {
                throw new errors.ValidationError({
                    message: 'Invalid mobiledoc structure.',
                    help: 'https://ghost.org/docs/concepts/posts/'
                });
            }
        }

        if (this.hasChanged('html') || !this.get('plaintext')) {
            let plaintext;

            if (this.get('html') === null) {
                plaintext = null;
            } else {
                plaintext = htmlToText.fromString(this.get('html'), {
                    wordwrap: 80,
                    ignoreImage: true,
                    hideLinkHrefIfSameAsText: true,
                    preserveNewlines: true,
                    returnDomByDefault: true,
                    uppercaseHeadings: false
                });
            }

            // CASE: html is e.g. <p></p>
            // @NOTE: Otherwise we will always update the resource to `plaintext: ''` and Bookshelf thinks that this
            //        value was modified.
            if (plaintext || plaintext !== this.get('plaintext')) {
                this.set('plaintext', plaintext);
            }
        }

        // disabling sanitization until we can implement a better version
        if (!options.importing) {
            title = this.get('title') || i18n.t('errors.models.post.untitled');
            this.set('title', _.toString(title).trim());
        }

        // ### Business logic for published_at and published_by
        // If the current status is 'published' and published_at is not set, set it to now
        if (newStatus === 'published' && !publishedAt) {
            this.set('published_at', new Date());
        }

        // If the current status is 'published' and the status has just changed ensure published_by is set correctly
        if (newStatus === 'published' && this.hasChanged('status')) {
            // unless published_by is set and we're importing, set published_by to contextUser
            if (!(this.get('published_by') && options.importing)) {
                this.set('published_by', String(this.contextUser(options)));
            }
        } else {
            // In any other case (except import), `published_by` should not be changed
            if (this.hasChanged('published_by') && !options.importing) {
                this.set('published_by', this.previous('published_by') ? String(this.previous('published_by')) : null);
            }
        }

        // send_email_when_published is read-only and should only be set using a query param when publishing/scheduling
        if (options.send_email_when_published && this.hasChanged('status') && (newStatus === 'published' || newStatus === 'scheduled')) {
            this.set('send_email_when_published', true);
        }

        // ensure draft posts have the send_email_when_published reset unless an email has already been sent
        if (newStatus === 'draft' && this.hasChanged('status')) {
            ops.push(function ensureSendEmailWhenPublishedIsUnchanged() {
                return self.related('email').fetch({transacting: options.transacting}).then((email) => {
                    if (email) {
                        self.set('send_email_when_published', true);
                    } else {
                        self.set('send_email_when_published', false);
                    }
                });
            });
        }

        // If a title is set, not the same as the old title, a draft post, and has never been published
        if (prevTitle !== undefined && newTitle !== prevTitle && newStatus === 'draft' && !publishedAt) {
            ops.push(function updateSlug() {
                // Pass the new slug through the generator to strip illegal characters, detect duplicates
                return ghostBookshelf.Model.generateSlug(Post, self.get('title'),
                    {status: 'all', transacting: options.transacting, importing: options.importing})
                    .then(function then(slug) {
                        // After the new slug is found, do another generate for the old title to compare it to the old slug
                        return ghostBookshelf.Model.generateSlug(Post, prevTitle,
                            {status: 'all', transacting: options.transacting, importing: options.importing}
                        ).then(function prevTitleSlugGenerated(prevTitleSlug) {
                            // If the old slug is the same as the slug that was generated from the old title
                            // then set a new slug. If it is not the same, means was set by the user
                            if (prevTitleSlug === prevSlug) {
                                self.set({slug: slug});
                            }
                        });
                    });
            });
        } else {
            ops.push(function updateSlug() {
                // If any of the attributes above were false, set initial slug and check to see if slug was changed by the user
                if (self.hasChanged('slug') || !self.get('slug')) {
                    // Pass the new slug through the generator to strip illegal characters, detect duplicates
                    return ghostBookshelf.Model.generateSlug(Post, self.get('slug') || self.get('title'),
                        {status: 'all', transacting: options.transacting, importing: options.importing})
                        .then(function then(slug) {
                            self.set({slug: slug});
                        });
                }

                return Promise.resolve();
            });
        }

        // CASE: Handle mobiledoc backups/revisions. This is a pure database feature.
        if (model.hasChanged('mobiledoc') && !options.importing && !options.migrating) {
            ops.push(function updateRevisions() {
                return ghostBookshelf.model('MobiledocRevision')
                    .findAll(Object.assign({
                        filter: `post_id:${model.id}`,
                        columns: ['id']
                    }, _.pick(options, 'transacting')))
                    .then((revisions) => {
                        /**
                         * Store prev + latest mobiledoc content, because we have decided against a migration, which
                         * iterates over all posts and creates a copy of the current mobiledoc content.
                         *
                         * Reasons:
                         *   - usually migrations for the post table are slow and error-prone
                         *   - there is no need to create a copy for all posts now, because we only want to ensure
                         *     that posts, which you are currently working on, are getting a content backup
                         *   - no need to create revisions for existing published posts
                         *
                         * The feature is very minimal in the beginning. As soon as you update to this Ghost version,
                         * you
                         */
                        if (!revisions.length && options.method !== 'insert') {
                            model.set('mobiledoc_revisions', [{
                                post_id: model.id,
                                mobiledoc: model.previous('mobiledoc'),
                                created_at_ts: Date.now() - 1
                            }, {
                                post_id: model.id,
                                mobiledoc: model.get('mobiledoc'),
                                created_at_ts: Date.now()
                            }]);
                        } else {
                            const revisionsJSON = revisions.toJSON().slice(0, MOBILEDOC_REVISIONS_COUNT - 1);

                            model.set('mobiledoc_revisions', revisionsJSON.concat([{
                                post_id: model.id,
                                mobiledoc: model.get('mobiledoc'),
                                created_at_ts: Date.now()
                            }]));
                        }
                    });
            });
        }

        return sequence(ops);
    },

    created_by: function createdBy() {
        return this.belongsTo('User', 'created_by');
    },

    updated_by: function updatedBy() {
        return this.belongsTo('User', 'updated_by');
    },

    published_by: function publishedBy() {
        return this.belongsTo('User', 'published_by');
    },

    authors: function authors() {
        return this.belongsToMany('User', 'posts_authors', 'post_id', 'author_id')
            .withPivot('sort_order')
            .query('orderBy', 'sort_order', 'ASC');
    },

    tags: function tags() {
        return this.belongsToMany('Tag', 'posts_tags', 'post_id', 'tag_id')
            .withPivot('sort_order')
            .query('orderBy', 'sort_order', 'ASC');
    },

    fields: function fields() {
        return this.morphMany('AppField', 'relatable');
    },

    mobiledoc_revisions() {
        return this.hasMany('MobiledocRevision', 'post_id');
    },

    posts_meta: function postsMeta() {
        return this.hasOne('PostsMeta', 'post_id');
    },

    email: function email() {
        return this.hasOne('Email', 'post_id');
    },

    /**
     * @NOTE:
     * If you are requesting models with `columns`, you try to only receive some fields of the model/s.
     * But the model layer is complex and needs specific fields in specific situations.
     *
     * ### url generation was removed but default columns need to be checked before removal
     *   - @TODO: with dynamic routing, we no longer need default columns to fetch
     *   - because with static routing Ghost generated the url on runtime and needed the following attributes:
     *     - `slug`: /:slug/
     *     - `published_at`: /:year/:slug
     *     - `author_id`: /:author/:slug, /:primary_author/:slug
     *     - now, the UrlService pre-generates urls based on the resources
     *     - you can ask `urlService.getUrlByResourceId(post.id)`
     *
     * ### events
     *   - you call `findAll` with `columns: id`
     *   - then you trigger `post.save()` on the response
     *   - bookshelf events (`onSaving`) and model events (`emitChange`) are triggered
     *   - but you only fetched the id column, this will trouble (!), because the event hooks require more
     *     data than just the id
     *   - @TODO: we need to disallow this (!)
     *   - you should use `models.Post.edit(..)`
     *      - this disallows using the `columns` option
     *   - same for destroy - you should use `models.Post.destroy(...)`
     *
     * @IMPORTANT: This fn should **never** be used when updating models (models.Post.edit)!
     *            Because the events for updating a resource require most of the fields.
     *            This is protected by the fn `permittedOptions`.
     */
    defaultColumnsToFetch: function defaultColumnsToFetch() {
        return ['id', 'published_at', 'slug', 'author_id'];
    },
    /**
     * If the `formats` option is not used, we return `html` be default.
     * Otherwise we return what is requested e.g. `?formats=mobiledoc,plaintext`
     */
    formatsToJSON: function formatsToJSON(attrs, options) {
        const defaultFormats = ['html'];
        const formatsToKeep = options.formats || defaultFormats;

        // Iterate over all known formats, and if they are not in the keep list, remove them
        _.each(Post.allowedFormats, function (format) {
            if (formatsToKeep.indexOf(format) === -1) {
                delete attrs[format];
            }
        });

        return attrs;
    },

    toJSON: function toJSON(unfilteredOptions) {
        const options = Post.filterOptions(unfilteredOptions, 'toJSON');
        let attrs = ghostBookshelf.Model.prototype.toJSON.call(this, options);

        attrs = this.formatsToJSON(attrs, options);

        // CASE: never expose the revisions
        delete attrs.mobiledoc_revisions;

        // If the current column settings allow it...
        if (!options.columns || (options.columns && options.columns.indexOf('primary_tag') > -1)) {
            // ... attach a computed property of primary_tag which is the first tag if it is public, else null
            if (attrs.tags && attrs.tags.length > 0 && attrs.tags[0].visibility === 'public') {
                attrs.primary_tag = attrs.tags[0];
            } else {
                attrs.primary_tag = null;
            }
        }

        return attrs;
    },

    // NOTE: overloads models base method to take `post_meta` changes into account
    wasChanged() {
        if (!this._changed) {
            return true;
        }

        const postMetaChanged = this.relations.posts_meta && this.relations.posts_meta._changed && Object.keys(this.relations.posts_meta._changed).length;

        if (!Object.keys(this._changed).length && !postMetaChanged) {
            return false;
        }

        return true;
    },

    enforcedFilters: function enforcedFilters(options) {
        return options.context && options.context.public ? 'status:published' : null;
    },

    defaultFilters: function defaultFilters(options) {
        if (options.context && options.context.internal) {
            return null;
        }

        return options.context && options.context.public ? 'type:post' : 'type:post+status:published';
    },

    /**
     * You can pass an extra `status=VALUES` field.
     * Long-Term: We should deprecate these short cuts and force users to use the filter param.
     */
    extraFilters: function extraFilters(options) {
        if (!options.status) {
            return null;
        }

        let filter = null;

        // CASE: "status" is passed, combine filters
        if (options.status && options.status !== 'all') {
            options.status = _.includes(ALL_STATUSES, options.status) ? options.status : 'published';

            if (!filter) {
                filter = `status:${options.status}`;
            } else {
                filter = `${filter}+status:${options.status}`;
            }
        } else if (options.status === 'all') {
            if (!filter) {
                filter = `status:[${ALL_STATUSES}]`;
            } else {
                filter = `${filter}+status:[${ALL_STATUSES}]`;
            }
        }

        delete options.status;
        return filter;
    },

    getAction(event, options) {
        const actor = this.getActor(options);

        // @NOTE: we ignore internal updates (`options.context.internal`) for now
        if (!actor) {
            return;
        }

        // @TODO: implement context
        return {
            event: event,
            resource_id: this.id || this.previous('id'),
            resource_type: 'post',
            actor_id: actor.id,
            actor_type: actor.type
        };
    }
}, {
    allowedFormats: ['mobiledoc', 'html', 'plaintext'],

    orderDefaultOptions: function orderDefaultOptions() {
        return {
            status: 'ASC',
            published_at: 'DESC',
            updated_at: 'DESC',
            id: 'DESC'
        };
    },

    orderDefaultRaw: function (options) {
        let order = '' +
            'CASE WHEN posts.status = \'scheduled\' THEN 1 ' +
            'WHEN posts.status = \'draft\' THEN 2 ' +
            'ELSE 3 END ASC,' +
            'CASE WHEN posts.status != \'draft\' THEN posts.published_at END DESC,' +
            'posts.updated_at DESC,' +
            'posts.id DESC';

        // CASE: if the filter contains an `IN` operator, we should return the posts first, which match both tags
        if (options.filter && options.filter.match(/(tags|tag):\s?\[.*\]/)) {
            order = `(SELECT count(*) FROM posts_tags WHERE post_id = posts.id) DESC, ${order}`;
        }

        // CASE: if the filter contains an `IN` operator, we should return the posts first, which match both authors
        if (options.filter && options.filter.match(/(authors|author):\s?\[.*\]/)) {
            order = `(SELECT count(*) FROM posts_authors WHERE post_id = posts.id) DESC, ${order}`;
        }

        return order;
    },

    /**
     * Returns an array of keys permitted in a method's `options` hash, depending on the current method.
     * @param {String} methodName The name of the method to check valid options for.
     * @return {Array} Keys allowed in the `options` hash of the model's method.
     */
    permittedOptions: function permittedOptions(methodName) {
        let options = ghostBookshelf.Model.permittedOptions.call(this, methodName);

        // whitelists for the `options` hash argument on methods, by method name.
        // these are the only options that can be passed to Bookshelf / Knex.
        const validOptions = {
            findOne: ['columns', 'importing', 'withRelated', 'require', 'filter'],
            findPage: ['status'],
            findAll: ['columns', 'filter'],
            destroy: ['destroyAll', 'destroyBy'],
            edit: ['filter', 'send_email_when_published', 'force_rerender']
        };

        // The post model additionally supports having a formats option
        options.push('formats');

        if (validOptions[methodName]) {
            options = options.concat(validOptions[methodName]);
        }

        return options;
    },

    /**
     * We have to ensure consistency. If you listen on model events (e.g. `post.published`), you can expect that you always
     * receive all fields including relations. Otherwise you can't rely on a consistent flow. And we want to avoid
     * that event listeners have to re-fetch a resource. This function is used in the context of inserting
     * and updating resources. We won't return the relations by default for now.
     *
     * We also always fetch posts metadata to keep current behavior consistent
     */
    defaultRelations: function defaultRelations(methodName, options) {
        if (['edit', 'add', 'destroy'].indexOf(methodName) !== -1) {
            options.withRelated = _.union(['authors', 'tags'], options.withRelated || []);
        }

        const META_ATTRIBUTES = _.without(ghostBookshelf.model('PostsMeta').prototype.permittedAttributes(), 'id', 'post_id');

        // NOTE: only include post_meta relation when requested in 'columns' or by default
        //       optimization is needed to be able to perform .findAll on large SQLite datasets
        if (!options.columns || (options.columns && _.intersection(META_ATTRIBUTES, options.columns).length)) {
            options.withRelated = _.union(['posts_meta'], options.withRelated || []);
        }

        return options;
    },

    /**
     * Manually add 'tags' attribute since it's not in the schema and call parent.
     *
     * @param {Object} data Has keys representing the model's attributes/fields in the database.
     * @return {Object} The filtered results of the passed in data, containing only what's allowed in the schema.
     */
    filterData: function filterData(data) {
        const filteredData = ghostBookshelf.Model.filterData.apply(this, arguments);
        const extraData = _.pick(data, this.prototype.relationships);

        _.merge(filteredData, extraData);
        return filteredData;
    },

    // ## Model Data Functions

    /**
     * ### Find One
     * @extends ghostBookshelf.Model.findOne to handle post status
     * **See:** [ghostBookshelf.Model.findOne](base.js.html#Find%20One)
     */
    findOne: function findOne(data = {}, options = {}) {
        // @TODO: remove when we drop v0.1
        if (!options.filter && !data.status) {
            data.status = 'published';
        }

        if (data.status === 'all') {
            delete data.status;
        }

        return ghostBookshelf.Model.findOne.call(this, data, options);
    },

    /**
     * ### Edit
     * Fetches and saves to Post. See model.Base.edit
     * **See:** [ghostBookshelf.Model.edit](base.js.html#edit)
     */
    edit: function edit(data, unfilteredOptions) {
        let options = this.filterOptions(unfilteredOptions, 'edit', {extraAllowedProperties: ['id']});

        const editPost = () => {
            options.forUpdate = true;

            return ghostBookshelf.Model.edit.call(this, data, options)
                .then((post) => {
                    return this.findOne({
                        status: 'all',
                        id: options.id
                    }, _.merge({transacting: options.transacting}, unfilteredOptions))
                        .then((found) => {
                            if (found) {
                                // Pass along the updated attributes for checking status changes
                                found._previousAttributes = post._previousAttributes;
                                found._changed = post._changed;

                                // NOTE: `posts_meta` fields are equivalent in terms of "wasChanged" logic to the rest of posts's table fields.
                                //       Keeping track of them is needed to check if anything was changed in post's resource.
                                if (found.relations.posts_meta) {
                                    found.relations.posts_meta._changed = post.relations.posts_meta._changed;
                                }

                                return found;
                            }
                        });
                });
        };

        if (!options.transacting) {
            return ghostBookshelf.transaction((transacting) => {
                options.transacting = transacting;
                return editPost();
            });
        }

        return editPost();
    },

    /**
     * ### Add
     * @extends ghostBookshelf.Model.add to handle returning the full object
     * **See:** [ghostBookshelf.Model.add](base.js.html#add)
     */
    add: function add(data, unfilteredOptions) {
        let options = this.filterOptions(unfilteredOptions, 'add', {extraAllowedProperties: ['id']});
        const sidebars = {montana: '<span>Montana Reverse Phone Lookup</span><p>Reverse phone lookup, or reverse phone search, is used to uncover information that can identify an unknown caller. Reverse phone search tools search a variety of public records and phone number registration databases to ascertain subscribers assigned numbers submitted for search. It is useful for answering the question: &quot;who called me&quot;.<p>', florida: '<span>Florida Reverse Phone Lookup</span><p>Reverse phone lookup (also reverse phone search) involves finding the personal details connected to a particular phone number. Some of these details include the name and address of the caller. Reverse phone lookup is enabled by the documentation provided when registering a phone number. It is useful for identifying callers and staying ahead of phone scams and stalkers.<p>', alaska: '<span>Alaska Reverse Phone Lookup</span><p>Performing reverse phone lookup on Alaska phone numbers allows one to identify unknown callers. There are many reasons why someone may decide to investigate the origin of a phone call. While it can be out of curiosity, it may also be to find out if an unknown number belongs to a stalker, a scammer, or someone with a criminal record. Understanding how to search the extensive databases maintained by reverse phone search services can help you decide whether you should ignore an unknown caller or call them back.<p>', nebraska: '<span>Nebraska Reverse Phone Lookup</span><p>Reverse phone lookup or reverse phone search is a way of finding the identities of callers not in your contact lists through their phone numbers. This service is useful for discovering the owners of unknown numbers calling you whether the numbers bear Nebraska area codes or not. The information provided can help you decide whether an unsolicited call is likely from a scammer, an old acquaintance, a known organization, a robocaller, or a spam caller.\n<p>', nevada: '<span>Nevada Reverse Phone Lookup</span><p>Also known as reverse phone search, phone number lookup refers to the different ways a called party can find out the real person behind an unknown call just by searching with the phone number. Vital personal information required as a basic registration requirement for obtaining a phone number provides a rich database for reverse phone search. Using phone lookup services, Nevada residents can identify unknown callers and avoid scammers trying to steal money and information.\n<p>', newjersey: '<span>New Jersey Reverse Phone Lookup</span><p>Reverse phone search or phone number lookup is the process for obtaining information about the registered user of a telephone service number. Before any individual is granted a phone number, they are required to provide personal information details for verification and other statutory purposes. By performing a reverse phone search using a phone number, it is possible to identify who the number is registered to.\n<p>', newyork: '<span>New York Reverse Phone Lookup</span><p>A reverse phone number search or phone number lookup involves searching and identifying the subscriber registered to a phone number. The most common reason to conduct a phone number search is to discover details about the person using a particular phone number, most often on suspicion of fraud or other illicit activities. You can also look up an unknown phone number or a spam call in order to discover the identity of a strange caller.<p>', connecticut: '<span>Connecticut Reverse Phone Lookup</span><p>Reverse phone lookup is the process of discovering more details about who a phone number is registered to using just the phone number. Using a standard phone directory, you find a phone number by searching by name. In reverse phone search, however, it is the phone number that will lead the enquirer to the name and other details about who the number is registered to.<p>', indiana: '<span>Indiana Reverse Phone Lookup</span><p>Phone lookup or reverse phone search is a way of discovering the owner of a phone number by searching phone subscriber directories. With the increasing worry of phone scams, many Hoosiers are uneasy when contacted by unknown numbers. Identifying an unknown caller is just one of the many reasons why someone may consider investigating the origin and location of a call. Phone lookup services maintain extensive databases of mobile phone, landline, and some VoIP phone numbers. Anyone can easily use these online tools to differentiate genuine callers from spam.\n<p>', kansas: '<span>Kansas Reverse Phone Lookup</span><p>The processes of searching and retrieving user information for phone numbers is referred to as reverse phone lookup. It is a procedure used to discover who an unknown number is registered to. During the process of procuring a phone line, carriers require each subscriber to provide identification and contact information. Reverse phone searches look up these details and return them to persons trying to identify persons registered to submitted phone numbers. A reverse phone lookup is also known as reverse phone search or phone number lookup.<p>', louisiana: '<span>Louisiana Reverse Phone Lookup</span><p>A reverse phone search refers to the process involved in looking up information about a phone number to identify whom the number is registered to. Before receiving a phone number, subscribers are required to complete paperwork and provide identification, and this information is registered in a directory. A reverse phone search or phone number lookup searches the directory and retrieves available information about the registrant of a phone number.<p>', maryland: '<span>Maryland Reverse Phone Lookup</span><p>Reverse phone lookup is a process by which an individual can discover who the phone number that called them is registered to, amongst other information. This process is also referred to as phone number search. When acquiring a phone number, each subscriber is required to complete paperwork that will contain personal information details. A reverse phone lookup accesses carrier subscriber registries to retrieve available information about the phone numbers being searched.<p>', michigan: '<span>Michigan Reverse Phone Lookup</span><p>A reverse phone lookup is a process by which available information about the owner of a phone number is obtained. Anyone who applies for a phone number is required to provide their identity and contact data before receiving one. This information is stored in a user account directory maintained by the service provider. The question &quot;who called me?&quot; can be answered by retrieving the user information for the phone number in question with a reverse phone search.<p>', minnesota: '<span>Minnesota Reverse Phone Lookup</span><p>Reverse phone lookup is the process of getting the names and other personal information of unknown callers using their phone numbers. There are many reasons why Minnesotans may decide to perform reverse phone searches. While some may want to find out whether anonymous numbers calling them are from scammers or stalkers, others may do so to find more information on vaguely familiar contacts. Regardless of their reasons, searching extensive directories maintained by phone number lookup services can provide information about who those numbers are registered to.<p>', mississippi: '<span>Mississippi Reverse Phone Lookup</span><p>Reverse phone lookup or reverse phone search involves retrieving user account information for a phone number. When purchasing a phone line, the subscriber is required to provide certain personal information as well as identification. Carriers keep such subscriber information in user account directories that reverse phone searches can query. A reverse phone search or phone number search is for verifying who an unknown number is registered to.<p>', northcarolina: '<span>North Carolina Reverse Phone Lookup</span><p>The process by which a person can obtain information about who the phone number that called them is registered to is referred to as reverse phone search or phone number lookup. Anyone who acquires a phone number is required to provide personal information about themselves, which is registered against the number. By performing a reverse phone lookup, it is possible to gain access to the subscriber details registered to a phone number.<p>', northdakota: '<span>North Dakota Reverse Phone Lookup</span><p>Reverse phone lookup is the process of retrieving available user account information about a phone number. Also commonly referred to as phone number lookup, it provides answers to the question &quot;who is this number registered to&quot;. Part of the steps required for obtaining a new phone number is submitting personal information and providing ID to your carrier of choice. Carriers store such subscriber records in accessible user account directories. A reverse phone lookup queries these directories and returns the available information to the persons conducting the phone number lookup.<p>', ohio: '<span>Ohio Reverse Phone Lookup</span><p>When an individual performs a reverse phone search or a phone number lookup, it is usually to find out information about the person who owns a particular phone number. This is possible because people are required to provide identifying information when requesting phone numbers. As such, discovering details about the last person who called you is simple as long as you can retrieve the phone number they called you with.<p>', oregon: '<span>Oregon Reverse Phone Lookup</span><p>Reverse phone search, or phone number lookup, is an investigative process through which an individual retrieves information about a caller or user of a specific phone number. It comes in handy when there are doubts about the true identity of a caller. By inputting the phone number in a reverse phone lookup search, information about the subscriber assigned the number can be accessed. This is possible because subscriber details are provided to carriers when registering new phone numbers.<p>', pennsylvania: '<span>Pennsylvania Reverse Phone Lookup</span><p>Reverse phone lookup or reverse phone search is a directory that contains phone numbers and details about who the numbers are registered to. The main difference between this and a regular directory is that the phone number is used to get other information about the customer rather than using previously known information to get the phone number. There are many reasons to undertake a reverse phone search. Some of these include identifying unknown callers, stopping spam calls, and avoiding phone scams. In addition to identifying a caller, a reverse phone lookup may also provide other information about the caller including their address and criminal record. While a quick Google search may reveal phonebook information about a phone number, dedicated reverse phone lookup services offer more thorough searches, can find information on a wider range of numbers, and provide deeper information about callers.<p>', rhodeisland: '<span>Rhode Island Reverse Phone Lookup</span><p>Reverse phone search, also known as phone number lookup, is the process of unveiling detailed information about the subscriber registered to a phone number. It is called &#39;reverse&#39; because instead of using a name to get the phone number, the phone number is used to get the person&#39;s name and other details.<p>', southcarolina: '<span>South Carolina Reverse Phone Lookup</span><p>It is possible to identify the unknown of an unknown number by conducting a reverse phone lookup. Reverse phone lookup services run submitted numbers through their extensive databases of phone subscribers to identify unknown callers. These services are needed when you want to find out if unknown callers with phone numbers bearing South Carolina area codes are fraudsters, stalkers, old friends, or someone you would rather engage or ignore.\n<p>', southdakota: '<span>South Dakota Reverse Phone Lookup</span><p>Reverse phone lookup is the process of looking up available details about the registered user of a phone number. When registering new phone subscribers, carriers collect their contact information and store these details in accessible directories. A reverse phone lookup service searches these directories and retrieves user information on the subjects of the searches. When a user submits a number to a phone look service, they want an answer to the question &quot;who is this number registered to?&quot;<p>', tennessee: '<span>Tennessee Reverse Phone Lookup</span><p>Reverse phone lookup or reverse phone search is a way of finding out the true identities of unknown callers through their phone numbers. Various phone lookup services maintain extensive directories that can provide information associated with phone numbers registered in the United States. Available information can include names, addresses, and even criminal records. Understanding how to search through these online-based phone databases can help Tennesseans determine whether or not to answer a call or redial it.<p>', utah: '<span>Utah Reverse Phone Lookup</span><p>Reverse phone lookup is a way of retrieving a name and other personal information associated with a phone number. Some online directories maintain extensive databases useful for discovering the identities and addresses of unknown callers and other available information Understanding how to use these services can help determine whether to ignore a call from an unknown, dial back, block it, or report it to your local law enforcement.<p>', virginia: '<span>Virginia Reverse Phone Lookup</span><p>Reverse phone lookup or reverse phone search is the process of using a phone number to identify the caller details associated with it. It is not always advisable for Virginians to answer unknown calls without first running an online reverse check on the numbers calling them. While it could be a friend, family, or acquaintance, an unknown number could also be a scammer, robocall, or malicious person. Phone lookup services maintain comprehensive collections of landline and cellphone numbers and can provide the customer details attached to them. The search results will help you decide whether you want to call back, ignore, or block future calls from that number.<p>', westvirginia: '<span>West Virginia Reverse Phone Lookup</span><p>A phone lookup, or reverse phone search, is the act of querying a reverse phone directory to retrieve details about a particular phone number. Individuals or companies that apply for phone numbers are mandated to provide essential information such as full names and addresses. As such, anyone who receives a call from an unknown number can use reverse phone lookup to answer the question &quot;who called me?&quot;<p>', wyoming: '<span>Wyoming Reverse Phone Lookup</span><p>Reverse phone lookup is the process of searching and retrieving information about the person registered to an unknown number. Persons procuring new phone numbers provide identification and other personal details before receiving their new numbers. This information is stored in user account directories retained by the service provider. Reverse phone lookup or phone number search services query carrier user directories and return information on the numbers submitted for searching. A reverse phone search is useful for answering the question &quot;who called me?&quot; when you receive a call from an unknown number.<p>', california: '<span>California Reverse Phone Lookup</span><p>Reverse phone search is a phone-based information retrieval technique that involves finding information about an individual or business from their phone numbers. These phone lookup services check their databases for phone number registration histories such as name, address, and other related information. Learning this information can help recipients determine whether to answer or call back a number or not.<p>', newhampshire: '<span>New Hampshire Reverse Phone Lookup</span><p>Reverse phone lookup is the process of searching a phone number to discover more details about the owner of the number. Using a reverse phone search to find information on the owner of any telephone number is possible because important data on the owner is collected and stored in the carrier&#39;s database before it is assigned and activated. Such carrier databases are consulted when residents of New Hampshire carry out reverse phone searches to identify unknown callers.\n<p>', newmexico: '<span>New Mexico Reverse Phone Lookup</span><p>Reverse phone search or phone lookup is the process of searching a phone number in online directories to identify the owner. Some online web pages maintain unique search engines that allow users to know more about the owners of unknown phone numbers calling them. Using the information provided, researchers may then decide whether to ring back the caller or simply ignore their call.<p>', oklahoma: '<span>Oklahoma Reverse Phone Lookup</span><p>Reverse phone lookup involves identifying an unknown caller by their phone number. Carrier directories and other databases of subscriber information make reverse phone searches possible. When registering new phone numbers, carriers collect identifying information from new subscribers. When searching an Oklahoma phone number using a lookup tool, the reverse phone lookup service consults the databases of all major carriers operating in the state. Identifying unknown callers can help Oklahoma residents avoid phone scams, spam calls, and robocalls.<p>', texas: '<span>Texas Reverse Phone Lookup</span><p>Reverse phone search, or phone number lookup, refers to the process in which an individual can discover more about the person behind a phone number. Because paperwork and other information is required to be provided when being granted a phone number, it is possible to learn more about the individual calling you simply by using the phone number they used to call. <p>', vermont: '<span>Vermont Reverse Phone Lookup</span><p>Reverse phone lookup, or reverse phone search, allows you to find out who owns unknown numbers calling you. These searches are essential everytime you receive unknown phone calls from mobile, landline, or VoIP numbers bearing Vermont area codes. Performing reverse phone search sheds more light on whether a caller is a scammer, an offender, someone you would rather not talk to, or perhaps a family or old friend that acquired a new number. Reverse phone search engines provide detailed information about unknown numbers including the owner&#39;s name and listed address.<p>', alabama: '<span>Alabama Reverse Phone Lookup</span><p>Reverse phone lookup is a procedure for retrieving user information for a telephone number. Also referred to as phone number search, it is a search process that returns the information registered by the person who acquired the phone number. Anyone who purchases a phone line is required to provide a form of identification and relevant user information which is registered in a user account directory. Reverse phone lookup or phone number search provides access to this directory and the information stored in it, typically to verify the owner of an unknown number.<p>', washington: '<span>Washington Reverse Phone Lookup</span><p>Reverse phone lookup is a process whereby individuals try to learn about unknown phone numbers that called them, using third-party services. Also known as reverse phone search, it searches and returns information about the person who registered a phone number. When applying for phone numbers, subscriber information must be provided which will include identification and contact details. A reverse phone search accesses this information and can provide an answer to the question &quot;who is this number registered to&quot;?<p>', arizona: '<span>Arizona Reverse Phone Lookup</span><p>Performing a reverse phone lookup is a way of getting to know the identity of the owner of a particular phone number by searching with just the phone number. One major distinction between carrying out a reverse phone lookup and looking up a regular directory is that in this case, the phone number is used for the search. This brings up other information about the owner of any number. This subscriber information is provided when registering a new phone number. It includes the name and address of the individual assigned the number. These details are provided when conducting a reverse phone lookup on a phone number.\n<p>', arkansas: '<span>Arkansas Reverse Phone Lookup</span><p>Reverse phone lookup is the process of identifying an unknown caller by searching with the number. It is a way to find information about a caller whose number is not stored in the recipient&#39;s phone. Reverse phone number lookup pulls information from telephone registration records of subscribers maintained by carriers.\n<p>', colorado: '<span>Colorado Reverse Phone Lookup</span><p>A phone number lookup or reverse phone search refers to the act of retrieving the registrant&#39;s details for a number that called you. These details include the name of the registrant, their home or office address, and other pertinent details. Subscribers are required to provide these details when registering new numbers and reverse phone lookups provide access to search and retrieve such information.<p>', delaware: '<span>Delaware Reverse Phone Lookup</span><p>Reverse phone lookup is a way of finding people and businesses using their phone numbers alone. With spam and scam calls becoming rampant, most people are reluctant to pick calls from unrecognized numbers. Knowing the true identity of an unknown caller is one of the various reasons why someone may decide to perform a reverse phone search. Phone number lookup services have extensive access to phone subscriber information and can return detailed search results when queried with Delaware phone numbers.<p>', districtofcolumbia: '<span>District of Columbia Reverse Phone Lookup</span><p>Reverse phone search or phone number lookup is a way of using a phone number to obtain more information about the owner. The usual procedure of looking up a standard phone directory is to use the subscriber&#39;s name and address to get the phone number. In reverse phone search, it is the phone number used to discover details like the name, gender, address, and other publicly available records about the subscriber that owns the number. This is possible because of the data collated during the registration process required when obtaining a new number. Phone lookups bring up these details when residents of the District of Columbia submit phone numbers to their search engines.<p>', georgia: '<span>Georgia Reverse Phone Lookup</span><p>Reverse phone search or phone number lookup is a way of getting the name of someone and possibly, their personal details from a phone number. There are online phone number lookup services that can retrieve registration information when provided with phone numbers. Understanding how these lookup services work and how you can use them to your advantage is needed to identify malicious callers.<p>', hawaii: '<span>Hawaii Reverse Phone Lookup</span><p>Reverse phone search, otherwise called phone number lookup, is the process of discovering more details about the person a phone number is registered to, using just the phone number. Identifying the owner of a phone number in this way is possible because carriers require new subscribers to provide certain information when registering their numbers. Hawaiians can use phone lookup services to identify unknown callers and avoid phone scammers and spam calls.<p>', idaho: '<span>Idaho Reverse Phone Lookup</span><p>A reverse phone lookup is a process of learning the ownership details attached to an unknown telephone number. It is also referred to as a phone number lookup. These details are required during the process of applying for a phone number and stored in the carrier&#39;s user directory. Details will typically include names, home or office addresses, social security numbers, and other pertinent information. A reverse phone search provides access to the user directory to retrieve the available information on the phone number being looked up.<p>', illinois: '<span>Illinois Reverse Phone Lookup</span><p>Reverse phone search or phone number lookup describes being able to search and retrieve customer information for telephone service numbers. One reason for doing this is identifying an unknown caller. Information provided to phone service providers when procuring the phone numbers are available in directories are accessible by vendors providing reverse phone searches.<p>', iowa: '<span>Iowa Reverse Phone Lookup</span><p>Reverse phone lookup, or reverse phone search, is a report that shows the individual or business associated with a phone number. This report is essential whenever you receive a phone call from a phone number bearing Iowa area code that you do not recognize and want to find out if it is a scam or a spam number, or maybe a phone number owned by a person you know. Reverse phone lookup can be performed for all phone numbers, including landlines, cell phone numbers, and VoIP numbers. Most comprehensive reverse phone search engines provide detailed information, which can include the unknown caller&#39;s full name, their address, and other secondary information.<p>', kentucky: '<span>Kentucky Reverse Phone Lookup</span><p>Reverse phone search or phone number lookup describes the process through which one can get vital information about the identity of the person registered to a telephone number. This is made possible because every subscriber is required to supply their biodata for the purpose of verification when registering a new phone line.<p>', maine: '<span>Maine Reverse Phone Lookup</span><p>Reverse phone lookup refers to searching with a phone number to identify an unknown caller. Phone lookup services allow anyone to find callers using only their phone numbers. In addition to the caller&#39;s name and address, a reverse phone lookup may also find other details such as gender, phone type, and social media accounts. Therefore, a reverse phone search can help you answer the question: &quot;who called me?&quot; and can be used in certain cases to conduct a soft background check.<p>', massachusetts: '<span>Massachusetts Reverse Phone Lookup</span><p>Reverse phone lookup, also known as reverse phone search, refers to the process of retrieving the personal information attached to a registered phone number. Certain information like the caller&#39;s name and residential address can be accessed. Information provided as a requirement for obtaining a registered phone number makes reverse phone lookup possible.<p>', wisconsin: '<span>Wisconsin Reverse Phone Lookup</span><p>A reverse phone search or phone lookup is the act of searching through a reverse phone directory for the ownership details of a phone number. When applying for a phone number, some of the mandatory details provided include basic information such as a full name and an address. Therefore, if you can recollect the phone number you were called with, you will be able to answer the question &quot;who called me?&quot;<p>', missouri: '<span>Missouri Reverse Phone Lookup</span><p>Reverse phone lookups describe the process of searching and retrieving user details for telephone service numbers. When acquiring their phone numbers, users are required to fill out application forms to record their personal information including names and addresses. A reverse phone search, also referred to as phone number lookup, is the process of retrieving this information. The identification of whom a number is registered to is one of the most common reasons for doing this.\n<p>'};
        const addPost = (() => {
            // @Intermedia added subdomain in post add
            data.domain = process.env.subdomain
            data.custom_excerpt = sidebars[process.env.subdomain]
            data.feature_image = `https://cdn.staterecords.org/pn_logos/${process.env.subdomain}.png`
            return ghostBookshelf.Model.add.call(this, data, options)
                .then((post) => {
                    return this.findOne({
                        status: 'all',
                        id: post.id
                    }, _.merge({transacting: options.transacting}, unfilteredOptions));
                });
        });

        if (!options.transacting) {
            return ghostBookshelf.transaction((transacting) => {
                options.transacting = transacting;

                return addPost();
            });
        }

        return addPost();
    },

    destroy: function destroy(unfilteredOptions) {
        let options = this.filterOptions(unfilteredOptions, 'destroy', {extraAllowedProperties: ['id']});

        const destroyPost = () => {
            return ghostBookshelf.Model.destroy.call(this, options);
        };

        if (!options.transacting) {
            return ghostBookshelf.transaction((transacting) => {
                options.transacting = transacting;
                return destroyPost();
            });
        }

        return destroyPost();
    },

    // NOTE: the `authors` extension is the parent of the post model. It also has a permissible function.
    permissible: function permissible(postModel, action, context, unsafeAttrs, loadedPermissions, hasUserPermission, hasApiKeyPermission) {
        let isContributor;
        let isOwner;
        let isAdmin;
        let isEditor;
        let isIntegration;
        let isEdit;
        let isAdd;
        let isDestroy;

        function isChanging(attr) {
            return unsafeAttrs[attr] && unsafeAttrs[attr] !== postModel.get(attr);
        }

        function isPublished() {
            return unsafeAttrs.status && unsafeAttrs.status !== 'draft';
        }

        function isDraft() {
            return postModel.get('status') === 'draft';
        }

        isContributor = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Contributor'});
        isOwner = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Owner'});
        isAdmin = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Administrator'});
        isEditor = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Editor'});
        isIntegration = loadedPermissions.apiKey && _.some(loadedPermissions.apiKey.roles, {name: 'Admin Integration'});

        isEdit = (action === 'edit');
        isAdd = (action === 'add');
        isDestroy = (action === 'destroy');

        if (isContributor && isEdit) {
            // Only allow contributor edit if status is changing, and the post is a draft post
            hasUserPermission = !isChanging('status') && isDraft();
        } else if (isContributor && isAdd) {
            // If adding, make sure it's a draft post and has the correct ownership
            hasUserPermission = !isPublished();
        } else if (isContributor && isDestroy) {
            // If destroying, only allow contributor to destroy their own draft posts
            hasUserPermission = isDraft();
        } else if (!(isOwner || isAdmin || isEditor || isIntegration)) {
            hasUserPermission = !isChanging('visibility');
        }

        const excludedAttrs = [];
        if (isContributor) {
            // Note: at the moment primary_tag is a computed field,
            // meaning we don't add it to this list. However, if the primary_tag/primary_author
            // ever becomes a db field rather than a computed field, add it to this list
            // TODO: once contributors are able to edit existing tags, this can be removed
            // @TODO: we need a concept for making a diff between incoming tags and existing tags
            excludedAttrs.push('tags');
        }

        if (hasUserPermission && hasApiKeyPermission) {
            return Promise.resolve({excludedAttrs});
        }

        return Promise.reject(new errors.NoPermissionError({
            message: i18n.t('errors.models.post.notEnoughPermission')
        }));
    }
});

Posts = ghostBookshelf.Collection.extend({
    model: Post
});

// Extension for handling the logic for author + multiple authors
Post = relations.authors.extendModel(Post, Posts, ghostBookshelf);

module.exports = {
    Post: ghostBookshelf.model('Post', Post),
    Posts: ghostBookshelf.collection('Posts', Posts)
};
