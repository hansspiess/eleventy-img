const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { URL } = require("url");
const { createHash } = require("crypto");
const {default: PQueue} = require("p-queue");
const base64url = require("base64url");
const getImageSize = require("image-size");
const sharp = require("sharp");
const debug = require("debug")("EleventyImg");

const svgHook = require("./format-hooks/svg");

const {RemoteAssetCache, queue} = require("@11ty/eleventy-cache-assets");
const FileSizeCache = require("./filesize-cache");

const globalOptions = {
  widths: [null],
  formats: ["webp", "jpeg"], // "png", "svg", "avif"
  concurrency: 10,
  urlPath: "/img/",
  outputDir: "img/",
  svgShortCircuit: false, // skip raster formats if SVG input is found
  svgAllowUpscale: true,
  // overrideInputFormat: false, // internal, used to force svg output in statsSync et al
  sharpOptions: {}, // options passed to the Sharp constructor
  sharpWebpOptions: {}, // options passed to the Sharp webp output method
  sharpPngOptions: {}, // options passed to the Sharp png output method
  sharpJpegOptions: {}, // options passed to the Sharp jpeg output method
  sharpAvifOptions: {}, // options passed to the Sharp avif output method
  extensions: {},
  formatHooks: {
    svg: svgHook,
  },
  cacheDuration: "1d", // deprecated, use cacheOptions.duration
  // disk cache for remote assets
  cacheOptions: {
    // duration: "1d",
    // directory: ".cache",
    // removeUrlQueryParams: false,
    // fetchOptions: {},
  },
  filenameFormat,

  // urlFormat allows you to return a full URL to an image including the domain.
  // Useful when you’re using your own hosted image service (probably via .statsSync or .statsByDimensionsSync)
  // Note: when you use this, metadata will not include .filename or .outputPath
  urlFormat: null,

  useCache: true, // in-memory cache
  dryRun: false, // Also returns a buffer instance in the return object. Doesn’t write anything to the file system
};

const MIME_TYPES = {
  "jpeg": "image/jpeg",
  "webp": "image/webp",
  "png": "image/png",
  "svg": "image/svg+xml",
  "avif": "image/avif",
};

const FORMAT_ALIASES = {
  "jpg": "jpeg"
};

class Image {
  constructor(src, options) {
    if(!src) {
      throw new Error("`src` is a required argument to the eleventy-img utility (can be a String file path, String URL, or Buffer).");
    }

    this.src = src;
    this.isRemoteUrl = typeof src === "string" && isFullUrl(src);
    this.options = this.getFullOptions(options);

    if(this.isRemoteUrl) {
      this.cacheOptions = Object.assign({
        duration: this.options.cacheDuration, // deprecated
        dryRun: this.options.dryRun, // Issue #117: re-use eleventy-img dryRun option value for eleventy-cache-assets dryRun
        type: "buffer"
      }, this.options.cacheOptions);

      this.assetCache = new RemoteAssetCache(src, this.cacheOptions.directory, this.cacheOptions);
    }
  }

  getFullOptions(options) {
    // TODO globalOptions are used in two places!
    let opts = Object.assign({}, globalOptions, options);

    // augment Options object with metadata for hashing
    opts.__originalSrc = this.src;

    if(this.isRemoteUrl) {
      opts.sourceUrl = this.src;
      if(this.assetCache && this.cacheOptions) {
        // valid only if asset cached file is still valid
        opts.__validAssetCache = this.assetCache.isCacheValid(this.cacheOptions.duration);
      }
    } else if(Buffer.isBuffer(this.src)) {
      opts.sourceUrl = this.src.toString();
      opts.__originalSize = this.src.length; // used for hashing
    } else {
      opts.__originalSize = fs.statSync(this.src).size; // used for hashing
    }

    return opts;
  }

  async getInput() {
    if(this.isRemoteUrl) {
      // fetch remote image Buffer
      if(queue) {
        // eleventy-cache-assets 2.0.4 and up
        return queue(this.src, () => this.assetCache.fetch());
      }

      // eleventy-cache-assets 2.0.3 and below
      return this.assetCache.fetch(this.cacheOptions);
    }
    return this.src;
  }

