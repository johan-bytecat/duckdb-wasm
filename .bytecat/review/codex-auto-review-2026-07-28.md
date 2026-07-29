# WASM64 branch review

Date: 2026-07-28  
Branch reviewed: `wasm64` at `fba58080`  
Comparison base: `origin/main` (merge base `f61c03b7`)  
Scope: 67 changed files, approximately 3,288 insertions and 443 deletions

## Executive summary

The branch has the major pieces needed for an opt-in Memory64 build: build flags reach DuckDB and Arrow, the three build variants are produced and packaged, the response ABI has a 64-bit representation, pointer-bearing Emscripten signatures were updated, and Node/browser integration suites cover the principal query, filesystem, Parquet, prepared-statement, and UDF paths. The later fixup commits also address several real integration problems that the initial work-package commits missed.

I would not merge the stack as-is. There are two correctness issues that should be fixed first, one API behavior issue, and a CI hygiene regression:

1. **High:** Memory-model selection is process-global rather than module/instance-local. A wasm32 and wasm64 database in one JavaScript realm can make each other use the wrong ABI.
2. **High (latent above the exact integer range):** The scalar-UDF ABI still carries inner wasm64 pointers in `double` arrays. This undermines the promise of truly 64-bit-safe pointers once an address exceeds `Number.MAX_SAFE_INTEGER`.
3. **Medium:** `selectBundle(..., 'wasm64')` silently falls back to a wasm32 bundle when Memory64 or a wasm64 bundle is unavailable, contrary to the documented clear-failure behavior and the blocking API's behavior.
4. **Medium:** The normal lint command includes generated wasm64 glue and currently fails with hundreds of errors; two regular source imports fail lint as well.

The implementation is otherwise directionally sound, but the public JavaScript ABI needs a clearer type policy: wasm pointers/`size_t` values should remain `bigint` at Wasm boundaries, while values used as JavaScript typed-array indices must undergo an explicit, checked conversion to `number`.

## Findings

### 1. High: `isWasm64` is shared by every database instance

Locations:

- `packages/duckdb-wasm/src/bindings/runtime.ts:5-12`
- `packages/duckdb-wasm/src/bindings/runtime.ts:216-253`
- `packages/duckdb-wasm/src/bindings/bindings_base.ts:95-99`
- `packages/duckdb-wasm/src/bindings/bindings_base.ts:650-668`
- `packages/duckdb-wasm/src/bindings/runtime_node.ts:97`
- `packages/duckdb-wasm/src/bindings/udf_runtime.ts:275-284`

`setMemoryModel()` writes one exported module-level boolean. All response packing/calling, pointer-array construction, file-info packing, and UDF response packing consult that same value later. Instantiating a second database of the other memory model changes the ABI used by the first database.

Example failure sequence:

1. Instantiate wasm64; `isWasm64 = true`.
2. Instantiate wasm32; `isWasm64 = false`.
3. Query the original wasm64 instance; `callSRet()` allocates/decodes the response as three doubles instead of three `int64_t` fields.

Workers reduce the likelihood for async databases, but blocking bindings and multiple instances in a worker/main realm remain exposed. The exported `isWasm64` value also describes only whichever module initialized last, not a particular database.

Recommendation: make the model a property of `DuckDBModule` or `DuckDBBindingsBase`, or derive it per module through a `WeakMap<DuckDBModule, MemoryModel>`. Change helpers to use `isWasm64(mod)` rather than an imported mutable boolean. Add a regression test that creates wasm32 and wasm64 blocking instances in both initialization orders and alternates operations on them.

### 2. High: scalar UDFs still encode wasm64 pointers as doubles

Locations:

- `lib/src/webdb.cc:505-510` and `526-531`
- `lib/src/webdb.cc:557-580`
- `packages/duckdb-wasm/src/bindings/udf_runtime.ts:115-142`
- `packages/duckdb-wasm/src/bindings/udf_runtime.ts:264-280`

