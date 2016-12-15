/*
 * (C) Copyright 2016 o2r project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

const config = require('../config/config');
const debug = require('debug')('muncher:uploader');
const exec = require('child_process').exec;
const errorMessageHelper = require('../lib/error-message');
const clone = require('clone');
const nodemailer = require('nodemailer');

const Compendium = require('../lib/model/compendium');
const Stream = require('stream');
const path = require('path');
const fs = require('fs');

if (config.bagtainer.scan.enable) {
    debug('Using clamscan with configuration %s', JSON.stringify(clam.settings));
}

// create reusable transporter object using the default SMTP transport
var emailTransporter = null;
var clam = null;
if (config.bagtainer.scan.enable) {
    clam = require('clamscan')(config.bagtainer.scan.settings);
    debug('Virus scanning enabled: %s', JSON.stringify(config.bagtainer.scan.settings));
} else {
    debug('Virus scanning _disabled_');
}
if (config.bagtainer.scan.email.enable
    && config.bagtainer.scan.email.transport
    && config.bagtainer.scan.email.sender
    && config.bagtainer.scan.email.receivers) {

    emailTransporter = nodemailer.createTransport(config.bagtainer.scan.email.transport);
    debug('Sending emails on critical errors to %s', config.bagtainer.scan.email.receivers);
} else {
    debug('Email notification for virus detection _not_ active: %s', JSON.stringify(config.bagtainer.scan.email));
}


function unzip(passon) {
    return new Promise((fulfill, reject) => {
        debug('Unzipping %s', passon.id);

        var outputPath = path.join(config.fs.compendium, passon.id);
        var cmd = '';
        switch (passon.req.file.mimetype) {
            case 'application/zip':
                cmd = 'unzip -uq ' + passon.req.file.path + ' -d ' + outputPath;
                if (config.fs.delete_inc) { // should incoming files be deleted after extraction?
                    cmd += ' && rm ' + passon.req.file.path;
                }
                break;
            default:
                cmd = 'false';
        }

        debug('Unzipping command "%s"', cmd);
        exec(cmd, (error, stdout, stderr) => {
            if (error || stderr) {
                debug(error, stderr, stdout);
                let errors = error.message.split(':');
                let message = errorMessageHelper(errors[errors.length - 1]);
                passon.res.status(500).send(JSON.stringify({ error: 'extraction failed: ' + message }));
                reject(error);
            } else {
                passon.bagpath = outputPath;
                debug('Unzip of %s complete! Stored in %s', passon.id, passon.bagpath);
                fulfill(passon);
            }
        });
    });
}

function scan(passon) {
    return new Promise((fulfill, reject) => {
        if (!config.bagtainer.scan.enable) {
            fulfill(passon);
        } else if (!clam) {
            fulfill(passon);
        } else {
            debug('Scanning %s for viruses at path %s', passon.id, passon.bagpath);
            clam.scan_dir(passon.bagpath, (error, good, bad) => {
                if (error) {
                    debug(error);
                    reject(error);
                } else {
                    debug('Virus scan completed and had %s good and >> %s << bad files', good.length, bad.length);
                    if (bad.length > 0) {
                        debug('Virus found, deleting directory  %s', passon.bagpath);

                        let badfiles = bad.join('\n\t');
                        debug('Found bad files in:\n\t%s', badfiles);

                        exec('rm -r ' + passon.bagpath, (error, stdout, stderr) => {
                            if (error || stderr) {
                                debug(error, stderr, stdout);
                                debug('Error deleting compendium with virus. File deleted by virus checker? %s)',
                                    clam.settings.remove_infected);
                            } else {
                                debug('Deleted directory %s', passon.bagpath);
                            }

                            if (emailTransporter) {
                                let mail = {
                                    from: config.bagtainer.scan.email.sender, // sender address 
                                    to: config.bagtainer.scan.email.receivers,
                                    subject: '[o2r platform] a virus was detected during upload',
                                    text: 'A virus was detected in a compendium uploaded by user ' + passon.user +
                                    ' in these files:\n\n' + JSON.stringify(bad)
                                };

                                emailTransporter.sendMail(mail, function (error, info) {
                                    if (error) {
                                        debug('Problem sending notification email: %s', error.message);
                                    }
                                    debug('Email sent: %s\n%s', info.response, JSON.stringify(mail));
                                });
                            }

                            let msg = 'Virus scan found infected file(s) in directory'
                            let err = new Error(msg);
                            err.status = 422;
                            err.msg = msg;
                            reject(err);
                        });
                    } else {
                        debug('No viruses found in %s', passon.id);
                        fulfill(passon);
                    }
                }
            });
        }
    });
}

function extractMetadata(passon) {
    return new Promise((fulfill, reject) => {
        debug('Extracting metadata from %s', passon.id);

        // create stream for logging
        let logStream = Stream.Writable();
        logStream.compendium_id = passon.id;
        logStream._write = function (chunk, enc, next) {
            debug('[o2r-meta-extract] [%s] %s', passon.id, chunk);
            next();
        }

        let mountpoint = path.join('/', passon.id, config.bagtainer.payloadDirectory);
        let create_options = clone(config.bagtainer.metaextract.create_options);
        create_options.HostConfig = {};
        create_options.HostConfig.Binds = [
            path.join(passon.bagpath, config.bagtainer.payloadDirectory) + ':'
            + mountpoint + ':rw'
        ];
        let cmd = ['-i', mountpoint,
            '-o', path.join(mountpoint, config.bagtainer.metaextract.outputDir),
            '-m', // save all raw files
            '-e', passon.id // pass the erc id
        ];

        debug('[%s] Running container with command "%s" and options: %s',
            passon.id, cmd, JSON.stringify(create_options));
        passon.docker.run(config.bagtainer.metaextract.image,
            cmd,
            logStream,
            create_options,
            {},
            (err, data, container) => {
                if (err) {
                    debug('[o2r-meta-extract] [%s] Problem during container run: %s',
                        this.compendium_id, err.message);
                    reject(err);
                    return;
                }
                debug('[%s] Container exit code: %s | container id: %s', passon.id, data.StatusCode, container.id);
                passon.metaextract_container_id = container.id;

                if (data.StatusCode === 0) {
                    // check if metadata was found, if so put the metadata directory into passon
                    let metadataDirectory = path.join(passon.bagpath,
                        config.bagtainer.payloadDirectory,
                        config.bagtainer.metaextract.outputDir);
                    passon.metadata_dir = metadataDirectory;
                    fs.readdir(metadataDirectory, (err, files) => {
                        if (err) {
                            debug('[%s] Error reading metadata directory [fail the upload? %s]:\n\t%s', passon.id,
                                config.bagtainer.metaextract.failOnNoMetadata, err);
                            if (config.bagtainer.metaextract.failOnNoMetadata) {
                                reject(err);
                            } else {
                                debug('[%s] Continueing with empty metadata...', passon.id);
                                fulfill(passon);
                            }
                        } else if (files.length < 1) {
                            debug('[%s] Metadata extraction directory is empty [fail the upload? %s]:\n\t%s',
                                config.bagtainer.metaextract.failOnNoMetadata, err);
                            if (config.bagtainer.metaextract.failOnNoMetadata) {
                                reject(new Error('no files in the metadata extraction directory'));
                            } else {
                                debug('[%s] Continueing with empty metadata...', passon.id);
                                fulfill(passon);
                            }
                        } else {
                            debug('[%s] Extration created %s metadata files: %s', passon.id,
                                files.length, JSON.stringify(files));
                            fulfill(passon);
                        }
                    });
                } else {
                    debug('[%s] ERROR: metadata extraction container exited with %s', passon.id, data.StatusCode);
                    reject(passon);
                }
            });
    });
}

function loadMetadata(passon) {
    return new Promise((fulfill, reject) => {
        let mainMetadataFile = path.join(passon.metadata_dir, config.bagtainer.metaextract.bestCandidateFile);
        debug('[%s] Loading metadata from %s', passon.id, mainMetadataFile);

        fs.readFile(mainMetadataFile, (err, data) => {
            if (err) {
                debug('[%s] Error reading metadata file: %s [fail? %s]', passon.id, err.message,
                    config.bagtainer.metaextract.failOnNoMetadata);
                if (config.bagtainer.metaextract.failOnNoMetadata) {
                    reject(new Error('no metadata.json found in the metadata extraction directory'));
                } else {
                    debug('[%s] Continueing with empty metadata...', passon.id);
                    fulfill(passon);
                }
            } else {
                passon.metadata = {};
                passon.metadata[config.bagtainer.metaextract.targetElement] = JSON.parse(data);
                fulfill(passon);
            }
        });
    });
}

function brokerMetadata(passon) {
    return new Promise((fulfill, reject) => {
        debug('[%s] Brokering metadata', passon.id);

        // add some placeholders to show brokering happened
        passon.metadata.zenodo = { title: passon.metadata.o2r.title };
        passon.metadata.cris = { title: passon.metadata.o2r.title };
        passon.metadata.orcid = { title: passon.metadata.o2r.title };
        passon.metadata.datacite = { title: passon.metadata.o2r.title };

        fulfill(passon);
    });
}

function save(passon) {
    return new Promise((fulfill, reject) => {
        debug('[%s] Saving...', passon.id);
        var compendium = new Compendium({
            id: passon.id,
            user: passon.user,
            metadata: passon.metadata
        });

        compendium.save(err => {
            if (err) {
                debug('[%s] ERROR saving new compendium', passon.id);
                passon.res.status(500).send(JSON.stringify({ error: 'internal error' }));
                reject(err);
            } else {
                debug('[%s] Saved new compendium', passon.id);
                fulfill(passon);
            }
        });
    });
}

function cleanup(passon) {
    return new Promise((fulfill, reject) => {
        debug('Cleaning up after upload of %s', passon.id);

        if (passon.metaextract_container_id) {
            debug('Deleting metadata extraction container %s', passon.metaextract_container_id);

            var container = passon.docker.getContainer(passon.metaextract_container_id);
            container.remove(function (err, data) {
                if (err) {
                    debug('[%s] Error removing container %s', passon.id, passon.metaextract_container_id);
                    reject(passon);
                } else {
                    debug('[%s] Removed container %s %s', passon.id, passon.metaextract_container_id, data);
                    fulfill(passon);
                }
            });
        } else {
            fulfill(passon);
        }
    });
}

module.exports = {
    unzip: unzip,
    scan: scan,
    extractMetadata: extractMetadata,
    loadMetadata: loadMetadata,
    brokerMetadata: brokerMetadata,
    save: save,
    cleanup: cleanup
};