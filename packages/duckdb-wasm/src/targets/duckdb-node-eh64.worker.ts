import { AsyncDuckDBDispatcher, WorkerResponseVariant, WorkerRequestVariant } from '../parallel/';
import { DuckDBBindings } from '../bindings';
import { DuckDB } from '../bindings/bindings_node_eh64';
import { NODE_RUNTIME } from '../bindings/runtime_node';
import { InstantiationProgress } from '../bindings/progress';

class NodeWorker extends AsyncDuckDBDispatcher {
    protected postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]) {
        globalThis.postMessage(response, transfer);
    }

    protected async instantiate(
        mainModulePath: string,
        pthreadWorkerPath: string | null,
        progress: (p: InstantiationProgress) => void,
    ): Promise<DuckDBBindings> {
        const bindings = new DuckDB(this, NODE_RUNTIME, mainModulePath, pthreadWorkerPath);
        return await bindings.instantiate(progress);
    }
}

export function registerWorker(): void {
    const api = new NodeWorker();
    globalThis.onmessage = async (event: MessageEvent<WorkerRequestVariant>) => {
        await api.onMessage(event.data);
    };
}

registerWorker();
