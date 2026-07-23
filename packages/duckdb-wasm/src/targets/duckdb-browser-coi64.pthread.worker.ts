import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func == 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// Emscripten 3.1.71 no longer emits a separate pthread worker module. The
// modularized main module detects workers named `em-pthread-*` and starts its
// pthread runtime automatically. Load it only after DUCKDB_RUNTIME is ready.
void import('../bindings/duckdb-coi64').then(() => {
    const emscriptenOnMessage = globalThis.onmessage;
    globalThis.onmessage = (event: MessageEvent) => {
        const message = event.data;
        switch (message.cmd) {
            case 'registerFileHandle':
                globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
                globalThis.DUCKDB_RUNTIME._files.set(message.fileName, message.fileHandle);
                return;
            case 'dropFileHandle':
                globalThis.DUCKDB_RUNTIME._files?.delete(message.fileName);
                return;
            case 'registerUDFFunction':
                globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
                globalThis.DUCKDB_RUNTIME._udfFunctions.set(message.udf.functionId, message.udf);
                return;
            case 'dropUDFFunctions':
                for (const [functionId, udf] of globalThis.DUCKDB_RUNTIME._udfFunctions || []) {
                    if (udf.connectionId == message.connectionId) {
                        globalThis.DUCKDB_RUNTIME._udfFunctions.delete(functionId);
                    }
                }
                return;
            default:
                emscriptenOnMessage?.call(globalThis as any, event);
        }
    };
});
