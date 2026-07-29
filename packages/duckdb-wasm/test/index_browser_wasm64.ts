import * as duckdb from '../src/targets/duckdb';
import { DuckDBBindings, DuckDBFeature } from '../src/bindings';
import { DuckDB as DuckDBMVP64 } from '../src/bindings/bindings_browser_mvp64';
import { DuckDB as DuckDBEH64 } from '../src/bindings/bindings_browser_eh64';
import { BROWSER_RUNTIME } from '../src/bindings/runtime_browser';

declare const WASM64_TEST_VARIANT: 'mvp64' | 'eh64' | 'coi64';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 900000;

const variant = WASM64_TEST_VARIANT;
const mainModule = new URL(`/static/duckdb-${variant}.wasm`, window.location.href).href;
const mainWorker = new URL(`/static/duckdb-browser-${variant}.worker.js`, window.location.href).href;
const pthreadWorker =
    variant === 'coi64'
        ? new URL('/static/duckdb-browser-coi64.pthread.worker.js', window.location.href).href
        : undefined;

let db: DuckDBBindings | null = null;
let adb: duckdb.AsyncDuckDB | null = null;
let worker: Worker | null = null;

beforeAll(async () => {
    const logger = new duckdb.VoidLogger();
    if (variant !== 'coi64') {
        db =
            variant === 'mvp64'
                ? new DuckDBMVP64(logger, BROWSER_RUNTIME, mainModule)
                : new DuckDBEH64(logger, BROWSER_RUNTIME, mainModule);
        await db.instantiate(_ => {});
        expect(db.getFeatureFlags() & DuckDBFeature.WASM_MEMORY64).not.toEqual(0);
    } else {
        expect(globalThis.crossOriginIsolated).toBeTrue();
    }

    worker = await duckdb.createWorker(mainWorker);
    adb = new duckdb.AsyncDuckDB(logger, worker);
    await adb.instantiate(mainModule, pthreadWorker);
    expect((await adb.getFeatureFlags()) & DuckDBFeature.WASM_MEMORY64).not.toEqual(0);
});

afterAll(async () => {
    await adb?.terminate();
    worker?.terminate();
});

import { testWasm64Parquet, testWasm64ParquetAsync } from './wasm64_parquet.test';
import { testWasm64Integration, testWasm64IntegrationAsync } from './wasm64_integration.test';
import { testWasm64RuntimePrimitives } from './wasm64_runtime.test';

testWasm64RuntimePrimitives();

if (variant !== 'coi64') {
    testWasm64Parquet(() => db!);
    testWasm64Integration(() => db!);
}
testWasm64ParquetAsync(() => adb!);
testWasm64IntegrationAsync(() => adb!, () => true);
