import { DuckDBModule } from './duckdb_module';
import { UDFFunction } from './udf_function';
import * as udf_rt from './udf_runtime';

export let isWasm64 = false;

export function setMemoryModel(mod: DuckDBModule): void {
    const ptr = mod._malloc(1) as any;
    isWasm64 = typeof ptr === 'bigint';
    mod._free(ptr);
}

export function checkWasm64Support(): boolean {
    try {
        if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
            return false;
        }
        const bytes = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x05, 0x04, 0x01, 0x10, 0x00,
        ]);
        return WebAssembly.validate(bytes);
    } catch {
        return false;
    }
}

/** Wrapper for TextDecoder to support shared array buffers */
function TextDecoderWrapper(): (input?: BufferSource) => string {
    const decoder = new TextDecoder();
    return (data: any) => {
        if (typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer) {
            data = new Uint8Array(data);
        }
        return decoder.decode(data);
    };
}
/** Helper to decode text */
export const decodeText = TextDecoderWrapper();

/** Copy a buffer */
export function failWith(mod: DuckDBModule, msg: string): void {
    console.error(`FAIL WITH: ${msg}`);
    mod.ccall('duckdb_web_fail_with', null, ['string'], [msg]);
}

/** Copy a buffer */
export function copyBuffer(mod: DuckDBModule, begin: number | bigint, length: number | bigint): Uint8Array {
    if (typeof begin === 'bigint') {
        return copyBuffer64(mod, begin, length as bigint);
    }
    const buffer = mod.HEAPU8.subarray(begin, begin + (length as number));
    const copy = new Uint8Array(new ArrayBuffer(buffer.byteLength));
    copy.set(buffer);
    return copy;
}

/** Decode a string */
export function readString(mod: DuckDBModule, begin: number | bigint, length: number | bigint): string {
    if (typeof begin === 'bigint') {
        return readString64(mod, begin, length as bigint);
    }
    return decodeText(mod.HEAPU8.subarray(begin, begin + (length as number)));
}

/** Copy a buffer from WASM64 heap */
export function copyBuffer64(mod: DuckDBModule, begin: bigint, length: bigint): Uint8Array {
    const start = Number(begin);
    const end = Number(begin + length);
    const buffer = mod.HEAPU8.subarray(start, end);
    const copy = new Uint8Array(new ArrayBuffer(buffer.byteLength));
    copy.set(buffer);
    return copy;
}

/** Decode a string from WASM64 heap */
export function readString64(mod: DuckDBModule, begin: bigint, length: bigint): string {
    const start = Number(begin);
    const end = Number(begin + length);
    return decodeText(mod.HEAPU8.subarray(start, end));
}

/** The data protocol */
export enum DuckDBDataProtocol {
    BUFFER = 0,
    NODE_FS = 1,
    BROWSER_FILEREADER = 2,
    BROWSER_FSACCESS = 3,
    HTTP = 4,
    S3 = 5,
}

/** File flags for opening files*/
export enum FileFlags {
    //! Open file with read access
    FILE_FLAGS_READ = 1 << 0,
    //! Open file with write access
    FILE_FLAGS_WRITE = 1 << 1,
    //! Use direct IO when reading/writing to the file
    FILE_FLAGS_DIRECT_IO = 1 << 2,
    //! Create file if not exists, can only be used together with WRITE
    FILE_FLAGS_FILE_CREATE = 1 << 3,
    //! Always create a new file. If a file exists, the file is truncated. Cannot be used together with CREATE.
    FILE_FLAGS_FILE_CREATE_NEW = 1 << 4,
    //! Open file in append mode
    FILE_FLAGS_APPEND = 1 << 5,
    FILE_FLAGS_PRIVATE = 1 << 6,
    FILE_FLAGS_NULL_IF_NOT_EXISTS = 1 << 7,
    FILE_FLAGS_PARALLEL_ACCESS = 1 << 8,
    FILE_FLAGS_EXCLUSIVE_CREATE = 1 << 9,
    FILE_FLAGS_NULL_IF_EXISTS = 1 << 10
}

/** Configuration for the AWS S3 Filesystem */
export interface S3Config {
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
}

