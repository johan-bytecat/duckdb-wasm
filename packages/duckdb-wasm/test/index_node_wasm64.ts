import * as duckdb from '../src/targets/duckdb';
import { DuckDBBindings, DuckDBFeature } from '../src/bindings';
import { DuckDB as DuckDBMVP64 } from '../src/bindings/bindings_node_mvp64';
import { DuckDB as DuckDBEH64 } from '../src/bindings/bindings_node_eh64';
import { NODE_RUNTIME } from '../src/bindings/runtime_node';
import path from 'path';
import Worker from 'web-worker';

const variant = process.env.DUCKDB_WASM64_VARIANT;
if (variant !== 'mvp64' && variant !== 'eh64') {
    throw new Error('DUCKDB_WASM64_VARIANT must be either "mvp64" or "eh64"');
}

jasmine.DEFAULT_TIMEOUT_INTERVAL = 900000;

let db: DuckDBBindings | null = null;
let adb: duckdb.AsyncDuckDB | null = null;
let worker: Worker | null = null;

beforeAll(async () => {
    const logger = new duckdb.VoidLogger();
    const mainModule = path.resolve(__dirname, `./duckdb-${variant}.wasm`);
    const mainWorker = path.resolve(__dirname, `./duckdb-node-${variant}.worker.cjs`);

    db = variant === 'mvp64'
        ? new DuckDBMVP64(logger, NODE_RUNTIME, mainModule)
        : new DuckDBEH64(logger, NODE_RUNTIME, mainModule);
    await db.instantiate(_ => {});
    expect(db.getFeatureFlags() & DuckDBFeature.WASM_MEMORY64).not.toEqual(0);

    worker = new Worker(mainWorker);
    adb = new duckdb.AsyncDuckDB(logger, worker);
    await adb.instantiate(mainModule);
    expect(await adb.getFeatureFlags() & DuckDBFeature.WASM_MEMORY64).not.toEqual(0);
});

afterAll(async () => {
    await adb?.terminate();
    worker?.terminate();
});

import { testWasm64Parquet, testWasm64ParquetAsync } from './wasm64_parquet.test';
import { testWasm64Integration, testWasm64IntegrationAsync } from './wasm64_integration.test';

testWasm64Parquet(() => db!);
testWasm64ParquetAsync(() => adb!);
testWasm64Integration(() => db!);
testWasm64IntegrationAsync(() => adb!);
