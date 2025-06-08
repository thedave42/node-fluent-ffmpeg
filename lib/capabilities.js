/*jshint node:true*/
'use strict';

var fs = require('fs');
var path = require('path');
var async = require('async');
var utils = require('./utils');
var exec = require('child_process').exec;

/*
 *! Capability helpers
 */

var avCodecRegexp = /^\s*([D ])([E ])([VAS])([S ])([D ])([T ]) ([^ ]+) +(.*)$/;
var ffCodecRegexp = /^\s*([D\.])([E\.])([VAS])([I\.])([L\.])([S\.]) ([^ ]+) +(.*)$/;
var ffEncodersRegexp = /\(encoders:([^\)]+)\)/;
var ffDecodersRegexp = /\(decoders:([^\)]+)\)/;
var encodersRegexp = /^\s*([VAS\.])([F\.])([S\.])([X\.])([B\.])([D\.]) ([^ ]+) +(.*)$/;
var formatRegexp = /^\s*([D ])([E ])\s+([^ ]+)\s+(.*)$/;
var lineBreakRegexp = /\r\n|\r|\n/;
var filterRegexp = /^... ([^ ]+) +(AA?|VV?|N|\|)->(AA?|VV?|N|\|) +(.*)$/;

var cache = {};

module.exports = function (proto) {
  /**
   * Manually define the ffmpeg binary full path.
   *
   * @method FfmpegCommand#setFfmpegPath
   *
   * @param {String} ffmpegPath The full path to the ffmpeg binary.
   * @return FfmpegCommand
   */
  proto.setFfmpegPath = function (ffmpegPath) {
    cache.ffmpegPath = ffmpegPath;
    return this;
  };

  /**
   * Manually define the ffprobe binary full path.
   *
   * @method FfmpegCommand#setFfprobePath
   *
   * @param {String} ffprobePath The full path to the ffprobe binary.
   * @return FfmpegCommand
   */
  proto.setFfprobePath = function (ffprobePath) {
    cache.ffprobePath = ffprobePath;
    return this;
  };

  /**
   * Manually define the flvtool2/flvmeta binary full path.
   *
   * @method FfmpegCommand#setFlvtoolPath
   *
   * @param {String} flvtool The full path to the flvtool2 or flvmeta binary.
   * @return FfmpegCommand
   */
  proto.setFlvtoolPath = function (flvtool) {
    cache.flvtoolPath = flvtool;
    return this;
  };

  /**
   * Forget executable paths
   *
   * (only used for testing purposes)
   *
   * @method FfmpegCommand#_forgetPaths
   * @private
   */
  proto._forgetPaths = function () {
    delete cache.ffmpegPath;
    delete cache.ffprobePath;
    delete cache.flvtoolPath;
  };

  /**
   * Check for ffmpeg availability
   *
   * If the FFMPEG_PATH environment variable is set, try to use it.
   * If it is unset or incorrect, try to find ffmpeg in the PATH instead.
   *
   * @method FfmpegCommand#_getFfmpegPath
   * @param {Function} callback callback with signature (err, path)
   * @private
   */
  proto._getFfmpegPath = function (callback) {
    if ('ffmpegPath' in cache) {
      // If path is empty string, it means it was not found in previous calls.
      if (cache.ffmpegPath === '') {
        return callback(new Error('ffmpeg not found'));
      }
      return callback(null, cache.ffmpegPath);
    }

    async.waterfall([
      // Try FFMPEG_PATH
      function (cb) {
        if (process.env.FFMPEG_PATH) {
          // fs.exists is deprecated, use fs.stat or fs.access instead
          fs.stat(process.env.FFMPEG_PATH, function (err, stats) {
            if (err) {
              // File does not exist or other error
              return cb(null, '');
            }
            if (stats.isFile()) {
              cb(null, process.env.FFMPEG_PATH);
            } else {
              cb(null, '');
            }
          });
        } else {
          cb(null, '');
        }
      },

      // Search in the PATH
      function (ffmpeg, cb) {
        if (ffmpeg.length) {
          return cb(null, ffmpeg);
        }

        utils.which('ffmpeg', function (err, ffmpegPath) {
          // which returns an error if not found, pass it along
          if (err) {
            // if not found, set ffmpegPath to empty string
            return cb(null, '');
          }
          cb(err, ffmpegPath);
        });
      }
    ], function (err, ffmpeg) {
      if (err) {
        // Pass error to the main callback
        callback(err);
      } else {
        if (!ffmpeg || ffmpeg.length === 0) {
          cache.ffmpegPath = ''; // Cache that it's not found
          return callback(new Error('ffmpeg not found'));
        }
        callback(null, cache.ffmpegPath = ffmpeg);
      }
    });
  };


  /**
   * Check for ffprobe availability
   *
   * If the FFPROBE_PATH environment variable is set, try to use it.
   * If it is unset or incorrect, try to find ffprobe in the PATH instead.
   * If this still fails, try to find ffprobe in the same directory as ffmpeg.
   *
   * @method FfmpegCommand#_getFfprobePath
   * @param {Function} callback callback with signature (err, path)
   * @private
   */
  proto._getFfprobePath = function (callback) {
    var self = this;

    if ('ffprobePath' in cache) {
      return callback(null, cache.ffprobePath);
    }

    async.waterfall([
      // Try FFPROBE_PATH
      function (cb) {
        if (process.env.FFPROBE_PATH) {
          fs.stat(process.env.FFPROBE_PATH, function (err, stats) {
            if (err) {
              return cb(null, '');
            }
            cb(null, stats.isFile() ? process.env.FFPROBE_PATH : '');
          });
        } else {
          cb(null, '');
        }
      },

      // Search in the PATH
      function (ffprobe, cb) {
        if (ffprobe.length) {
          return cb(null, ffprobe);
        }

        utils.which('ffprobe', function (err, ffprobePath) {
          cb(err, ffprobePath);
        });
      },

      // Search in the same directory as ffmpeg
      function (ffprobe, cb) {
        if (ffprobe && ffprobe.length) {
          return cb(null, ffprobe);
        }

        self._getFfmpegPath(function (err, ffmpeg) {
          if (err) {
            cb(err);
          } else if (ffmpeg && ffmpeg.length) {
            var name = utils.isWindows ? 'ffprobe.exe' : 'ffprobe';
            var ffprobePath = path.join(path.dirname(ffmpeg), name);
            fs.stat(ffprobePath, function (err, stats) {
              if (err) {
                return cb(null, '');
              }
              cb(null, stats.isFile() ? ffprobePath : '');
            });
          } else {
            cb(null, '');
          }
        });
      }
    ], function (err, ffprobe) {
      if (err) {
        callback(err);
      } else {
        callback(null, cache.ffprobePath = (ffprobe || ''));
      }
    });
  };


  /**
   * Check for flvtool2/flvmeta availability
   *
   * If the FLVTOOL2_PATH or FLVMETA_PATH environment variable are set, try to use them.
   * If both are either unset or incorrect, try to find flvtool2 or flvmeta in the PATH instead.
   *
   * @method FfmpegCommand#_getFlvtoolPath
   * @param {Function} callback callback with signature (err, path)
   * @private
   */
  proto._getFlvtoolPath = function (callback) {
    if ('flvtoolPath' in cache) {
      return callback(null, cache.flvtoolPath);
    }

    async.waterfall([
      // Try FLVMETA_PATH
      function (cb) {
        if (process.env.FLVMETA_PATH) {
          fs.stat(process.env.FLVMETA_PATH, function (err, stats) {
            if (err) {
              return cb(null, '');
            }
            cb(null, stats.isFile() ? path.normalize(process.env.FLVMETA_PATH) : '');
          });
        } else {
          cb(null, '');
        }
      },

      // Try FLVTOOL2_PATH
      function (flvtool, cb) {
        if (flvtool && flvtool.length) {
          return cb(null, flvtool);
        }

        if (process.env.FLVTOOL2_PATH) {
          fs.stat(process.env.FLVTOOL2_PATH, function (err, stats) {
            if (err) {
              return cb(null, '');
            }
            cb(null, stats.isFile() ? path.normalize(process.env.FLVTOOL2_PATH) : '');
          });
        } else {
          cb(null, '');
        }
      },

      // Search for flvmeta in the PATH
      function (flvtool, cb) {
        if (flvtool && flvtool.length) {
          return cb(null, flvtool);
        }

        utils.which('flvmeta', function (err, flvmetaPath) {
          if (err) return cb(null, ''); // Don't error if not found, just pass empty
          cb(null, (flvmetaPath && flvmetaPath.length) ? path.normalize(flvmetaPath) : '');
        });
      },

      // Search for flvtool2 in the PATH
      function (flvtool, cb) {
        if (flvtool && flvtool.length) {
          return cb(null, flvtool);
        }

        utils.which('flvtool2', function (err, flvtool2Path) {
          if (err) return cb(null, ''); // Don't error if not found, just pass empty
          cb(null, (flvtool2Path && flvtool2Path.length) ? path.normalize(flvtool2Path) : '');
        });
      },
    ], function (err, flvtool) {
      // async.waterfall's final callback always receives an err argument (null if no error)
      if (err) {
        callback(err);
      } else {
        callback(null, cache.flvtoolPath = (flvtool || ''));
      }
    });
  };


  /**
   * A callback passed to {@link FfmpegCommand#availableFilters}.
   *
   * @callback FfmpegCommand~filterCallback
   * @param {Error|null} err error object or null if no error happened
   * @param {Object} filters filter object with filter names as keys and the following
   *   properties for each filter:
   * @param {String} filters.description filter description
   * @param {String} filters.input input type, one of 'audio', 'video' and 'none'
   * @param {Boolean} filters.multipleInputs whether the filter supports multiple inputs
   * @param {String} filters.output output type, one of 'audio', 'video' and 'none'
   * @param {Boolean} filters.multipleOutputs whether the filter supports multiple outputs
   */

  /**
   * Query ffmpeg for available filters
   *
   * @method FfmpegCommand#availableFilters
   * @category Capabilities
   * @aliases getAvailableFilters
   *
   * @param {FfmpegCommand~filterCallback} callback callback function
   */
  proto.availableFilters =
    proto.getAvailableFilters = function (callback) {
      if ('filters' in cache) {
        return callback(null, cache.filters);
      }

      this._getFfmpegPath(function (err, command) {
        if (err) {
          return callback(err);
        }
        if (!command) {
          return callback(new Error('ffmpeg command not found'));
        }

        exec(command + ' -filters', { maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            return callback(err);
          }

          if (stderr && stderr.length > 0) {
            // Keep only the last line
            var lastLine = stderr.split(lineBreakRegexp).pop();

            // Ignore lines that look like warnings
            if (lastLine && lastLine.length > 0 && lastLine.indexOf('Warning') !== 0 && lastLine.indexOf('NOTE:') !== 0) {
              return callback(new Error('ffmpeg returned error: ' + lastLine));
            }
          }

          var lines = stdout.toString().split(lineBreakRegexp);
          var filters = {};
          lines.forEach(function (line) {
            var match = line.match(filterRegexp);
            if (match && match[1] !== 'filter') {
              filters[match[1]] = {
                description: match[4].trim(),
                input: (match[2] === 'N' ? 'none' : (match[2].indexOf('A') > -1 ? 'audio' : 'video')),
                multipleInputs: match[2].length > 1,
                output: (match[3] === 'N' ? 'none' : (match[3].indexOf('A') > -1 ? 'audio' : 'video')),
                multipleOutputs: match[3].length > 1
              };
            }
          });

          cache.filters = filters;
          callback(null, filters);
        });
      });
    };


  /**
   * A callback passed to {@link FfmpegCommand#availableCodecs}.
   *
   * @callback FfmpegCommand~codecCallback
   * @param {Error|null} err error object or null if no error happened
   * @param {Object} codecs codec object with codec names as keys and the following
   *   properties for each codec (more properties may be available depending on the
   *   ffmpeg version used):
   * @param {String} codecs.description codec description
   * @param {Boolean} codecs.canDecode whether the codec is able to decode streams
   * @param {Boolean} codecs.canEncode whether the codec is able to encode streams
   */

  /**
   * Query ffmpeg for available codecs
   *
   * @method FfmpegCommand#availableCodecs
   * @category Capabilities
   * @aliases getAvailableCodecs
   *
   * @param {FfmpegCommand~codecCallback} callback callback function
   */
  proto.availableCodecs =
    proto.getAvailableCodecs = function (callback) {
      if ('codecs' in cache) {
        return callback(null, cache.codecs);
      }

      this._getFfmpegPath(function (err, command) {
        if (err) {
          return callback(err);
        }
        if (!command) {
          return callback(new Error('ffmpeg command not found'));
        }

        // Check if we are using a custom ffmpeg version (like ffplay)
        var isAvconv = command.indexOf('avconv') !== -1;
        var isLibav = command.indexOf('libav-tools') !== -1; // Older libav-tools

        exec(command + ' -codecs', { maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            return callback(err);
          }

          if (stderr && stderr.length > 0) {
            // Keep only the last line
            var lastLine = stderr.split(lineBreakRegexp).pop();

            // Ignore lines that look like warnings
            if (lastLine && lastLine.length > 0 && lastLine.indexOf('Warning') !== 0 && lastLine.indexOf('NOTE:') !== 0) {
              return callback(new Error('ffmpeg returned error: ' + lastLine));
            }
          }

          var lines = stdout.toString().split(lineBreakRegexp);
          var codecs = {};
          lines.forEach(function (line) {
            var match = line.match(avCodecRegexp);
            if (match) {
              // avconv uses a different output format for -codecs
              codecs[match[7]] = {
                type: {
                  'V': 'video',
                  'A': 'audio',
                  'S': 'subtitle'
                }[match[3]],
                description: match[8],
                canDecode: match[1] === 'D',
                canEncode: match[2] === 'E'
              };
            } else {
              match = line.match(ffCodecRegexp);
              if (match) {
                // ffmpeg uses a different output format for -codecs
                codecs[match[7]] = {
                  type: {
                    'V': 'video',
                    'A': 'audio',
                    'S': 'subtitle'
                  }[match[3]],
                  description: match[8],
                  canDecode: match[1] === 'D',
                  canEncode: match[2] === 'E',
                  drawHorizBand: match[4] === 'I',
                  directRendering: match[5] === 'L',
                  weirdFrameTruncation: match[6] === 'S'
                };
              }
            }
          });

          cache.codecs = codecs;
          callback(null, codecs);
        });
      });
    };


  /**
   * A callback passed to {@link FfmpegCommand#availableEncoders}.
   *
   * @callback FfmpegCommand~encodersCallback
   * @param {Error|null} err error object or null if no error happened
   * @param {Object} encoders encoders object with encoder names as keys and the following
   *   properties for each encoder:
   * @param {String} encoders.description codec description
   * @param {Boolean} encoders.type "audio", "video" or "subtitle"
   * @param {Boolean} encoders.frameMT whether the encoder is able to do frame-level multithreading
   * @param {Boolean} encoders.sliceMT whether the encoder is able to do slice-level multithreading
   * @param {Boolean} encoders.experimental whether the encoder is experimental
   * @param {Boolean} encoders.drawHorizBand whether the encoder supports draw_horiz_band
   * @param {Boolean} encoders.directRendering whether the encoder supports direct encoding method 1
   */

  /**
   * Query ffmpeg for available encoders
   *
   * @method FfmpegCommand#availableEncoders
   * @category Capabilities
   * @aliases getAvailableEncoders
   *
   * @param {FfmpegCommand~encodersCallback} callback callback function
   */
  proto.availableEncoders =
    proto.getAvailableEncoders = function (callback) {
      if ('encoders' in cache) {
        return callback(null, cache.encoders);
      }

      this._getFfmpegPath(function (err, command) {
        if (err) {
          return callback(err);
        }
        if (!command) {
          return callback(new Error('ffmpeg command not found'));
        }

        exec(command + ' -encoders', { maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            return callback(err);
          }

          if (stderr && stderr.length > 0) {
            // Keep only the last line
            var lastLine = stderr.split(lineBreakRegexp).pop();

            // Ignore lines that look like warnings
            if (lastLine && lastLine.length > 0 && lastLine.indexOf('Warning') !== 0 && lastLine.indexOf('NOTE:') !== 0) {
              return callback(new Error('ffmpeg returned error: ' + lastLine));
            }
          }

          var lines = stdout.toString().split(lineBreakRegexp);
          var encoders = {};
          lines.forEach(function (line) {
            var match = line.match(encodersRegexp);
            if (match) {
              encoders[match[7]] = {
                type: {
                  'V': 'video',
                  'A': 'audio',
                  'S': 'subtitle'
                }[match[1]],
                description: match[8],
                frameMT: match[2] === 'F',
                sliceMT: match[3] === 'S',
                experimental: match[4] === 'X',
                drawHorizBand: match[5] === 'B',
                directRendering: match[6] === 'D'
              };
            }
          });

          cache.encoders = encoders;
          callback(null, encoders);
        });
      });
    };


  /**
   * A callback passed to {@link FfmpegCommand#availableFormats}.
   *
   * @callback FfmpegCommand~formatCallback
   * @param {Error|null} err error object or null if no error happened
   * @param {Object} formats format object with format names as keys and the following
   *   properties for each format:
   * @param {String} formats.description format description
   * @param {Boolean} formats.canDemux whether the format is able to demux streams from an input file
   * @param {Boolean} formats.canMux whether the format is able to mux streams into an output file
   */

  /**
   * Query ffmpeg for available formats
   *
   * @method FfmpegCommand#availableFormats
   * @category Capabilities
   * @aliases getAvailableFormats
   *
   * @param {FfmpegCommand~formatCallback} callback callback function
   */
  proto.availableFormats =
    proto.getAvailableFormats = function (callback) {
      if ('formats' in cache) {
        return callback(null, cache.formats);
      }

      this._getFfmpegPath(function (err, command) {
        if (err) {
          return callback(err);
        }
        if (!command) {
          return callback(new Error('ffmpeg command not found'));
        }

        exec(command + ' -formats', { maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            return callback(err);
          }

          if (stderr && stderr.length > 0) {
            // Keep only the last line
            var lastLine = stderr.split(lineBreakRegexp).pop();

            // Ignore lines that look like warnings
            if (lastLine && lastLine.length > 0 && lastLine.indexOf('Warning') !== 0 && lastLine.indexOf('NOTE:') !== 0) {
              return callback(new Error('ffmpeg returned error: ' + lastLine));
            }
          }

          var lines = stdout.toString().split(lineBreakRegexp);
          var formats = {};
          lines.forEach(function (line) {
            var match = line.match(formatRegexp);
            if (match) {
              formats[match[3]] = {
                description: match[4],
                canDemux: match[1] === 'D',
                canMux: match[2] === 'E'
              };
            }
          });

          cache.formats = formats;
          callback(null, formats);
        });
      });
    };


  /**
   * Check capabilities before executing a command
   *
   * Checks whether all used codecs and formats are indeed available
   *
   * @method FfmpegCommand#_checkCapabilities
   * @param {Function} callback callback with signature (err)
   * @private
   */
  proto._checkCapabilities = function (callback) {
    var self = this;
    async.waterfall([
      // Get available formats
      function (cb) {
        self.availableFormats(cb);
      },

      // Check whether specified formats are available
      function (formats, cb) {
        var unavailable;

        // Output format(s)
        unavailable = self._outputs
          .reduce(function (fmts, output) {
            var format = output.options.find('-f', 1);
            if (format) {
              if (!(format[0] in formats) || !(formats[format[0]].canMux)) {
                fmts.push(format);
              }
            }

            return fmts;
          }, []);

        if (unavailable.length === 1) {
          return cb(new Error('Output format ' + unavailable[0] + ' is not available'));
        } else if (unavailable.length > 1) {
          return cb(new Error('Output formats ' + unavailable.join(', ') + ' are not available'));
        }

        // Input format(s)
        unavailable = self._inputs
          .reduce(function (fmts, input) {
            var format = input.options.find('-f', 1);
            if (format) {
              if (!(format[0] in formats) || !(formats[format[0]].canDemux)) {
                fmts.push(format[0]);
              }
            }

            return fmts;
          }, []);

        if (unavailable.length === 1) {
          return cb(new Error('Input format ' + unavailable[0] + ' is not available'));
        } else if (unavailable.length > 1) {
          return cb(new Error('Input formats ' + unavailable.join(', ') + ' are not available'));
        }

        cb();
      },

      // Get available codecs
      function (cb) {
        self.availableEncoders(cb);
      },

      // Check whether specified codecs are available and add strict experimental options if needed
      function (encoders, cb) {
        var unavailable;

        // Audio codec(s)
        unavailable = self._outputs.reduce(function (cdcs, output) {
          var acodec = output.audio.find('-acodec', 1);
          if (acodec && acodec[0] !== 'copy') {
            if (!(acodec[0] in encoders) || encoders[acodec[0]].type !== 'audio') {
              cdcs.push(acodec[0]);
            }
          }

          return cdcs;
        }, []);

        if (unavailable.length === 1) {
          return cb(new Error('Audio codec ' + unavailable[0] + ' is not available'));
        } else if (unavailable.length > 1) {
          return cb(new Error('Audio codecs ' + unavailable.join(', ') + ' are not available'));
        }

        // Video codec(s)
        unavailable = self._outputs.reduce(function (cdcs, output) {
          var vcodec = output.video.find('-vcodec', 1);
          if (vcodec && vcodec[0] !== 'copy') {
            if (!(vcodec[0] in encoders) || encoders[vcodec[0]].type !== 'video') {
              cdcs.push(vcodec[0]);
            }
          }

          return cdcs;
        }, []);

        if (unavailable.length === 1) {
          return cb(new Error('Video codec ' + unavailable[0] + ' is not available'));
        } else if (unavailable.length > 1) {
          return cb(new Error('Video codecs ' + unavailable.join(', ') + ' are not available'));
        }

        cb();
      }
    ], callback);
  };

  /**
   * Check capabilities before executing a command
   *
   * Checks whether all used codecs and formats are indeed available
   *
   * @method FfmpegCommand#checkCapabilities
   * @param {Function} callback callback with signature (err, capabilities)
   */
  proto.checkCapabilities = function (callback) {
    var self = this;

    async.parallel({
      filters: this.availableFilters.bind(this),
      codecs: this.availableCodecs.bind(this),
      formats: this.availableFormats.bind(this),
      encoders: this.availableEncoders.bind(this)
    }, function (err, capabilities) {
      if (err) {
        callback(err);
      } else {
        self.ffmpegCapabilities = capabilities;
        callback(null, capabilities);
      }
    });
  };
};