  getSharpOptionsForFormat(format) {
    if(format === "webp") {
      return this.options.sharpWebpOptions;
    } else if(format === "jpeg") {
      return this.options.sharpJpegOptions;
    } else if(format === "png") {
      return this.options.sharpPngOptions;
    } else if(format === "avif") {
      return this.options.sharpAvifOptions;
    }
    return {};
  }

  static getFormatsArray(formats) {
    if(formats && formats.length) {
      if(typeof formats === "string") {
        formats = formats.split(",");
      }

      formats = formats.map(format => {
        if(FORMAT_ALIASES[format]) {
          return FORMAT_ALIASES[format];
        }
        return format;
      });

      // svg must come first for possible short circuiting
      formats.sort((a, b) => {
        if(a === "svg") {
          return -1;
        } else if(b === "svg") {
          return 1;
        }
        return 0;
      });

      return formats;
    }

    return [];
  }

  // metadata so far: width, height, format
  // src is used to calculate the output file names
  getFullStats(metadata) {
    let results = [];
    let outputFormats = Image.getFormatsArray(this.options.formats);

    for(let outputFormat of outputFormats) {
      if(!outputFormat || outputFormat === "auto") {
        outputFormat = metadata.format || this.options.overrideInputFormat;
      }
      if(!outputFormat || outputFormat === "auto") {
        throw new Error("When using statsSync or statsByDimensionsSync, `formats: [null | auto]` to use the native image format is not supported.");
      }

      if(outputFormat === "svg") {
        if((metadata.format || this.options.overrideInputFormat) === "svg") {
          let svgStats = getStats(this.src, "svg", this.options.urlPath, metadata.width, metadata.height, this.options);
          // SVG metadata.size is only available with Buffer input (remote urls)
          if(metadata.size) {
            // Note this is unfair for comparison with raster formats because its uncompressed (no GZIP, etc)
            svgStats.size = metadata.size;
          }
          results.push(svgStats);

          if(this.options.svgShortCircuit) {
            break;
          } else {
            continue;
          }
        } else {
          debug("Skipping SVG output for %o: received raster input.", this.src);
          continue;
        }
      } else { // not SVG
        let widths = getValidWidths(metadata.width, this.options.widths, metadata.format === "svg" && this.options.svgAllowUpscale);
        for(let width of widths) {
          // Warning: if this is a guess via statsByDimensionsSync and that guess is wrong
          // The aspect ratio will be wrong and any height/widths returned will be wrong!
          let height = Math.floor(width * metadata.height / metadata.width);

          results.push(getStats(this.src, outputFormat, this.options.urlPath, width, height, this.options));
        }
      }
    }

    return transformRawFiles(results, outputFormats);
  }