The outer `WASMResponse` was correctly changed to 64-bit integer fields, but the nested UDF protocol remains `vector<double>`/`double *`. C++ casts input pointers to `double`; TypeScript reads them through `Float64Array`; result pointers are converted with `Number(...)` and written to another `Float64Array`; C++ then converts those doubles back to `uintptr_t`.

This is exact for current low addresses and explains why the new UDF integration tests pass, but it is not a 64-bit pointer ABI. Integer precision is lost above 2^53. Memory64 permits a larger address space even if current engines and practical allocations do not yet reach that range.

Recommendation: define an explicit UDF wire struct for each memory model. For wasm64, use `uintptr_t`/`uint64_t` pointer slots and read/write them through `BigUint64Array` or `DataView`; keep lengths as `size_t` or a documented fixed-width integer. Do the same for per-row VARCHAR pointers. Avoid a mixed `double` array whose entries sometimes mean pointer, length, or floating-point data. Add ABI layout `static_assert`s and direct JS tests using synthetic values above 2^53 so correctness does not depend on allocating enormous memory.

### 3. Medium: explicit wasm64 selection can silently return wasm32

Location: `packages/duckdb-wasm/src/platform.ts:142-185`

The wasm64 branch is taken only if both platform support and `bundles.wasm64` are truthy. If the caller explicitly requests `'wasm64'` and either condition is false, execution falls through to normal wasm32 selection. The blocking `createDuckDB` functions instead throw `WASM64 is not supported by this platform or bundle set`, and the README promises a clear error.

This can be especially confusing because `DuckDBConfig.memoryModel` communicates user intent while bundle selection happens separately. A caller may believe it is exercising Memory64 while actually running wasm32.

Recommendation: if `memoryModel === 'wasm64'`, throw when unsupported or absent; only use wasm32 fallback when no explicit memory model was requested. Add unit tests for unsupported platform, missing bundle, and supported MVP/EH/COI selection.

### 4. Medium: lint no longer passes

Locations:

- generated `packages/duckdb-wasm/src/bindings/duckdb-mvp64.js`, `duckdb-eh64.js`, and `duckdb-coi64.js`
- `packages/duckdb-wasm/src/bindings/bindings_node_base.ts:1`
- `packages/duckdb-wasm/src/bindings/runtime_browser.ts:17`

Running the package ESLint command against `src test` reports 623 errors. Most come from generated Emscripten wasm64 glue that is now present under `src/bindings` but is not ignored. There are also ordinary unused-import errors for `DuckDBModule` in `bindings_node_base.ts` and `isWasm64` in `runtime_browser.ts`.

Recommendation: exclude all generated Emscripten glue with a stable pattern rather than enumerating variants, remove the unused imports, and ensure CI runs lint after artifacts have been downloaded so it sees the same tree as packaging/testing.

### 5. Medium recommendation: centralize checked `bigint` to `number` conversion

Locations include `runtime.ts:68-81`, `runtime.ts:190-196`, `bindings_base.ts:655-658`, and many filesystem/UDF typed-array accesses.

Converting a wasm64 address to `number` is necessary today because JavaScript `TypedArray` offsets and lengths are numbers. The conversions are currently scattered and unchecked. That is safe only while the engine's addressable `ArrayBuffer` range is within the exact integer range, an assumption that is implicit rather than enforced.

Recommendation: add one helper such as `wasmAddressToHeapOffset(value)` which rejects negative values, values above `Number.MAX_SAFE_INTEGER`, and values outside the current heap byte length. Add an analogous checked length/range helper that detects `begin + length` overflow and out-of-bounds slices. Use `bigint` for pointer and `size_t` values at ccall/import boundaries; convert only immediately before a JS heap access. This also makes the intended distinction between an ABI value and a JS index reviewable.

### 6. Medium recommendation: audit remaining width-limited public operations

