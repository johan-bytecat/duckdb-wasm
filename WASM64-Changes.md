# WASM64 Changes

This branch enables 64-bit WebAssembly (Memory64) for duckdb-wasm as an opt-in feature. WASM64 lifts the 4 GB address-space ceiling of WASM32 so larger databases and queries can run in the browser and Node.js. The default remains `wasm32` for backward compatibility.

User-facing documentation lives in [`packages/duckdb-wasm/README.md`](packages/duckdb-wasm/README.md) and the root [`README.md`](README.md). This document summarizes what the branch changed internally.

---

## a) Overview of Changes Required

WASM64 is not a drop-in recompile. Memory64 changes how pointers and sizes cross the JavaScript/WASM boundary (64-bit `i64` instead of 32-bit `i32`), so every layer that previously assumed 4-byte pointers or used `double` to smuggle 32-bit addresses had to be updated.

### Design principles

1. **Dual ABI, single 24-byte packing.** Packed C++↔JS structs (`WASMResponse`, `OpenedFile`) keep the same size and field offsets on both models. wasm32 stores pointer fields as `double` (lossless for 32-bit addresses); wasm64 stores them as `int64_t`/`uint64_t`. JavaScript reads via `HEAPF64` (wasm32) or `DataView.getBigInt64` (wasm64).

2. **Runtime memory-model detection via feature flags.** Emscripten legalizes pointer returns to JavaScript `number` even for MEMORY64 modules, so probing `_malloc` return types is unreliable. Detection instead uses `duckdb_web_get_feature_flags() & (1 << 5)`, cached per module in a `WeakMap`.

3. **BigInt at the WASM boundary; checked `number` at the host boundary.** ABI pointers/sizes may be `bigint` in TypeScript. Conversions to heap indices or filesystem offsets go through `wasmToSafeNumber` / `wasmToHeapIndex` / `wasmHeapRange`, which throw `RangeError` on out-of-range values instead of silently truncating.

4. **Opt-in, explicit, no silent fallback.** Requesting `memoryModel: 'wasm64'` without platform support or wasm64 artifacts throws. Bundle selection only searches the `wasm64.*` subtree (preferring `coi` > `eh` > `mvp` within it).

5. **Pointer width is model-dependent in several data structures.** UDF pointer tables, VARCHAR dataview entries, `dropFiles` pointer arrays, `OpenedFile.file_buffer`, and filesystem offsets all branch on `isWasm64(mod)` or `#ifdef WASM_MEMORY64`.

6. **Parallel artifact sets.** Builds produce `mvp64`, `eh64`, and `coi64` variants alongside the wasm32 set. Loadable extensions must match the main module's memory model.

### What had to change

| Layer | Why |
|-------|-----|
| Build system / CMake | `-sMEMORY64=1`, `-sWASM_BIGINT=1`, platform string (`wasm64_*`), no 4 GB cap, propagate flags to DuckDB/Arrow/side modules |
| C++ packed response & FS ABI | Pointer fields must hold full 64-bit addresses (`int64_t`/`uint64_t` instead of `double`) |
| EM_ASM / JS library stubs | `HEAP64` instead of `HEAPF64`; Emscripten signatures `j` (i64) instead of `d` (double) |
| TypeScript runtime | Memory-model detection, checked BigInt→Number conversions, dual pack/call paths |
| Bindings / public types | Handle and pointer types widen to `number \| bigint` |
| UDF runtime | Pointer-width-aware tables and VARCHAR result buffers |
| Platform / config API | `memoryModel` option, wasm64 bundle selection, support detection |
| Packaging / exports | New `*64` bindings, workers, package submodules (`wasm64-mvp/eh/coi`) |
| CI / Docker / tests | wasm64 build jobs, smoke tests, Node/Chrome integration suites |
| Emscripten 6 compatibility | Explicit `EMSCRIPTEN` define, BigInt defaults, HEAP exports, synthesized pthread glue |

---

## b) Items That Were Changed

### Build system

