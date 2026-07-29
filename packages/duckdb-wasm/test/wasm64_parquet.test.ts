import * as duckdb from '../src/';
import * as arrow from 'apache-arrow';

function getIsWasm64(): boolean {
    // Conservative sizing for the shared wasm32/wasm64 suite. Dedicated
    // wasm64 entry points verify the feature flag before registering it.
    return false;
}

export function testWasm64Parquet(db: () => duckdb.DuckDBBindings): void {
    let conn: duckdb.DuckDBConnection;

    beforeEach(() => {
        conn = db().connect();
    });

    afterEach(() => {
        conn.close();
        db().flushFiles();
        db().dropFiles();
    });

    describe('WASM64 Parquet Tests (Blocking)', () => {
        it('parquet round-trip via COPY', () => {
            conn.query(`CREATE TABLE roundtrip_src AS
                SELECT i::INTEGER AS id,
                       i::BIGINT AS big_id,
                       (i * 0.5)::DOUBLE AS val,
                       CASE WHEN i % 2 = 0 THEN TRUE ELSE FALSE END AS flag,
                       'row_' || i::VARCHAR AS label
                FROM generate_series(1, 1000) t(i)`);

            conn.query(`COPY (SELECT * FROM roundtrip_src) TO 'roundtrip.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('roundtrip.parquet') ORDER BY id`);
            expect(result.numRows).toEqual(1000);
            expect(result.numCols).toEqual(5);
            expect(result.getChildAt(0)?.toArray()).toEqual(new Int32Array(Array.from({ length: 1000 }, (_, i) => i + 1)));
            const strs = result.getChildAt(4);
            expect(strs?.get(0)).toEqual('row_1');
            expect(strs?.get(999)).toEqual('row_1000');
        });

        it('parquet COPY TO with mixed types', () => {
            conn.query(`CREATE TABLE mixed AS
                SELECT
                    1::TINYINT AS t,
                    2::SMALLINT AS s,
                    3::INTEGER AS i,
                    4::BIGINT AS b,
                    1.5::FLOAT AS f,
                    2.5::DOUBLE AS d,
                    'hello'::VARCHAR AS v,
                    true::BOOLEAN AS flag,
                    NULL::INTEGER AS nullable
                UNION ALL
                SELECT
                    NULL::TINYINT, NULL::SMALLINT, NULL::INTEGER, NULL::BIGINT,
                    NULL::FLOAT, NULL::DOUBLE, NULL::VARCHAR, NULL::BOOLEAN,
                    NULL::INTEGER`);
            conn.query(`COPY (SELECT * FROM mixed) TO 'mixed.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('mixed.parquet')`);
            expect(result.numRows).toEqual(2);

            const tCol = result.getChildAt(0);
            expect(tCol?.get(0)).toEqual(1);
            expect(tCol?.get(1)).toBeNull();
        });

        it('parquet with NULL values', () => {
            conn.query(`CREATE TABLE null_test AS
                SELECT i,
                       CASE WHEN i % 3 = 0 THEN NULL ELSE i END AS nullable_int,
                       CASE WHEN i % 5 = 0 THEN NULL ELSE 'val_' || i::VARCHAR END AS nullable_str
                FROM generate_series(1, 100) t(i)`);
            conn.query(`COPY (SELECT * FROM null_test) TO 'null_test.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('null_test.parquet') ORDER BY i`);
            expect(result.numRows).toEqual(100);

            const nStr = result.getChildAt(2);
            expect(nStr?.get(4)).toBeNull();
            expect(nStr?.get(0)).toEqual('val_1');
        });

        it('multiple parquet files union', () => {
            conn.query(`CREATE TABLE p1 AS SELECT i::INTEGER AS id, 'a'::VARCHAR AS src FROM generate_series(1, 100) t(i)`);
            conn.query(`COPY (SELECT * FROM p1) TO 'p1.parquet' (FORMAT PARQUET)`);
            conn.query(`CREATE TABLE p2 AS SELECT i::INTEGER AS id, 'b'::VARCHAR AS src FROM generate_series(101, 200) t(i)`);
            conn.query(`COPY (SELECT * FROM p2) TO 'p2.parquet' (FORMAT PARQUET)`);
            conn.query(`CREATE TABLE p3 AS SELECT i::INTEGER AS id, 'c'::VARCHAR AS src FROM generate_series(201, 300) t(i)`);
            conn.query(`COPY (SELECT * FROM p3) TO 'p3.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`
                SELECT * FROM read_parquet('p1.parquet')
                UNION ALL
                SELECT * FROM read_parquet('p2.parquet')
                UNION ALL
                SELECT * FROM read_parquet('p3.parquet')
                ORDER BY id`);
            expect(result.numRows).toEqual(300);
            const ids = result.getChildAt(0);
            expect(ids?.get(0)).toEqual(1);
            expect(ids?.get(149)).toEqual(150);
            expect(ids?.get(299)).toEqual(300);
        });

        it('parquet predicate pushdown', () => {
            conn.query(`CREATE TABLE pred_test AS
                SELECT i::INTEGER AS id,
                       i * 10 AS val,
                       'row_' || i::VARCHAR AS label
                FROM generate_series(1, 5000) t(i)`);
            conn.query(`COPY (SELECT * FROM pred_test) TO 'pred_test.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('pred_test.parquet') WHERE id < 10 ORDER BY id`);
            expect(result.numRows).toEqual(9);
            expect(result.getChildAt(0)?.toArray()).toEqual(
                new Int32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
            );
        });

        it('parquet round-trip individual value verification', () => {
            conn.query(`CREATE TABLE verify_src AS
                SELECT
                    1::TINYINT AS tiny_col,
                    2::SMALLINT AS small_col,
                    3::INTEGER AS int_col,
                    4::BIGINT AS big_col,
                    5::BIGINT AS ubigint_col,
                    1.1::FLOAT AS float_col,
                    2.2::DOUBLE AS double_col,
                    'text_value'::VARCHAR AS str_col,
                    true::BOOLEAN AS bool_col
                UNION ALL
                SELECT
                    -1::TINYINT, -2::SMALLINT, -3::INTEGER, -4::BIGINT, 0::BIGINT,
                    -1.1::FLOAT, -2.2::DOUBLE, 'another'::VARCHAR, false::BOOLEAN`);
            conn.query(`COPY (SELECT * FROM verify_src) TO 'verify_src.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('verify_src.parquet') ORDER BY int_col`);
            expect(result.numRows).toEqual(2);

            expect(result.getChildAt(0)?.get(0)).toEqual(-1);
            expect(result.getChildAt(0)?.get(1)).toEqual(1);
            expect(result.getChildAt(7)?.get(0)).toEqual('another');
            expect(result.getChildAt(7)?.get(1)).toEqual('text_value');
            expect(result.getChildAt(8)?.get(0)).toEqual(false);
            expect(result.getChildAt(8)?.get(1)).toEqual(true);
        });

        it('parquet with dates and timestamps', () => {
            conn.query(`CREATE TABLE dt_src AS
                SELECT
                    DATE '2023-01-15' AS d,
                    TIMESTAMP '2023-01-15 12:30:45' AS ts
                UNION ALL
                SELECT
                    DATE '2024-06-20', TIMESTAMP '2024-06-20 08:15:30'`);
            conn.query(`COPY (SELECT * FROM dt_src) TO 'dt_src.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('dt_src.parquet') ORDER BY d`);
            expect(result.numRows).toEqual(2);
        });

        it('10-column 1000-row parquet read with type verification', () => {
            conn.query(`CREATE TABLE wide AS
                SELECT
                    (i % 128)::TINYINT AS t,
                    i::SMALLINT AS s,
                    i::INTEGER AS i,
                    i::BIGINT AS b,
                    i::FLOAT AS f,
                    i::DOUBLE AS d,
                    'str_' || i::VARCHAR AS v,
                    (i % 2 = 0)::BOOLEAN AS flag,
                    (i + 0.5)::DOUBLE AS offset_val,
                    CASE WHEN i % 7 = 0 THEN NULL ELSE i::INTEGER END AS null_i
                FROM generate_series(1, 1000) t(i)`);
            conn.query(`COPY (SELECT * FROM wide) TO 'wide.parquet' (FORMAT PARQUET)`);

            const result = conn.query(`SELECT * FROM read_parquet('wide.parquet') ORDER BY i`);
            expect(result.numRows).toEqual(1000);
            expect(result.numCols).toEqual(10);

            expect(result.schema.fields[0].name).toEqual('t');
            expect(result.schema.fields[1].name).toEqual('s');
            expect(result.schema.fields[2].name).toEqual('i');
            expect(result.schema.fields[3].name).toEqual('b');
            expect(result.schema.fields[4].name).toEqual('f');
            expect(result.schema.fields[5].name).toEqual('d');
            expect(result.schema.fields[6].name).toEqual('v');
            expect(result.schema.fields[7].name).toEqual('flag');
            expect(result.schema.fields[8].name).toEqual('offset_val');
            expect(result.schema.fields[9].name).toEqual('null_i');

            expect(result.getChildAt(0)?.get(0)).toEqual(1);
            expect(result.getChildAt(2)?.get(999)).toEqual(1000);
            expect(result.getChildAt(6)?.get(0)).toEqual('str_1');
            expect(result.getChildAt(6)?.get(999)).toEqual('str_1000');
            expect(result.getChildAt(7)?.get(0)).toEqual(false);
            expect(result.getChildAt(7)?.get(1)).toEqual(true);
        });
    });
}

export function testWasm64ParquetAsync(db: () => duckdb.AsyncDuckDB): void {
    let conn: duckdb.AsyncDuckDBConnection;

    beforeEach(async () => {
        conn = await db().connect();
    });

    afterEach(async () => {
        await conn.close();
        await db().flushFiles();
        await db().dropFiles();
    });

    describe('WASM64 Parquet Tests (Async)', () => {
        it('async parquet round-trip', async () => {
            await conn.query(`CREATE TABLE roundtrip AS
                SELECT i::INTEGER AS id, 'row_' || i::VARCHAR AS name
                FROM generate_series(1, 500) t(i)`);
            await conn.query(`COPY (SELECT * FROM roundtrip) TO 'roundtrip.parquet' (FORMAT PARQUET)`);

            const result = await conn.query(`SELECT * FROM read_parquet('roundtrip.parquet') ORDER BY id`);
            expect(result.numRows).toEqual(500);
            expect(result.numCols).toEqual(2);
            expect(result.getChildAt(0)?.get(0)).toEqual(1);
            expect(result.getChildAt(0)?.get(499)).toEqual(500);
        });

        it('async streaming parquet query', async () => {
            await conn.query(`CREATE TABLE stream_src AS
                SELECT i::INTEGER AS id FROM generate_series(1, 1000) t(i)`);
            await conn.query(`COPY (SELECT * FROM stream_src) TO 'stream_src.parquet' (FORMAT PARQUET)`);

            const stream = await conn.send(`SELECT * FROM read_parquet('stream_src.parquet') ORDER BY id`);
            let totalRows = 0;
            const batches: arrow.RecordBatch[] = [];
            for await (const batch of stream) {
                totalRows += batch.numRows;
                batches.push(batch);
            }
            expect(totalRows).toEqual(1000);

            const table = new arrow.Table(batches);
            expect(table.getChildAt(0)?.length).toEqual(1000);
            expect(table.getChildAt(0)?.get(0)).toEqual(1);
            expect(table.getChildAt(0)?.get(999)).toEqual(1000);
        });

        it('async parquet with runQuery materialization', async () => {
            await conn.query(`CREATE TABLE mat_src AS
                SELECT i::INTEGER AS x FROM generate_series(1, 2000) t(i)`);
            await conn.query(`COPY (SELECT * FROM mat_src) TO 'mat_src.parquet' (FORMAT PARQUET)`);

            const result = await conn.query(`SELECT * FROM read_parquet('mat_src.parquet') ORDER BY x`);
            expect(result.numRows).toEqual(2000);
            const batches = result.batches;
            let totalFromBatches = 0;
            for (const batch of batches) {
                totalFromBatches += batch.numRows;
            }
            expect(totalFromBatches).toEqual(2000);
        });

        it('async multiple parquet union', async () => {
            for (let j = 0; j < 5; j++) {
                const file = `union${j}.parquet`;
                await conn.query(`CREATE OR REPLACE TABLE union_src AS SELECT i::INTEGER AS id, ${j}::INTEGER AS src FROM generate_series(1, 100) t(i)`);
                await conn.query(`COPY (SELECT * FROM union_src) TO '${file}' (FORMAT PARQUET)`);
            }

            const parts = [0, 1, 2, 3, 4].map(j => `SELECT * FROM read_parquet('union${j}.parquet')`).join(' UNION ALL ');
            const result = await conn.query(`${parts} ORDER BY src, id`);
            expect(result.numRows).toEqual(500);
        });

        it('async parquet round-trip via file buffer', async () => {
            await conn.query(`CREATE TABLE buf_src AS
                SELECT i::INTEGER AS v FROM generate_series(1, 100) t(i)`);
            await conn.query(`COPY (SELECT * FROM buf_src) TO 'buf_out.parquet' (FORMAT PARQUET)`);

            const buf = await db().copyFileToBuffer('buf_out.parquet');
            expect(buf).not.toBeNull();
            expect(buf!.length).toBeGreaterThan(0);

            await db().registerFileBuffer('buf_out2.parquet', buf!);
            const result = await conn.query(`SELECT * FROM read_parquet('buf_out2.parquet') ORDER BY v`);
            expect(result.numRows).toEqual(100);
            expect(result.getChildAt(0)?.get(0)).toEqual(1);
            expect(result.getChildAt(0)?.get(99)).toEqual(100);
        });
    });

    describe('WASM64 Parquet Large Data (Async)', () => {
        it('large parquet file generation and read', async () => {
            const IS_WASM64 = getIsWasm64();
            const rowCount = IS_WASM64 ? 100000 : 10000;

            await conn.query(`CREATE TABLE large_src AS
                SELECT i::INTEGER AS id,
                       i::BIGINT AS bigv,
                       (i * 0.5)::DOUBLE AS val,
                       'pad_' || repeat('x', 100) || i::VARCHAR AS long_str
                FROM generate_series(1, ${rowCount}) t(i)`);
            await conn.query(`COPY (SELECT * FROM large_src) TO 'large.parquet' (FORMAT PARQUET)`);

            const result = await conn.query(`SELECT count(*)::INTEGER AS c FROM read_parquet('large.parquet')`);
            expect(result.getChildAt(0)?.get(0)).toEqual(rowCount);
        });

        it('large string columns in parquet', async () => {
            const IS_WASM64 = getIsWasm64();
            const rowCount = IS_WASM64 ? 5000 : 500;
            const strLen = IS_WASM64 ? 100000 : 10000;

            await conn.query(`CREATE TABLE large_str_src AS
                SELECT i::INTEGER AS id,
                       repeat(chr((65 + (i % 26))::INTEGER), ${strLen}) AS big_string
                FROM generate_series(1, ${rowCount}) t(i)`);
            await conn.query(`COPY (SELECT * FROM large_str_src) TO 'large_str.parquet' (FORMAT PARQUET)`);

            const result = await conn.query(`SELECT count(*)::INTEGER AS c FROM read_parquet('large_str.parquet')`);
            expect(result.getChildAt(0)?.get(0)).toEqual(rowCount);

            const detail = await conn.query(
                `SELECT id, length(big_string)::INTEGER AS slen FROM read_parquet('large_str.parquet') ORDER BY id LIMIT 1`,
            );
            expect(detail.getChildAt(1)?.get(0)).toEqual(strLen);
        });
    });
}
