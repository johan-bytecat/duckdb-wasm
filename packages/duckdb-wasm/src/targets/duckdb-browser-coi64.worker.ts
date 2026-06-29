import { AsyncDuckDBDispatcher, WorkerResponseVariant, WorkerRequestVariant } from '../parallel';
import { DuckDB } from '../bindings/bindings_browser_coi64';
import { DuckDBBindings } from '../bindings';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';
import { InstantiationProgress } from '../bindings/progress';

class WebWorker extends AsyncDuckDBDispatcher {
    protected postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]) {
        globalThis.postMessage(response, transfer);
    }

    protected async instantiate(
        mainModuleURL: string,
        pthreadWorkerURL: string | null,
        progress: (p: InstantiationProgress) => void,
    ): Promise<DuckDBBindings> {
        const bindings = new DuckDB(this, BROWSER_RUNTIME, mainModuleURL, pthreadWorkerURL);
        return await bindings.instantiate(progress);
    }
}

export function registerWorker(): void {
    const api = new WebWorker();
    globalThis.onmessage = async (event: MessageEvent<WorkerRequestVariant>) => {
        await api.onMessage(event.data);
    };
}

registerWorker();