| Item | Location | Summary |
|------|----------|---------|
| `WASM_MEMORY64` CMake option | `lib/CMakeLists.txt:15` | Primary opt-in for the 64-bit memory model |
| Flag set when enabled | `lib/CMakeLists.txt:160-176` | Adds `-DWASM_MEMORY64 -sMEMORY64=1 -sWASM_BIGINT=1`; renames platform to `wasm64_*`; drops `-s MAXIMUM_MEMORY=4GB` |
| wasm32 BigInt disabled | same | Emscripten ≥4 defaults `WASM_BIGINT=1`; forced to `0` for wasm32 to keep legacy browser targets parseable |
| HEAP64/HEAPU64 exports | `lib/CMakeLists.txt:317-327` | Exported only under `WASM_MEMORY64` via `EXPORTED_RUNTIME_METHODS` |
| DuckDB ExternalProject | `lib/cmake/duckdb.cmake:22-30,53` | Passes `-DWASM_MEMORY_FLAGS=-sMEMORY64=1` and recognizes `wasm64_threads` |
| Arrow flags | `lib/cmake/arrow.cmake:3-4` | Inherits the same C/C++ flags |
| Build script | `scripts/wasm_build_lib.sh` | `WASM_MEMORY64=1` env var; appends `64` to feature suffixes (`-mvp64`, `-eh64`, `-coi64`); requires Emscripten ≥ 3.1.59 |
| Makefile targets | `Makefile:307-334,418-420` | `wasm64`, `wasm64_dev/relperf/relsize/debug`, `wasm64_star`, `build_loadable64` |
| Loadable extension linking | `scripts/build_loadable.sh`, `patches/duckdb/wasm64_extension_link.patch`, `extension_config_wasm.cmake` | Side modules get `-sMEMORY64=1 -sWASM_BIGINT=1`; memory models must match the main module |
| Emscripten 6 glue | `lib/CMakeLists.txt`, `scripts/wasm_build_lib.sh`, `packages/duckdb-wasm/bundle.mjs` | Explicit `-DEMSCRIPTEN`; synthesized `.pthread.js` when EM ≥4 no longer emits `.worker.js`; bundle workarounds for `node:` requires |
| Docker note | `docker-compose.yml:2-3` | EMSDK includes Memory64; run with `docker compose run --rm duckdb-wasm-ci make wasm64_dev` |

**Build commands:**

```bash
# wasm64 variants (feature arg must NOT include a 64 suffix)
WASM_MEMORY64=1 DUCKDB_PLATFORM="wasm64_mvp" ./scripts/wasm_build_lib.sh relperf mvp
make wasm64_dev          # or wasm64 / wasm64_relperf / wasm64_relsize / wasm64_debug
make wasm64_star         # all modes
make build_loadable64    # loadable extensions
```

Artifacts: `duckdb-mvp64.wasm`, `duckdb-eh64.wasm`, `duckdb-coi64.wasm` (+ `.js` / `.pthread.js`) under `packages/duckdb-wasm/src/bindings/`.

### C++ / WASM ABI

| Item | Location | Summary |
|------|----------|---------|
| Packed response struct | `lib/include/duckdb/web/utils/wasm_response.h:16-42` | 24-byte `WASMResponse`; fields are `int64_t` under `WASM_MEMORY64`, `double` otherwise; `static_assert` locks offsets |
| Response stores | `lib/src/utils/wasm_response.cc` | Pointer/size fields cast to `int64_t` under Memory64; double results bit-cast via `memcpy` when Memory64 (JS must reverse) |
| Filesystem ABI | `lib/src/io/web_filesystem.cc:96-127` | `OpenedFile.file_buffer` is `uint64_t` (vs `double`); `JSFileOffset` is `int64_t` (vs `double`) |
| HTTP EM_ASM | `lib/src/http_wasm.cc` | Pointer arrays read via `HEAP64` under `WASM_MEMORY64` (vs `HEAPF64` pairs on wasm32) |
| JS library stubs | `lib/js-stubs.js:26-45` | `#if MEMORY64` signatures use `j` (i64) instead of `d` (double) for truncate/read/write offsets |
| Feature flag | `lib/include/duckdb/web/config.h:16-41` | `WebDBFeature::MEMORY64 = 5`; bit `1<<5` set when `WASM_MEMORY64` is defined; exposed via `duckdb_web_get_feature_flags()` |
| UDF dataview | `lib/src/json_dataview.cc`, `lib/include/duckdb/web/json_dataview.h` | VARCHAR data/length buffers use `uintptr_t`/`size_t` entries (4 vs 8 bytes by model) |
| Connection handles | `lib/src/webdb_api.cc:17` | `ConnectionHdl`/`BufferHdl` are `uintptr_t` — `number` on wasm32, `bigint` on wasm64 at the JS boundary |
| Extension mismatch error | `patches/duckdb/all_of_them.patch` | `WebAssembly.validate` failure reports memory-model mismatch (wasm64 main cannot load wasm32 extensions, and vice versa) |

### TypeScript / JavaScript