`duckdb_web_fs_register_file_buffer` still accepts `uint32_t data_length` (`lib/src/webdb_api.cc:142`), and the TypeScript call uses a number length. A single JavaScript `Uint8Array` may impose its own practical limit, so this is not necessarily an immediate regression, but it is inconsistent with the stated goal of lifting the 4 GB ceiling.

Recommendation: document which APIs intentionally remain limited to 4 GB per buffer/request, or migrate lengths to `size_t` and use the same `bigint` ABI policy. Review filesystem read/write `bytes`, offsets, file IDs, cache epochs, statement IDs, and UDF sizes by semantic type rather than mechanically changing every integer to pointer width. File offsets currently remain doubles in several JS filesystem callbacks; that is exact only through 2^53 and should be an explicitly documented limit or migrated to i64/BigInt.

### 7. Low: ABI layouts should be compile-time checked

`WASMResponse` is expected to be exactly 24 bytes in both modes, while `OpenedFile`-style data uses a mixed double/pointer/double layout. The JavaScript code hard-codes byte offsets 0, 8, and 16.

Recommendation: add `static_assert(sizeof(WASMResponse) == 24)` and `offsetof` checks for all fields, plus equivalent checks for the file-open result struct. Prefer fixed-width unsigned fields for addresses/sizes where negative values are invalid. This will catch compiler or refactor drift before JavaScript starts decoding the wrong bytes.

### 8. Low: reduce duplicated Memory64-specific glue

`lib/src/http_wasm.cc` accounts for 538 additions and 90 deletions and now contains repeated wasm32/wasm64 `EM_ASM` bodies. Packaging similarly repeats nearly identical MVP/EH/COI build blocks. Duplication raises the odds that a future HTTP or packaging fix lands in only one memory model or variant.

Recommendation: isolate pointer loads/conversions in a small C++/JS compatibility helper or generate the repeated code from a variant table. In `bundle.mjs`, drive browser/node/worker builds from declarative variant metadata.

## What looks good

- Memory64 is opt-in, preserving wasm32 as the default.
- Build flags are propagated beyond the top-level link to dependency builds and loadable extensions.
- `WASMResponse` no longer stores wasm64 pointers in doubles.
- Pointer-bearing Emscripten library signatures were broadly changed to `p`, and `ccall` sites distinguish pointer/i64 arguments.
- Filesystem pointer arrays use eight-byte slots under wasm64.
- MVP, EH, and COI artifacts are built, smoke-tested, packaged, and browser-tested; Node integration covers MVP and EH, while COI is correctly treated as browser-only.
- The new tests cover useful end-to-end behavior, including Parquet, prepared statements, filesystem operations, scalar UDFs, and response buffers.
- Extension memory-model compatibility received an explicit diagnostic.

## Test gaps to add before release

1. Mixed wasm32 + wasm64 instances in one realm, initialized in both orders.
2. Pure unit tests of response/UDF layouts using synthetic pointer values above 2^32 and above 2^53 (the latter must either round-trip as BigInt or fail explicitly).
3. Bundle-selection negative cases; explicit wasm64 must never silently become wasm32.
4. Range checks for negative, oversized, and out-of-heap pointer/length pairs.
5. Large-file offsets above 4 GB for Node FS, HTTP range reads, OPFS, and Parquet, without requiring the complete file to reside in one JS buffer.
6. Package tarball/export tests for every advertised subpath and worker/Wasm asset.
7. Loadable-extension execution tests, not only build/link smoke coverage, for matching and mismatched memory models.
8. A release-mode build from a clean checkout with no pre-existing generated glue.

## Suggested PR split

The current 30-commit, 67-file stack mixes build enablement, ABI redesign, runtime changes, generated artifacts, packaging, CI, and broad integration tests. A more reviewable sequence would be:

