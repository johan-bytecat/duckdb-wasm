import * as duckdb from '../src/';
import * as arrow from 'apache-arrow';

function getIsWasm64(): boolean {
    return duckdb.isWasm64;
}

export function testWasm64Integration(db: () => duckdb.DuckDBBindings): void {
    let conn: duckdb.DuckDBConnection;

    beforeEach(() => {
        conn = db().connect();
    });

    afterEach(() => {
        conn.close();
        db().flushFiles();
        db().dropFiles();
    });

    describe('WASM64 Integration Tests (Blocking)', () => {
        describe('File I/O Edge Cases', () => {
            it('register empty file buffer', () => {
                const empty = new Uint8Array(0);
                db().registerFileBuffer('empty.txt', empty);
                const result = db().globFiles('empty*');
                expect(result.length).toBeGreaterThanOrEqual(1);
                expect(result.some((f: duckdb.WebFile) => f.fileName === 'empty.txt')).toBeTrue();
            });

            it('register file text', () => {
                db().registerFileText('hello.csv', 'a,b,c\n1,2,3\n');
                const buf = db().copyFileToBuffer('hello.csv');
                expect(buf).not.toBeNull();
                expect(buf!.length).toBeGreaterThan(0);
            });

            it('drop file by name', () => {
                db().registerFileText('temp_file.csv', 'a\n1\n');
                const before = db().globFiles('temp_file*');
                expect(before.length).toBeGreaterThanOrEqual(1);

                db().dropFile('temp_file.csv');
                const after = db().globFiles('temp_file*');
                expect(after.length).toEqual(0);
            });

            it('drop files', () => {
                db().registerFileText('f1.txt', 'data1');
                db().registerFileText('f2.txt', 'data2');
                db().registerFileText('f3.txt', 'data3');
                const before = db().globFiles('f*.txt');
                expect(before.length).toBeGreaterThanOrEqual(3);

                db().dropFiles(['f1.txt', 'f2.txt', 'f3.txt']);
                const after = db().globFiles('f*.txt');
                expect(after.length).toEqual(0);
            });

            it('glob files returns correct list', () => {
                db().registerFileText('/tmp/dir_a/file1.csv', 'a\n1\n');
                db().registerFileText('/tmp/dir_a/file2.csv', 'a\n2\n');
                db().registerFileText('/tmp/dir_b/other.txt', 'text');

                const results = db().globFiles('/tmp/dir_a/*');
                expect(results.length).toBeGreaterThanOrEqual(2);
                const names = results.map((f: duckdb.WebFile) => f.fileName).sort();
                expect(names.find((n: string) => n.includes('file1.csv'))).toBeDefined();
                expect(names.find((n: string) => n.includes('file2.csv'))).toBeDefined();
            });

            it('copy file to buffer', () => {
                db().registerFileText('buffer_test.txt', 'hello wasm64');
                const buf = db().copyFileToBuffer('buffer_test.txt');
                expect(buf).not.toBeNull();
                const text = new TextDecoder().decode(buf!);
                expect(text).toEqual('hello wasm64');
            });

            it('file statistics collection', () => {
                db().registerFileText('stats_test.csv', 'a,b\n1,2\n3,4\n');
                db().collectFileStatistics('stats_test.csv', true);

                conn.query(`SELECT * FROM read_csv_auto('stats_test.csv')`);

                const stats = db().exportFileStatistics('stats_test.csv');
                expect(stats).not.toBeNull();
                expect(stats.totalFileReadsCached).toBeGreaterThanOrEqual(0);
                expect(stats.blockSize).toBeGreaterThan(0);
                db().collectFileStatistics('stats_test.csv', false);
            });
        });

        describe('CSV Import', () => {
            it('read_csv_auto basic', () => {
                db().registerFileText('csv_basic.csv', 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n');
                const result = conn.query(`SELECT * FROM read_csv_auto('csv_basic.csv')`);
                expect(result.numRows).toEqual(3);
                expect(result.numCols).toEqual(3);
                expect(result.getChildAt(0)?.toArray()).toEqual(new Int32Array([1, 4, 7]));
            });

            it('read_csv_auto with quoted fields', () => {
                db().registerFileText('csv_quoted.csv',
                    '"a","b","c"\n"hello, world","42","true"\n"foo","bar","baz"\n');
                const result = conn.query(`SELECT * FROM read_csv_auto('csv_quoted.csv')`);
                expect(result.numRows).toEqual(2);
                expect(result.schema.fields[0].name).toEqual('a');
                expect(result.schema.fields[1].name).toEqual('b');
                expect(result.schema.fields[2].name).toEqual('c');
            });

            it('read_csv_auto empty file', () => {
                db().registerFileText('csv_empty.csv', 'column1,column2\n');
                const result = conn.query(`SELECT * FROM read_csv_auto('csv_empty.csv')`);
                expect(result.numRows).toEqual(0);
                expect(result.numCols).toEqual(2);
            });

            it('read_csv_auto with different delimiter', () => {
                db().registerFileText('csv_semicolon.csv', 'a;b;c\n1;2;3\n4;5;6\n');
                const result = conn.query(`SELECT * FROM read_csv_auto('csv_semicolon.csv')`);
                expect(result.numRows).toEqual(2);
                expect(result.numCols).toEqual(3);
            });
        });

        describe('JSON Import', () => {
            it('read_json basic', () => {
                db().registerFileText('json_basic.json',
                    '{"id":1,"name":"alice"}\n{"id":2,"name":"bob"}\n{"id":3,"name":"carol"}\n');
                const result = conn.query(`SELECT * FROM read_json_auto('json_basic.json') ORDER BY id`);
                expect(result.numRows).toEqual(3);
                expect(result.getChildAt(0)?.get(0)).toEqual(1);
                expect(result.getChildAt(1)?.get(0)).toEqual('alice');
            });

            it('read_json with nested objects', () => {
                db().registerFileText('json_nested.json',
                    '{"id":1,"data":{"x":10,"y":20}}\n{"id":2,"data":{"x":30,"y":40}}\n');
                const result = conn.query(`SELECT id, data->>'$.x' AS x FROM read_json_auto('json_nested.json') ORDER BY id`);
                expect(result.numRows).toEqual(2);
                expect(result.getChildAt(0)?.get(0)).toEqual(1);
            });

            it('read_json with arrays', () => {
                db().registerFileText('json_array.json',
                    '{"id":1,"tags":["a","b","c"]}\n{"id":2,"tags":["d","e"]}\n');
                const result = conn.query(`SELECT id FROM read_json_auto('json_array.json') ORDER BY id`);
                expect(result.numRows).toEqual(2);
            });
        });

        describe('Prepared Statements', () => {
            it('prepared statement create, run, close', () => {
                const stmt = conn.prepare('SELECT ?::INTEGER + v::INTEGER AS val FROM generate_series(1, 10) t(v)');
                const r1 = stmt.query(100);
                expect(r1.numRows).toEqual(10);
                expect(r1.getChildAt(0)?.get(0)).toEqual(101);

                const r2 = stmt.query(200);
                expect(r2.getChildAt(0)?.get(0)).toEqual(201);

                const r3 = stmt.query(-50);
                expect(r3.getChildAt(0)?.get(0)).toEqual(-49);

                stmt.close();
            });

            it('prepared statement send (streaming)', () => {
                const stmt = conn.prepare('SELECT ?::INTEGER + v::INTEGER AS val FROM generate_series(1, 100) t(v)');
                const stream = stmt.send(1000);
                let totalRows = 0;
                for (const batch of stream) {
                    totalRows += batch.numRows;
                }
                expect(totalRows).toEqual(100);
                stmt.close();
            });
        });

        describe('UDF', () => {
            it('UDF doubles integer input', () => {
                conn.createScalarFunction('wasm64_double', new arrow.Int32(), (a: number) => a * 2);

                const result = conn.query(`
                    SELECT max(wasm64_double(v::INTEGER))::INTEGER AS foo
                    FROM generate_series(1, 100) as t(v)`);
                expect(result.numRows).toEqual(1);
                expect(result.getChildAt(0)?.get(0)).toEqual(200);
            });

            it('UDF with string input', () => {
                conn.createScalarFunction('wasm64_strlen', new arrow.Int32(),
                    (s: string) => s ? s.length : -1);

                const result = conn.query(`
                    SELECT max(wasm64_strlen('hello_' || v::VARCHAR))::INTEGER AS foo
                    FROM generate_series(1, 50) as t(v)`);
                expect(result.numRows).toEqual(1);
                expect(result.getChildAt(0)?.get(0)).toBeGreaterThan(0);
            });
        });

        describe('Large Result Sets', () => {
            it('query with 500k rows materialized', () => {
                const result = conn.query(
                    `SELECT i::INTEGER AS v FROM generate_series(1, 500000) t(i)`,
                );
                expect(result.numRows).toEqual(500000);
                expect(result.getChildAt(0)?.get(0)).toEqual(1);
                expect(result.getChildAt(0)?.get(499999)).toEqual(500000);
            });
        });
    });
}

export function testWasm64IntegrationAsync(db: () => duckdb.AsyncDuckDB): void {
    let conn: duckdb.AsyncDuckDBConnection;

    beforeEach(async () => {
        conn = await db().connect();
    });

    afterEach(async () => {
        await conn.close();
        await db().flushFiles();
        await db().dropFiles();
    });

    describe('WASM64 Integration Tests (Async)', () => {
        describe('File I/O Edge Cases (Async)', () => {
            it('register large buffer (>1MB)', async () => {
                const size = 2 * 1024 * 1024;
                const buf = new Uint8Array(size);
                crypto.getRandomValues(buf);
                await db().registerFileBuffer('large_bin.bin', buf);
                const out = await db().copyFileToBuffer('large_bin.bin');
                expect(out).not.toBeNull();
                expect(out!.length).toEqual(size);
            });

            it('async glob files', async () => {
                await db().registerFileText('/tmp/wasm64/a.txt', 'a');
                await db().registerFileText('/tmp/wasm64/b.txt', 'b');
                const results = await db().globFiles('/tmp/wasm64/*');
                expect(results.length).toBeGreaterThanOrEqual(2);
            });

            it('copy file to buffer and verify content', async () => {
                await db().registerFileText('content_test.txt', 'unique content for wasm64');
                const buf = await db().copyFileToBuffer('content_test.txt');
                const text = new TextDecoder().decode(buf!);
                expect(text).toEqual('unique content for wasm64');
            });
        });

        describe('CSV Import (Async)', () => {
            it('read_csv_auto from buffer', async () => {
                const csvData = 'id,name,score\n1,alice,95\n2,bob,87\n3,carol,92\n4,dave,78\n5,eve,99\n';
                await db().registerFileText('scores.csv', csvData);
                const result = await conn.query(`SELECT * FROM read_csv_auto('scores.csv') ORDER BY id`);
                expect(result.numRows).toEqual(5);
                expect(result.numCols).toEqual(3);
            });

            it('read_csv_auto with type detection', async () => {
                await db().registerFileText('types.csv',
                    'int_col,float_col,str_col,bool_col\n1,1.5,hello,true\n2,2.5,world,false\n');
                const result = await conn.query(`SELECT * FROM read_csv_auto('types.csv')`);
                expect(result.numRows).toEqual(2);
                expect(result.numCols).toEqual(4);
            });
        });

        describe('JSON Import (Async)', () => {
            it('read_json_auto with nested fields', async () => {
                await db().registerFileText('nested.json',
                    '{"user":{"name":"alice","age":30},"active":true}\n' +
                    '{"user":{"name":"bob","age":25},"active":false}\n');
                const result = await conn.query(
                    `SELECT user->>'$.name' AS name, user->>'$.age' AS age FROM read_json_auto('nested.json') ORDER BY age`);
                expect(result.numRows).toEqual(2);
                expect(result.getChildAt(0)?.get(0)).toEqual('bob');
                expect(result.getChildAt(0)?.get(1)).toEqual('alice');
            });
        });

        describe('Prepared Statements (Async)', () => {
            it('create, run multiple times with different params, close', async () => {
                const stmt = await conn.prepare(
                    'SELECT ?::INTEGER + v::INTEGER AS val FROM generate_series(1, 50) t(v)',
                );
                const r1 = await stmt.query(1);
                expect(r1.numRows).toEqual(50);
                const r2 = await stmt.query(100);
                expect(r2.numRows).toEqual(50);
                expect(r2.getChildAt(0)?.get(0)).toEqual(101);
                const r3 = await stmt.query(1000);
                expect(r3.numRows).toEqual(50);
                expect(r3.getChildAt(0)?.get(0)).toEqual(1001);
                await stmt.close();
            });

            it('async prepared send (streaming)', async () => {
                const stmt = await conn.prepare(
                    'SELECT ?::INTEGER + v::INTEGER AS val FROM generate_series(1, 200) t(v)',
                );
                const stream = await stmt.send(500);
                let totalRows = 0;
                for await (const batch of stream) {
                    totalRows += batch.numRows;
                }
                expect(totalRows).toEqual(200);
                await stmt.close();
            });
        });

        describe('Large Streaming Results', () => {
            it('stream 1 million rows', async () => {
                const stream = await conn.send(
                    `SELECT i::INTEGER AS v FROM generate_series(1, 1000000) t(i)`,
                );
                let batchCount = 0;
                let totalRows = 0;
                for await (const batch of stream) {
                    batchCount++;
                    totalRows += batch.numRows;
                }
                expect(totalRows).toEqual(1000000);
                expect(batchCount).toBeGreaterThanOrEqual(1);
            });
        });

        describe('WASM64 Memory Growth', () => {
            it('verify wasm memory can be inspected', async () => {
                await conn.useUnsafe(
                    (_bindings: duckdb.AsyncDuckDB, _connId: number | bigint) => {
                        return null;
                    },
                );
            }, 5000);

            it('large table creation and query', async () => {
                const IS_WASM64 = getIsWasm64();
                const rowCount = IS_WASM64 ? 2000000 : 500000;

                await conn.query(`CREATE TABLE big_table AS
                    SELECT i::INTEGER AS id,
                           repeat('x', 200) AS pad
                    FROM generate_series(1, ${rowCount}) t(i)`);

                const count = await conn.query(`SELECT count(*)::INTEGER AS c FROM big_table`);
                expect(count.getChildAt(0)?.get(0)).toEqual(rowCount);

                const result = await conn.query(
                    `SELECT id FROM big_table WHERE id = 1 OR id = ${rowCount} ORDER BY id`,
                );
                expect(result.numRows).toEqual(2);
                expect(result.getChildAt(0)?.get(0)).toEqual(1);
                expect(result.getChildAt(0)?.get(1)).toEqual(rowCount);
            });

            it('memory growth test', async () => {
                if (!getIsWasm64()) {
                    pending('WASM64 memory growth test requires WASM64 build');
                    return;
                }

                const rowCount = 1000000;
                const padLen = 1000;

                await conn.query(`CREATE TABLE mem_grow AS
                    SELECT i::INTEGER AS id,
                           repeat('X', ${padLen}) AS data_col
                    FROM generate_series(1, ${rowCount}) t(i)`);

                const count = await conn.query(`SELECT count(*)::INTEGER AS c FROM mem_grow`);
                expect(count.getChildAt(0)?.get(0)).toEqual(rowCount);
            });
        });
    });
}
