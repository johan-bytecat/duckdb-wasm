export * from '../bindings';
export * from '../log';
export * from '../platform';
export * from '../status';
export * from '../version';
export { DuckDBDataProtocol } from '../bindings/runtime';
export { DEFAULT_RUNTIME } from '../bindings/runtime';
export { BROWSER_RUNTIME } from '../bindings/runtime_browser';

import { Logger } from '../log';
import { DuckDBRuntime, DuckDBBindings } from '../bindings';
import { DuckDBBundles, getPlatformFeatures } from '../platform';
import { DuckDBMemoryModel } from '../bindings/config';
import { DuckDB as DuckDBMVP } from '../bindings/bindings_browser_mvp';
import { DuckDB as DuckDBNext } from '../bindings/bindings_browser_eh';
import { DuckDB as DuckDBMVP64 } from '../bindings/bindings_browser_mvp64';
import { DuckDB as DuckDBNext64 } from '../bindings/bindings_browser_eh64';

export async function createDuckDB(
    bundles: DuckDBBundles,
    logger: Logger,
    runtime: DuckDBRuntime,
    memoryModel: DuckDBMemoryModel = 'wasm32',
): Promise<DuckDBBindings> {
    const platform = await getPlatformFeatures();
    if (memoryModel === 'wasm64') {
        if (!platform.wasmMemory64 || !bundles.wasm64) {
            throw new Error('WASM64 is not supported by this platform or bundle set');
        }
        if (platform.wasmExceptions && bundles.wasm64.eh) {
            return new DuckDBNext64(logger, runtime, bundles.wasm64.eh.mainModule);
        }
        return new DuckDBMVP64(logger, runtime, bundles.wasm64.mvp.mainModule);
    }
    if (platform.wasmExceptions) {
        if (bundles.eh) {
            return new DuckDBNext(logger, runtime, bundles.eh!.mainModule);
        }
    }
    return new DuckDBMVP(logger, runtime, bundles.mvp.mainModule);
}