  // src should be a file path to an image or a buffer
  async resize(input) {
    let sharpImage = sharp(input, Object.assign({
      failOnError: false
    }, this.options.sharpOptions));

    if(typeof this.src !== "string" && !this.options.sourceUrl) {
      throw new Error("Expected this.options.sourceUrl in .resize when using Buffer as input.");
    }

    // Must find the image format from the metadata
    // File extensions lie or may not be present in the src url!
    let metadata = await sharpImage.metadata();
    let outputFilePromises = [];

    let fullStats = this.getFullStats(metadata);
    for(let outputFormat in fullStats) {
      for(let stat of fullStats[outputFormat]) {
        if(this.options.useCache && fs.existsSync(stat.outputPath)){
          stat.size = fs.statSync(stat.outputPath).size;
          if(this.options.dryRun) {
            stat.buffer = fs.readFileSync(this.src);
          }

          outputFilePromises.push(Promise.resolve(stat));
          continue;
        }

        let sharpInstance = sharpImage.clone();
        if(stat.width < metadata.width || (this.options.svgAllowUpscale && metadata.format === "svg")) {
          let resizeOptions = {
            width: stat.width
          };
          if(metadata.format !== "svg" || !this.options.svgAllowUpscale) {
            resizeOptions.withoutEnlargement = true;
          }
          sharpInstance.resize(resizeOptions);
        }

        if(!this.options.dryRun) {
          await fsp.mkdir(this.options.outputDir, {
            recursive: true
          });
        }

        // format hooks are only used for SVG out of the box
        if(this.options.formatHooks && this.options.formatHooks[outputFormat]) {
          let hookResult = await this.options.formatHooks[outputFormat].call(stat, sharpInstance);
          if(hookResult) {
            stat.size = hookResult.length;
            if(this.options.dryRun) {
              stat.buffer = Buffer.from(hookResult);
              outputFilePromises.push(Promise.resolve(stat));
            } else {
              outputFilePromises.push(fsp.writeFile(stat.outputPath, hookResult).then(() => stat));
            }
          }
        } else { // not a format hook
          let sharpFormatOptions = this.getSharpOptionsForFormat(outputFormat);
          let hasFormatOptions = Object.keys(sharpFormatOptions).length > 0;
          if(hasFormatOptions || outputFormat && metadata.format !== outputFormat) {
            sharpInstance.toFormat(outputFormat, sharpFormatOptions);
          }

          if(this.options.dryRun) {
            outputFilePromises.push(sharpInstance.toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
              stat.buffer = data;
              stat.size = info.size;
              return stat;
            }));
          } else {
            outputFilePromises.push(sharpInstance.toFile(stat.outputPath).then(info => {
              stat.size = info.size;
              return stat;
            }));
          }
        }
        debug( "Wrote %o", stat.outputPath );
      }
    }

    return Promise.all(outputFilePromises).then(files => transformRawFiles(files, Object.keys(fullStats)));
  }
}

/* Size Cache */
let sizeCache = new FileSizeCache();

/* Queue */
let processingQueue = new PQueue({
  concurrency: globalOptions.concurrency
});
processingQueue.on("active", () => {
  debug( `Concurrency: ${processingQueue.concurrency}, Size: ${processingQueue.size}, Pending: ${processingQueue.pending}` );
});

function filenameFormat(id, src, width, format) { // and options
  if (width) {
    return `${id}-${width}.${format}`;
  }

  return `${id}.${format}`;
}



function getValidWidths(originalWidth, widths = [], allowUpscale = false) {
  // replace any falsy values with the original width
  let valid = widths.map(width => !width || width === 'auto' ? originalWidth : width);

  // Convert strings to numbers, "400" (floats are not allowed in sharp)
  valid = valid.map(width => parseInt(width, 10));

  // filter out large widths if upscaling is disabled
  let filtered = valid.filter(width => allowUpscale || width <= originalWidth);

  // if the only valid width was larger than the original (and no upscaling), then use the original width
  if(valid.length > 0 && filtered.length === 0) {
    filtered.push(originalWidth);
  }

  // sort ascending
  return filtered.sort((a, b) => a - b);
}

// TODO does this need a cache? if so it needs to be based on src and imgOptions
function getHash(src, imgOptions={}, length=10) {
  const hash = createHash("sha256");

  let opts = Object.assign({
    "userOptions": {},
    "sharpOptions": {},
    "sharpWebpOptions": {},
    "sharpPngOptions": {},
    "sharpJpegOptions": {},
    "sharpAvifOptions": {},
  }, imgOptions);

  opts = {
    userOptions: opts.userOptions,
    sharpOptions: opts.sharpOptions,
    sharpWebpOptions: opts.sharpWebpOptions,
    sharpPngOptions: opts.sharpPngOptions,
    sharpJpegOptions: opts.sharpJpegOptions,
    sharpAvifOptions: opts.sharpAvifOptions,
  };

  if(fs.existsSync(src)) {
    const fileContent = fs.readFileSync(src);
    hash.update(fileContent);
  } else {
    // probably a remote URL
    hash.update(src);
  }

  hash.update(JSON.stringify(opts));

  return base64url.encode(hash.digest()).substring(0, length);
}

