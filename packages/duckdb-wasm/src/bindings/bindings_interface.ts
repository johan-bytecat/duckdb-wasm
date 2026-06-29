import { DuckDBConfig, DuckDBConnection, DuckDBDataProtocol, FileStatistics, InstantiationProgress } from '.';
import { CSVInsertOptions, JSONInsertOptions, ArrowInsertOptions } from './insert_options';
import { ScriptTokens } from './tokens';
import { WebFile } from './web_file';
import * as arrow from 'apache-arrow';

export interface DuckDBBindings {
    open(config: DuckDBConfig): void;
    reset(): void;
    instantiate(onProgress: (p: InstantiationProgress) => void): Promise<this>;

    getVersion(): string;
    getFeatureFlags(): number;
    tokenize(text: string): ScriptTokens;

    connect(): DuckDBConnection;
    disconnect(conn: number | bigint): void;
    runQuery(conn: number | bigint, text: string): Uint8Array;
    startPendingQuery(conn: number | bigint, text: string, allowStreamResult: boolean): Uint8Array | null;
    pollPendingQuery(conn: number | bigint): Uint8Array | null;
    cancelPendingQuery(conn: number | bigint): boolean;
    fetchQueryResults(conn: number | bigint): Uint8Array | null;
    getTableNames(conn: number | bigint, text: string): string[];

    createPrepared(conn: number | bigint, text: string): number | bigint;
    closePrepared(conn: number | bigint, statement: number | bigint): void;
    runPrepared(conn: number | bigint, statement: number | bigint, params: any[]): Uint8Array;
    sendPrepared(conn: number | bigint, statement: number | bigint, params: any[]): Uint8Array;

    createScalarFunction(conn: number | bigint, name: string, returns: arrow.DataType, func: (...args: any[]) => void): void;

    insertArrowFromIPCStream(conn: number | bigint, buffer: Uint8Array, options?: ArrowInsertOptions): void;
    insertCSVFromPath(conn: number | bigint, path: string, options: CSVInsertOptions): void;
    insertJSONFromPath(conn: number | bigint, path: string, options: JSONInsertOptions): void;

    registerFileURL(name: string, url: string, proto: DuckDBDataProtocol, directIO: boolean): void;
    registerFileText(name: string, text: string): void;
    registerFileBuffer(name: string, buffer: Uint8Array): void;
    registerFileHandle<HandleType>(
        name: string,
        handle: HandleType,
        protocol: DuckDBDataProtocol,
        directIO: boolean,
    ): void;
    registerFileHandleAsync<HandleType>(
        name: string,
        handle: HandleType,
        protocol: DuckDBDataProtocol,
        directIO: boolean,
    ): Promise<void>;
    prepareFileHandleAsync<HandleType>(
        name: string,
        handle: HandleType,
        protocol: DuckDBDataProtocol,
        directIO: boolean,
    ): Promise<HandleType>;
    prepareFileHandle(path: string, protocol: DuckDBDataProtocol): Promise<void>;
    prepareDBFileHandle(path: string, protocol: DuckDBDataProtocol): Promise<void>;
    globFiles(path: string): WebFile[];
    dropFile(name: string): void;
    dropFiles(names?: string[]): void;
    flushFiles(): void;
    copyFileToPath(name: string, path: string): void;
    copyFileToBuffer(name: string): Uint8Array;
    registerOPFSFileName(file: string): Promise<void>;
    collectFileStatistics(file: string, enable: boolean): void;
    exportFileStatistics(file: string): FileStatistics;
}
