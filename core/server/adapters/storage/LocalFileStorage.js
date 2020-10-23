const Cloud = require('@google-cloud/storage')
const fs = require('fs-extra');
const config = require('../../../shared/config');
const StorageBase = require('ghost-storage-base');
const path  = require('path');
const Promise  = require('bluebird');
var options  = {};

const serviceKey = path.join(__dirname, './keys.json')

class LocalFileStore extends StorageBase {
    constructor() {

        super(config);
        options = config;
        const { Storage } = Cloud
        const gcs = new Storage({
            keyFilename: serviceKey,
            projectId: 'staterecords-197320',
        })
        this.bucket = gcs.bucket('cdn-ghost');
        this.assetDomain = `cdn-ghost.storage.googleapis.com`;
        if(options.hasOwnProperty('assetDomain')){
            this.insecure = options.insecure;
        }
        // default max-age is 3600 for GCS, override to something more useful
        this.maxAge = options.maxAge || 2678400;
    }

    /*saveRaw(buffer, targetPath) {
        const storagePath = path.join(this.storagePath, targetPath);
        const targetDir = path.dirname(storagePath);

        return fs.mkdirs(targetDir)
            .then(() => {
                return fs.writeFile(storagePath, buffer);
            })
            .then(() => {
                const fullUrl = (
                    urlUtils.urlJoin('/', urlUtils.getSubdir(),
                        urlUtils.STATIC_IMAGE_URL_PREFIX,
                        targetPath)
                ).replace(new RegExp(`\\${path.sep}`, 'g'), '/');

                return fullUrl;
            });
    }*/

    save(image) {
        if (!options) return Promise.reject('google cloud storage is not configured');

        var targetDir = this.getTargetDir(),
        googleStoragePath = `http${this.insecure?'':'s'}://${this.assetDomain}/`,
        targetFilename;

        return this.getUniqueFileName(image, targetDir).then(newFile => {
            targetFilename = newFile;
            var opts = {
                destination: newFile,
                metadata: {
                    cacheControl: `public, max-age=${this.maxAge}`
                },
                public: true
            };
            return this.bucket.upload(image.path, opts);
        }).then(function (data) {
            return googleStoragePath + targetFilename;
        }).catch(function (e) {
            return Promise.reject(e);
        });
    }

    exists(filename, targetDir) {
        return this.bucket
        .file(path.join(targetDir, filename))
        .exists()
        .then(function(data){
            return data[0];
        })
        .catch(err => Promise.reject(err));
    }

    serve() {
        return function (req, res, next) { next(); };
    }


    delete (filename) {
        return this.bucket.file(filename).delete();
    }

    read (filename) {
        var rs = this.bucket.file(filename).createReadStream(), contents = null;
        return new Promise(function (resolve, reject) {
            rs.on('error', function(err){
                return reject(err);
            });
            rs.on('data', function(data){
                if (contents) {
                    contents = data;
                } else {
                    contents = Buffer.concat([contents, data]);
                }
            });
            rs.on('end', function(){
                return resolve(content);
            });
      });
    }
}

module.exports = LocalFileStore;