/** An info for a file registered with DuckDB */
export interface DuckDBFileInfo {
    cacheEpoch: number;
    fileId: number;
    fileName: string;
    dataProtocol: DuckDBDataProtocol;
    dataUrl: string | null;
    reliableHeadRequests?: boolean;
    allowFullHttpReads?: boolean;
    forceFullHttpReads?: boolean;
    s3Config?: S3Config;
}

/** Global info for all files registered with DuckDB */
export interface DuckDBGlobalFileInfo {
    cacheEpoch: number;
    reliableHeadRequests?: boolean;
    allowFullHttpReads?: boolean;
    forceFullHttpReads?: boolean;
    s3Config?: S3Config;
}

export interface PreparedDBFileHandle {
    path: string;
    handle: any;
    fromCached: boolean;
}

function callSRet32(
    mod: DuckDBModule,
    funcName: string,
    argTypes: Array<Emscripten.JSType>,
    args: Array<any>,
): [number, number, number] {
    const stackPointer = mod.stackSave();

    // Allocate the packed response buffer
    const response = mod.stackAlloc(3 * 8);
    argTypes.unshift('number');
    args.unshift(response);

    // Do the call
    mod.ccall(funcName, null, argTypes, args);

    // Read the response
    const status = mod.HEAPF64[(response >> 3) + 0];
    const data = mod.HEAPF64[(response >> 3) + 1];
    const dataSize = mod.HEAPF64[(response >> 3) + 2];

    // Restore the stack
    mod.stackRestore(stackPointer);
    return [status, data, dataSize];
}

function callSRet64(
    mod: DuckDBModule,
    funcName: string,
    argTypes: Array<Emscripten.JSType>,
    args: Array<any>,
): [number, bigint, bigint] {
    const stackPointer = mod.stackSave() as any;
    const response = mod.stackAlloc(24) as any;
    argTypes.unshift('number');
    args.unshift(response);
    mod.ccall(funcName, null, argTypes, args);
    const view = new DataView(mod.HEAPU8.buffer);
    const offset = Number(response);
    const status = Number(view.getBigInt64(offset, true));
    const data = view.getBigInt64(offset + 8, true);
    const dataSize = view.getBigInt64(offset + 16, true);
    mod.stackRestore(stackPointer);
    return [status, data, dataSize];
}

function packSRet32(mod: DuckDBModule, response: number, a: number, b: number, c: number): void {
    mod.HEAPF64[(response >> 3) + 0] = a;
    mod.HEAPF64[(response >> 3) + 1] = b;
    mod.HEAPF64[(response >> 3) + 2] = c;
}

function packSRet64(mod: DuckDBModule, response: number | bigint, a: number | bigint, b: number | bigint, c: number | bigint): void {
    const view = new DataView(mod.HEAPU8.buffer);
    const offset = Number(response);
    view.setBigInt64(offset, BigInt(a), true);
    view.setBigInt64(offset + 8, BigInt(b), true);
    view.setBigInt64(offset + 16, BigInt(c), true);
}

/** Write values into a packed response buffer */
export function packSRet(mod: DuckDBModule, response: number | bigint, a: number | bigint, b: number | bigint, c: number | bigint): void {
    if (isWasm64) {
        packSRet64(mod, response, a, b, c);
    } else {
        packSRet32(mod, response as number, a as number, b as number, c as number);
    }
}

/** Call a function with packed response buffer */
export function callSRet(
    mod: DuckDBModule,
    funcName: string,
    argTypes: Array<Emscripten.JSType>,
    args: Array<any>,
): [number, number | bigint, number | bigint] {
    if (isWasm64) {
        return callSRet64(mod, funcName, argTypes, args);
    }
    return callSRet32(mod, funcName, argTypes, args);
}

/** Drop response buffers */
export function dropResponseBuffers(mod: DuckDBModule): void {
    mod.ccall('duckdb_web_clear_response', null, [], []);
}

/** The duckdb runtime */
export interface DuckDBRuntime {
    _files?: Map<string, any>;
    _udfFunctions: Map<number, UDFFunction>;

    // Test a platform feature
    testPlatformFeature(mod: DuckDBModule, feature: number): boolean;