| Item | Location | Summary |
|------|----------|---------|
| Memory-model detection | `packages/duckdb-wasm/src/bindings/runtime.ts:5-21` | `setMemoryModel` / `isWasm64` via feature bit `1<<5`; cached in `WeakMap` |
| Checked conversions | `runtime.ts:23-54` | `wasmToSafeNumber`, `wasmToHeapIndex`, `wasmHeapRange` — throw on values outside `0..Number.MAX_SAFE_INTEGER` or beyond heap size |
| Dual call/pack paths | `runtime.ts:183-285` | `callSRet32`/`packSRet32` use `HEAPF64`; `callSRet64`/`packSRet64` use `DataView` BigInt64; `packFileInfo` writes pointer field as BigUint64 under wasm64 |
| Type widening | `bindings_interface.ts`, `async_bindings_interface.ts`, `worker_request.ts`, `connection.ts`, `runtime.ts` | Handles/pointers typed `number \| bigint` throughout |
| ccall arg types | `bindings_base.ts` | Pointer-bearing calls use `['pointer', ..., 'bigint']` (e.g. `runQuery`, `registerFileBuffer`) |
| UDF runtime | `udf_runtime.ts` | Pointer tables 4 vs 8 bytes by model; VARCHAR physical buffers `Uint32Array` (wasm32) vs `Float64Array` (wasm64); result packing via BigInt DataView under wasm64; VARCHAR result pointer arithmetic uses `BigInt` |
| `dropFiles` | `bindings_base.ts:635-692` | Pointer array written as 8-byte `BigInt64Array` entries under wasm64, 4-byte `HEAP32` otherwise |
| Node runtime | `runtime_node.ts` | `openFile` response size 24 vs 16 bytes by model; offsets go through `wasmToSafeNumber`/`wasmHeapRange`; `assertNodeWasm64Support()` requires Node ≥ 20 |
| Browser runtime | `runtime_browser.ts:823-829` | `assertBrowserWasm64Support()` with a clear unsupported-platform error |
| Platform detection | `platform.ts:29-58,90-98,128-172` | `wasm64` bundle subtree, `PlatformFeatures.wasmMemory64`, `selectBundle` with no silent fallback to wasm32 |
| Config API | `bindings/config.ts:24,96-100` | `DuckDBMemoryModel = 'wasm32' \| 'wasm64'`; `DuckDBConfig.memoryModel` (defaults to `'wasm32'`) |
| Variant bindings | `bindings_*_{mvp,eh,coi}64.ts`, `duckdb-*64.d.ts` | New browser/node binding modules importing glue from `duckdb-*64.js` |
| Worker targets | `targets/duckdb-browser-*64*.ts`, `targets/duckdb-node-*64*.ts` | mvp64/eh64/coi64 (and coi64.pthread) workers |
| Blocking factories | `duckdb-browser-blocking.ts`, `duckdb-node-blocking.ts` | `createDuckDB(..., memoryModel)` selects the 64-bit module classes when requested |
| COI64 pthread bootstrap | `duckdb-browser-coi64.pthread.worker.ts` | Workers named `em-pthread-*` bootstrap from the main module (Emscripten ≥4 style); installs `DUCKDB_RUNTIME` first |
| Heap access pattern | throughout TS sources | `HEAPU8` + `DataView.getBigInt64/setBigInt64/getBigUint64/setBigUint64` for pointer/size fields under wasm64; wasm32 keeps `HEAPF64[(ptr >> 3) + i]` for the packed response |

### Packaging / exports

| Item | Location | Summary |
|------|----------|---------|
| Test scripts | `packages/duckdb-wasm/package.json` | `test:node:wasm64[:mvp|:eh]`, `test:chrome:wasm64[:mvp|:eh|:coi]` with `DUCKDB_WASM64_VARIANT` |
| Package exports | `package.json` | `./dist/duckdb-*64.wasm`, browser/node `*64` bundles/workers, submodules `./wasm64-mvp`, `./wasm64-eh`, `./wasm64-coi` |
| COI64 browser-only | `package.json` | `./wasm64-coi` sets `"node": null` |
| Bundle script | `packages/duckdb-wasm/bundle.mjs` | `TARGET_BROWSER_WASM64 = ['es2020']` (BigInt syntax); conditional copy/patch of `duckdb-*64.{js,wasm}`; wasm64 test entries; blocking bundles include wasm64 bindings |

**Opt-in from application code:**

```ts
await db.open({
    path: ':memory:',
    memoryModel: 'wasm64',
});
```

**Direct submodule imports:**

```ts
import * as duckdb from '@duckdb/duckdb-wasm/wasm64-mvp'; // or wasm64-eh / wasm64-coi
```

