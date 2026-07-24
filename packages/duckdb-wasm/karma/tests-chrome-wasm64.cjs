const base = require('./karma.base.cjs');

const variant = process.env.DUCKDB_WASM64_VARIANT;
if (!['mvp64', 'eh64', 'coi64'].includes(variant)) {
    throw new Error('DUCKDB_WASM64_VARIANT must be mvp64, eh64, or coi64');
}

module.exports = function (config) {
    const crossOriginIsolation = function () {
        return function (_request, response, next) {
            response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            next();
        };
    };

    const baseConfig = base(config, `tests-browser-${variant}.js`);
    config.set({
        ...baseConfig,
        browsers: ['ChromeHeadlessNoSandbox'],
        reporters: ['spec'],
        beforeMiddleware: ['cross-origin-isolation'],
        plugins: [
            ...baseConfig.plugins,
            { 'middleware:cross-origin-isolation': ['factory', crossOriginIsolation] },
        ],
    });
};