    // File APIs with dedicated file identifier
    getDefaultDataProtocol(mod: DuckDBModule): number;
    openFile(mod: DuckDBModule, fileId: number, flags: FileFlags): void;
    syncFile(mod: DuckDBModule, fileId: number): void;
    closeFile(mod: DuckDBModule, fileId: number): void;
    dropFile(mod: DuckDBModule, fileNamePtr: number | bigint, fileNameLen: number): void;
    getLastFileModificationTime(mod: DuckDBModule, fileId: number): number;
    truncateFile(mod: DuckDBModule, fileId: number, newSize: number): void;
    readFile(mod: DuckDBModule, fileId: number, buffer: number | bigint, bytes: number, location: number): number;
    writeFile(mod: DuckDBModule, fileId: number, buffer: number | bigint, bytes: number, location: number): number;

    // File APIs with path parameter
    removeDirectory(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): void;
    checkDirectory(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): boolean;
    createDirectory(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): void;
    listDirectoryEntries(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): boolean;
    glob(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): void;
    moveFile(mod: DuckDBModule, fromPtr: number | bigint, fromLen: number, toPtr: number | bigint, toLen: number): void;
    checkFile(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): boolean;
    removeFile(mod: DuckDBModule, pathPtr: number | bigint, pathLen: number): void;

    // Prepare a file handle that could only be acquired aschronously
    prepareFileHandle?: (path: string, protocol: DuckDBDataProtocol) => Promise<PreparedDBFileHandle[]>;
    prepareFileHandles?: (path: string[], protocol: DuckDBDataProtocol) => Promise<PreparedDBFileHandle[]>;
    prepareDBFileHandle?: (path: string, protocol: DuckDBDataProtocol) => Promise<PreparedDBFileHandle[]>;

    // Internal API - experimental
    progressUpdate(final: number, percentage: number, iteration: number): void;

    // Call a scalar UDF function
    callScalarUDF(
        mod: DuckDBModule,
        response: number | bigint,
        funcId: number,
        descPtr: number | bigint,
        descSize: number,
        ptrsPtr: number | bigint,
        ptrsSize: number,
    ): void;
}

export const DEFAULT_RUNTIME: DuckDBRuntime = {
    _udfFunctions: new Map(),

    testPlatformFeature: (_mod: DuckDBModule, _feature: number): boolean => false,
    getDefaultDataProtocol: (_mod: DuckDBModule): number => DuckDBDataProtocol.BUFFER,
    openFile: (_mod: DuckDBModule, _fileId: number, flags: FileFlags): void => {},
    syncFile: (_mod: DuckDBModule, _fileId: number): void => {},
    closeFile: (_mod: DuckDBModule, _fileId: number): void => {},
    dropFile: (_mod: DuckDBModule, _fileNamePtr: number | bigint, _fileNameLen: number): void => {},
    getLastFileModificationTime: (_mod: DuckDBModule, _fileId: number): number => {
        return 0;
    },
    progressUpdate: (_final: number, _percentage: number, _iteration: number): void => {
        return;
    },
    truncateFile: (_mod: DuckDBModule, _fileId: number, _newSize: number): void => {},
    readFile: (_mod: DuckDBModule, _fileId: number, _buffer: number | bigint, _bytes: number, _location: number): number => {
        return 0;
    },
    writeFile: (_mod: DuckDBModule, _fileId: number, _buffer: number | bigint, _bytes: number, _location: number): number => {
        return 0;
    },

    removeDirectory: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): void => {},
    checkDirectory: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): boolean => {
        return false;
    },
    createDirectory: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): void => {},
    listDirectoryEntries: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): boolean => {
        return false;
    },
    glob: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): void => {},
    moveFile: (_mod: DuckDBModule, _fromPtr: number | bigint, _fromLen: number, _toPtr: number | bigint, _toLen: number): void => {},
    checkFile: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): boolean => {
        return false;
    },
    removeFile: (_mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number): void => {},
    callScalarUDF: (
        mod: DuckDBModule,
        response: number | bigint,
        funcId: number,
        descPtr: number | bigint,
        descSize: number,
        ptrsPtr: number | bigint,
        ptrsSize: number,
    ): void => {
        udf_rt.callScalarUDF(DEFAULT_RUNTIME, mod, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
    },
};
