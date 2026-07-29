import { isWasm64, setMemoryModel, wasmHeapRange, wasmToSafeNumber } from '../src/bindings/runtime';
import { DuckDBModule } from '../src/bindings/duckdb_module';
import { selectBundle } from '../src/platform';

function fakeModule(features: number, heapSize = 64): DuckDBModule {
    const heap = new Uint8Array(heapSize);
    return {
        HEAPU8: heap,
        ccall: (() => features) as any,
    } as DuckDBModule;
}

export function testWasm64RuntimePrimitives(): void {
    describe('WASM64 runtime primitives', () => {
        it('tracks the memory model per module', () => {
            const wasm32 = fakeModule(0);
            const wasm64 = fakeModule(1 << 5);
            setMemoryModel(wasm64);
            setMemoryModel(wasm32);
            expect(isWasm64(wasm64)).toBeTrue();
            expect(isWasm64(wasm32)).toBeFalse();
        });

        it('rejects inexact ABI integers and invalid heap ranges', () => {
            const mod = fakeModule(0, 32);
            expect(() => wasmToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(RangeError);
            expect(() => wasmToSafeNumber(-1n)).toThrowError(RangeError);
            expect(wasmHeapRange(mod, 8n, 16n)).toEqual([8, 24]);
            expect(() => wasmHeapRange(mod, 24n, 16n)).toThrowError(RangeError);
        });

        it('never falls back to wasm32 when wasm64 was explicitly requested', async () => {
            const bundles = { mvp: { mainModule: 'mvp.wasm', mainWorker: 'mvp.worker.js' } };
            await expectAsync(selectBundle(bundles, 'wasm64')).toBeRejectedWithError(/WASM64/);
        });
    });
}
