import DuckDBWasm from './duckdb-eh64.js';
import { DuckDBModule } from './duckdb_module';
import { DuckDBNodeBindings } from './bindings_node_base.js';
import { DuckDBRuntime } from './runtime';
import { Logger } from '../log';

export class DuckDB extends DuckDBNodeBindings {
    public constructor(
        logger: Logger,
        runtime: DuckDBRuntime,
        mainModulePath: string,
        pthreadWorkerPath: string | null = null,
    ) {
        super(logger, runtime, mainModulePath, pthreadWorkerPath);
    }

    protected instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule> {
        return DuckDBWasm({
            ...moduleOverrides,
            instantiateWasm: this.instantiateWasm.bind(this),
            locateFile: this.locateFile.bind(this),
        });
    }
}

export default DuckDB;