function getFilename(id, src, width, format, options = {}) {
  if (typeof options.filenameFormat === "function") {
    let filename = options.filenameFormat(id, src, width, format, options);
    // if options.filenameFormat returns falsy, use fallback filename
    if(filename) {
      return filename;
    }
  }

  return filenameFormat(id, src, width, format, options);
}

function getUrlPath(dir, filename) {
  let src = path.join(dir, filename);
  return src.split(path.sep).join("/");
}

function getStats(src, format, urlPath, width, height, options = {}) {
  let url;
  let outputFilename;
  let outputExtension = options.extensions[format] || format;

  let id = getHash(src, options);

  if(options.urlFormat && typeof options.urlFormat === "function") {
    url = options.urlFormat({
      id,
      src,
      width,
      format: outputExtension,
    }, options);
  } else {
    outputFilename = getFilename(id, src, width, outputExtension, options);
    url = getUrlPath(urlPath, outputFilename);
  }

  let stats = {
    format: format,
    width: width,
    height: height,
    url: url,
    sourceType: MIME_TYPES[format],
    srcset: `${url} ${width}w`,
    // Not available in stats* functions below
    // size // only after processing
  };

  if(outputFilename) {
    stats.filename = outputFilename; // optional
    stats.outputPath = path.join(options.outputDir, outputFilename); // optional
  }

  return stats;
}

function transformRawFiles(files = [], formats = []) {
  let byType = {};
  for(let format of formats) {
    if(format && format !== 'auto') {
      byType[format] = [];
    }
  }
  for(let file of files) {
    if(!byType[file.format]) {
      byType[file.format] = [];
    }
    byType[file.format].push(file);
  }
  for(let type in byType) {
    // sort by width, ascending (for `srcset`)
    byType[type].sort((a, b) => {
      return a.width - b.width;
    });
  }
  return byType;
}

function isFullUrl(url) {
  try {
    new URL(url);
    return true;
  } catch(e) {
    // invalid url OR local path
    return false;
  }
}

function queueImage(src, opts) {
  let img = new Image(src, opts);
  let cached = sizeCache.get(img.options);
  if(img.options.useCache && cached) {
    debug("Found cached, returning %o", cached);
    return cached;
  }

  let promise = processingQueue.add(async () => {
    let input = await img.getInput();
    return img.resize(input);
  });

  sizeCache.add(img.options, promise);

  return promise;
}

module.exports = queueImage;

Object.defineProperty(module.exports, "concurrency", {
  get: function() {
    return processingQueue.concurrency;
  },
  set: function(concurrency) {
    processingQueue.concurrency = concurrency;
  },
});

/* `statsSync` doesn’t generate any files, but will tell you where
 * the asynchronously generated files will end up! This is useful
 * in synchronous-only template environments where you need the
 * image URLs synchronously but can’t rely on the files being in
 * the correct location yet.
 *
 * `options.dryRun` is still asynchronous but also doesn’t generate
 * any files.
 */
function statsSync(src, opts) {
  if(typeof src === "string" && isFullUrl(src)) {
    throw new Error("`statsSync` is not supported with full URL sources. Use `statsByDimensionsSync` instead.");
  }

  let dimensions = getImageSize(src);

  let img = new Image(src, opts);
  return img.getFullStats({
    width: dimensions.width,
    height: dimensions.height,
    format: dimensions.type,
  });
}

function statsByDimensionsSync(src, width, height, opts) {
  let dimensions = { width, height, guess: true };

  let img = new Image(src, opts);
  return img.getFullStats(dimensions);
}

module.exports.statsSync = statsSync;
module.exports.statsByDimensionsSync = statsByDimensionsSync;
module.exports.getFormats = Image.getFormatsArray;
module.exports.getWidths = getValidWidths;
module.exports.getHash = getHash;

const generateHTML = require("./generate-html");
module.exports.generateHTML = generateHTML;
module.exports.generateObject = generateHTML.generateObject;
