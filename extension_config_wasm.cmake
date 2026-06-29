################################################################################
# DuckDB-Wasm extension base config
################################################################################
#
# Static extensions (DONT_LINK) are compiled as part of the main module and
# automatically pick up the WASM_MEMORY64 flag from CMake. They work
# identically under both WASM32 and WASM64.
#
# Dynamically-loaded extensions must be built with the same memory model as
# the main module: use `WASM_MEMORY64=1` when building side modules for a
# WASM64 main module. A WASM64 main module cannot load a WASM32 side module
# and vice versa.

duckdb_extension_load(json DONT_LINK)
duckdb_extension_load(parquet DONT_LINK)
duckdb_extension_load(autocomplete DONT_LINK)

duckdb_extension_load(icu DONT_LINK)
duckdb_extension_load(tpcds DONT_LINK)
duckdb_extension_load(tpch DONT_LINK)

#duckdb_extension_load(httpfs DONT_LINK)
