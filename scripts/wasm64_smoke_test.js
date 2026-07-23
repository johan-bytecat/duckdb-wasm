const fs = require('fs');
const path = require('path');

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const bindingsDir = path.resolve(repoRoot, 'packages', 'duckdb-wasm', 'src', 'bindings');
    const feature = process.argv[2];

    if (!feature) {
        console.error('Usage: node wasm64_smoke_test.js <feature>');
        console.error('  e.g.: node wasm64_smoke_test.js mvp64');
        process.exit(1);
    }

    const wasmFile = path.resolve(bindingsDir, `duckdb-${feature}.wasm`);
    const jsFile = path.resolve(bindingsDir, `duckdb-${feature}.js`);

    console.log(`WASM64 smoke test: ${feature}`);
    console.log(`  WASM: ${wasmFile}`);
    console.log(`  JS:   ${jsFile}`);

    if (!fs.existsSync(wasmFile)) {
        console.error(`WASM file not found: ${wasmFile}`);
        process.exit(1);
    }
    if (!fs.existsSync(jsFile)) {
        console.error(`JS glue file not found: ${jsFile}`);
        process.exit(1);
    }

    const wasmBytes = fs.readFileSync(wasmFile);
    console.log(`  WASM binary: ${wasmBytes.length} bytes`);

    try {
        new WebAssembly.Module(wasmBytes);
        console.log('  WebAssembly.Module: valid');
    } catch (e) {
        console.error(`Invalid WASM binary: ${e.message}`);
        process.exit(1);
    }

    const originalCwd = process.cwd();
    process.chdir(bindingsDir);

    try {
        const factory = require(jsFile);
        const mod = await factory();
        console.log('  Emscripten module instantiated successfully');

        const essentialExports = ['_malloc', '_free', '_stackAlloc', '_stackSave', '_stackRestore'];
        let missing = [];
        for (const func of essentialExports) {
            if (typeof mod[func] === 'function') {
                console.log(`    ${func}: available`);
            } else {
                console.log(`    ${func}: MISSING`);
                missing.push(func);
            }
        }

        if (typeof mod._malloc === 'function') {
            const ptr = mod._malloc(16);
            const ptrType = typeof ptr;
            console.log(`    _malloc(16) returned: ${ptr} (type: ${ptrType})`);
            if (ptrType !== 'number') {
                console.error(`    Expected Emscripten's legalized number pointer, got ${ptrType}`);
                process.exit(1);
            }
            mod._free(ptr);
            console.log('    _free(ptr) completed');
        }

        const featureFlags = mod.ccall('duckdb_web_get_feature_flags', 'number', [], []);
        if ((featureFlags & (1 << 5)) === 0) {
            console.error('    WASM_MEMORY64 feature flag: MISSING');
            process.exit(1);
        }
        console.log('    WASM_MEMORY64 feature flag: available');

        if (missing.length > 0) {
            console.error('Some essential exports are missing');
            process.exit(1);
        }

        console.log('WASM64 smoke test PASSED');
    } catch (e) {
        console.error(`Failed to instantiate module: ${e.message}`);
        if (e.stack) {
            console.error(e.stack);
        }
        process.exit(1);
    } finally {
        process.chdir(originalCwd);
    }
}

main();
