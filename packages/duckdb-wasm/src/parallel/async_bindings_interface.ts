import { Logger } from '../log';
import { CSVInsertOptions, JSONInsertOptions } from '../bindings/insert_options';
import { DuckDBDataProtocol } from '../bindings';

/** An interface for the async DuckDB bindings */
export interface AsyncDuckDBBindings {
    logger: Logger;

    registerFileURL(name: string, url: string, proto: DuckDBDataProtocol, directIO: boolean): Promise<void>;
    registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
    registerFileHandle<HandleType>(
        name: string,
        handle: HandleType,
        protocol: DuckDBDataProtocol,
        directIO: boolean,
    ): Promise<void>;
    copyFileToPath(name: string, out: string): Promise<void>;
    copyFileToBuffer(name: string): Promise<Uint8Array>;

    disconnect(conn: number | bigint): Promise<void>;
    runQuery(conn: number | bigint, text: string): Promise<Uint8Array>;
    startPendingQuery(conn: number | bigint, text: string, allowStreamResult: boolean): Promise<Uint8Array | null>;
    pollPendingQuery(conn: number | bigint): Promise<Uint8Array | null>;
    cancelPendingQuery(conn: number | bigint): Promise<boolean>;
    fetchQueryResults(conn: number | bigint): Promise<Uint8Array | null>;

    createPrepared(conn: number | bigint, text: string): Promise<number | bigint>;
    closePrepared(conn: number | bigint, statement: number | bigint): Promise<void>;
    runPrepared(conn: number | bigint, statement: number | bigint, params: any[]): Promise<Uint8Array>;
    sendPrepared(conn: number | bigint, statement: number | bigint, params: any[]): Promise<Uint8Array>;

    insertArrowFromIPCStream(conn: number | bigint, buffer: Uint8Array, options?: CSVInsertOptions): Promise<void>;
    insertCSVFromPath(conn: number | bigint, path: string, options: CSVInsertOptions): Promise<void>;
    insertJSONFromPath(conn: number | bigint, path: string, options: JSONInsertOptions): Promise<void>;

    dropFile(name: string):Promise<null>;
    dropFiles(names?: string[]):Promise<null>;
}