### CI / testing

| Item | Location | Summary |
|------|----------|---------|
| wasm64 build jobs | `.github/workflows/main.yml:486-619` | `wasm64_mvp`, `wasm64_eh`, `wasm64_coi` |
| Smoke test | `scripts/wasm64_smoke_test.js`, workflow `:621-652` | Instantiates glue+wasm; asserts feature bit `1<<5`; checks `_malloc` returns a legalised `number` pointer |
| Node/Chrome integration | workflow `:803-805,932-951` | JS build packaging + wasm64 test jobs |
| Test entry points | `test/index_node_wasm64.ts`, `test/index_browser_wasm64.ts` | Assert `DuckDBFeature.WASM_MEMORY64`; variant via `WASM64_TEST_VARIANT` |
| Test suites | `test/wasm64_runtime.test.ts`, `wasm64_parquet.test.ts`, `wasm64_integration.test.ts` | Per-module memory model, range checks, no-fallback behavior; Parquet with larger row counts; file I/O / SQL integration |
| Karma config | `karma/tests-chrome-wasm64.cjs` | Requires `DUCKDB_WASM64_VARIANT` |

**Test commands:**

```bash
# Node
DUCKDB_WASM64_VARIANT=mvp64 npm run test:node:wasm64
# Chrome
DUCKDB_WASM64_VARIANT=coi64 npm run test:chrome:wasm64
```

### Documentation

| Item | Location |
|------|----------|
| Root README wasm64 sections | `README.md:59,144-159,201-217` |
| Package README (user guide) | `packages/duckdb-wasm/README.md:234-282` |
| CMake / ABI comments | `lib/CMakeLists.txt`, `wasm_response.h`, `web_filesystem.cc`, `http_wasm.cc`, `udf_runtime.ts` |
| Extension memory-model notes | `extension_config_wasm.cmake:1-12` |

---

## c) Potential Gotchas

### Build and toolchain

- **Emscripten ≥ 3.1.59 is required** for `WASM_MEMORY64=1`. `scripts/wasm_build_lib.sh` enforces this and exits if the toolchain is older.
- **Do not include `64` in the feature argument** when `WASM_MEMORY64=1`. Pass `mvp`, `eh`, or `coi` — the script appends `64` itself. Passing `mvp64` + `WASM_MEMORY64=1` produces a wrong path (`mvp6464`).
- **Emscripten ≥ 4 defaults `WASM_BIGINT` to 1.** wasm32 builds explicitly set `-sWASM_BIGINT=0` to keep legacy browser targets parseable. If you override flags, do not accidentally re-enable BigInt for wasm32.
- **Emscripten ≥ 4 no longer predefines `EMSCRIPTEN`** on the command line. The build defines it explicitly (`-DEMSCRIPTEN`) because C++ code branches on `#ifdef EMSCRIPTEN` for JS-runtime implementations.
- **Emscripten ≥ 4 no longer emits `.worker.js`.** A `.pthread.js` is synthesized for COI builds; COI64 pthread workers bootstrap from the main module named `em-pthread-*` after installing `DUCKDB_RUNTIME`.
- **Memory64 flags must reach every dependency.** DuckDB, Arrow, and dynamically loaded side modules are built with `-sMEMORY64=1`; a mismatch produces invalid modules that fail `WebAssembly.validate`.
- **`MAIN_MODULE` flags are compatible with `-sMEMORY64=1`**, but HEAP views (`HEAP64`/`HEAPU64`) are only attached to the Module object when listed in `EXPORTED_RUNTIME_METHODS`.

### ABI and runtime behavior

- **Emscripten legalizes pointer returns to JavaScript `number`** even for MEMORY64 modules. Probing `_malloc(1)` return types is therefore unreliable. Memory-model detection uses the feature flag bit `1<<5` instead.
- **`callSRet64` still passes the response pointer as `Number(response)`** to `ccall` (legalized pointer). Do not cast it to `BigInt` for the ccall argument.
- **Double results are bit-cast under Memory64.** When C++ stores an `arrow::Result<double>` it does `memcpy` into `int64_t`. JavaScript must reverse this bit-cast when decoding non-pointer double values — do not treat the BigInt64 as an integer value.
- **Handle and pointer types are `number | bigint` at the JS boundary.** Code that assumes `number` for connection handles, statement IDs, or FS pointers will break on wasm64. Always funnel through `isWasm64(mod)` or the checked helpers.
- **Pointer width varies by model in several structures:**
  - UDF pointer arrays: 4 vs 8 bytes
  - VARCHAR dataview physical buffers: `Uint32Array` (wasm32) vs `Float64Array` (wasm64) — **not** always 8-byte doubles
  - `dropFiles` pointer arrays: 4 vs 8 bytes
  - `OpenedFile.file_buffer` / filesystem offsets: `double` vs `uint64_t`/`int64_t`
