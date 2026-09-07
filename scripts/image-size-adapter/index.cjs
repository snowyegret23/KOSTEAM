const probe = require('probe-image-size/sync');

const svgUnitScale = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, em: 16, ex: 8 };

// Only the synchronous buffer API used by addons-linter is provided.
function imageSize(input) {
    if (!(input instanceof Uint8Array)) throw new TypeError('Expected image bytes');
    const result = probe(input);
    if (!result) throw new TypeError('Invalid or unsupported image');

    const width = result.type === 'svg' ? Math.round(result.width * svgUnitScale[result.wUnits]) : result.width;
    const height = result.type === 'svg' ? Math.round(result.height * svgUnitScale[result.hUnits]) : result.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new TypeError('Invalid image dimensions');
    }
    return { width, height, type: result.type };
}

module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