1. **Toolchain and dependency preparation** — CI image/Node/Emscripten updates, reliable patch application, lockfile repair, dependency flag propagation. No public API or runtime behavior.
2. **Core CMake/Make Memory64 build** — `WASM_MEMORY64`, platform naming, build targets, extension configuration propagation, and one MVP build smoke test. Keep generated binaries out of the source diff.
3. **C++ ↔ JS ABI primitives** — `WASMResponse`, per-module memory-model metadata, Emscripten signatures, checked pointer helpers, ABI `static_assert`s, and focused unit tests. Include the UDF ABI migration here or in its own immediately following PR.
4. **Filesystem/HTTP runtime migration** — JS stubs, Node/browser runtimes, HTTP `EM_ASM` conversion, large-offset tests, and explicit documented limits.
5. **TypeScript binding API** — pointer/handle types, prepared statements, worker message types, bundle feature detection and selection, blocking/async construction, mixed-instance regression tests.
6. **Variant builds and loadable extensions** — EH/COI variants, pthread bootstrap, extension link flags and compatibility diagnostics, extension execution tests.
7. **Packaging and documentation** — bundle matrix refactor, package exports, CDN bundle definitions, README and examples, tarball verification.
8. **CI integration matrix** — Node 24 and browser integration suites for MVP/EH/COI, Parquet and >4 GB sparse/streamed file cases. Keep this mostly workflow/test code so failures are easy to attribute.

If eight PRs are too granular, combine 1+2, 3+4, and 7+8. I would not combine the ABI/runtime migration with packaging and CI because it makes correctness review much harder and produces a stack where late fixup commits obscure which layer introduced a failure.

## Validation performed

- `git diff --check origin/main...HEAD`: passed.
- TypeScript: `node_modules/.bin/tsc -p packages/duckdb-wasm/tsconfig.json --noEmit`: passed.
- ESLint: failed with 623 errors, predominantly generated wasm64 glue plus the two source unused imports described above.
- `node scripts/wasm64_smoke_test.js mvp64` under local Node v22.11.0: could not validate the Memory64 binary (`invalid table elements limits flags`). The branch CI intentionally uses Node 24, so this is recorded as an environment limitation rather than a branch defect.
- Full wasm64 Jasmine and browser suites were not rerun locally because `yarn` is not directly installed and the local Node version is below the branch's CI target. Existing built artifacts and test sources were inspected.
- Existing dirty submodule worktree state (`submodules/duckdb`, `submodules/rapidjson`) was left untouched.

Follow-up validation after resolving the findings:

- TypeScript `--noEmit`: passed.
- Package ESLint (`src test`): passed.
- `bundle.mjs` syntax check: passed. A full local package bundle was blocked because the worktree does not contain the generated wasm32 glue files required by the pre-existing bundle script.
- Docker/Emscripten `make wasm64_dev`: the MVP64 build completed and linked successfully; the command was stopped during the subsequent clean EH64 dependency rebuild to avoid repeating the already validated full toolchain build.
- The host Node v22.11 smoke test still cannot parse the Memory64 table encoding; CI uses Node 24 for this test.

## Merge recommendation

**Changes requested.** Fix findings 1-4 before merge. Treat the UDF pointer representation as release-blocking if WASM64 is advertised as generally 64-bit-pointer-safe; otherwise clearly mark scalar UDFs experimental/limited and schedule the ABI migration before users can depend on it. The checked-conversion and ABI-layout recommendations should land before attempting workloads whose memory or file offsets exceed wasm32-era limits.

## Resolution update

All eight findings were accepted and addressed in the follow-up hardening pass: memory-model state is module-local; UDF pointer tables use `uintptr_t`; explicit wasm64 selection rejects fallback; lint ignores generated glue and passes; heap and host-offset conversions are checked; registered-buffer sizes and filesystem offsets use width-appropriate ABI types; response/file layouts have compile-time assertions; and wasm64 browser bundling is driven by a shared variant table. Regression tests cover module-local state, checked ranges, and explicit bundle-selection failure.