- **`isWasm64(mod)` throws if the memory model was not initialized.** Call `setMemoryModel` (done automatically in `bindings_base` after instantiation) before any memory-model-dependent operation.
- **No silent fallback to wasm32.** If `memoryModel: 'wasm64'` is requested but the platform or bundle set lacks support, a clear error is thrown. Tests assert this behavior.

### Platform and API limits

- **Browser requirements:** Chrome ≥ 109, Firefox ≥ 119, Safari ≥ 17 (Memory64 proposal). Older browsers throw a clear unsupported-platform error.
- **Node.js requirement:** Node ≥ 20. Older Node versions fail `assertNodeWasm64Support()`.
- **JavaScript host APIs still use `number` offsets.** Values above `Number.MAX_SAFE_INTEGER` (~9 PB) cannot be used as heap or host indices; out-of-range values throw `RangeError` instead of truncating.
- **Individual `ArrayBuffer`s remain subject to engine limits.** Large databases should use streamed or filesystem-backed access rather than one monolithic registered buffer.
- **COI64 (threads) is browser-only** in package exports (`./wasm64-coi` sets `"node": null`). Do not import it from Node.
- **BigInt arithmetic is slower** than Number arithmetic for address calculations; 8-byte pointers slightly increase memory usage for pointer-heavy data structures. Default remains wasm32 for smaller workloads.
- **Practical address space is ~4 TB** with Memory64 (vs 4 GB wasm32) — not the full 64-bit space.

### Extensions

- **Loadable extensions must be built with the same memory model** as the main module. A WASM64 main module cannot load a WASM32 side module and vice versa; `WebAssembly.validate` fails with an explicit error message.
- **Static (DONT_LINK) extensions inherit `WASM_MEMORY64` from CMake automatically.** Dynamically-loaded extensions need `WASM_MEMORY64=1` when built.
- Build loadable wasm64 extensions via `make build_loadable64` (sets `WASM_MEMORY64=1`, `DUCKDB_PLATFORM=wasm64_${TARGET}`, `DUCKDB_WASM_LOADABLE_EXTENSIONS=1`).

### Development workflow

- **Local `origin/wasm64` may diverge** from the remote branch. Check `git status` / `git log` before assuming remote state matches local.
- **Wasm64 suites are excluded from the wasm32 Node bundle** (commit `83a7873d`) to avoid cross-model test runs.
- **Smoke test expectations:** under wasm64, `_malloc` still returns a legalised `number` pointer; the feature bit `1<<5` must be set in `duckdb_web_get_feature_flags()`.
- **Docker EMSDK includes Memory64 support.** Use `docker compose run --rm duckdb-wasm-ci make wasm64_dev` for consistent toolchains.

---

## Quick reference: where WASM64 touchpoints live

| Concern | Primary files |
|---------|---------------|
| Build flags | `lib/CMakeLists.txt`, `lib/cmake/duckdb.cmake`, `scripts/wasm_build_lib.sh`, `Makefile` |
| C++ response ABI | `lib/include/duckdb/web/utils/wasm_response.h`, `lib/src/utils/wasm_response.cc` |
| C++ FS ABI | `lib/src/io/web_filesystem.cc` |
| EM_ASM / HEAP64 | `lib/src/http_wasm.cc`, `lib/js-stubs.js` |
| Feature bit | `lib/include/duckdb/web/config.h`, `lib/src/webdb_api.cc` |
| JS runtime core | `packages/duckdb-wasm/src/bindings/runtime.ts` |
| UDF ABI | `packages/duckdb-wasm/src/bindings/udf_runtime.ts` |
| Bindings API types | `bindings_interface.ts`, `connection.ts`, `worker_request.ts`, `async_bindings_interface.ts` |
| Platform / selection | `platform.ts`, `bindings/config.ts` |
| Variant modules | `bindings_*_{mvp,eh,coi}64.ts`, `targets/duckdb-*64*` |
| Packaging | `packages/duckdb-wasm/bundle.mjs`, `package.json` |
| Extensions | `extension_config_wasm.cmake`, `scripts/build_loadable.sh`, `patches/duckdb/wasm64_extension_link.patch` |
| CI | `.github/workflows/main.yml` |
| Docs | `README.md`, `packages/duckdb-wasm/README.md` |
