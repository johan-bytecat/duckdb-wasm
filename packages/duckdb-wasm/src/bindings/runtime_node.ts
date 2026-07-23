import fs from 'fs';
import {
    DuckDBRuntime,
    DuckDBFileInfo,
    callSRet,
    dropResponseBuffers,
    failWith,
    readString,
    decodeText,
    DuckDBDataProtocol,
    FileFlags,
    packFileInfo,
    isWasm64,
    checkWasm64Support,
} from './runtime';
import { StatusCode } from '../status';
import { DuckDBModule } from './duckdb_module';
import * as fg from 'fast-glob';
import * as udf from './udf_runtime';

export const NODE_RUNTIME: DuckDBRuntime & {
    _filesById: Map<number, any>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;

    resolveFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
} = {
    _files: new Map<string, any>(),
    _filesById: new Map<number, any>(),
    _fileInfoCache: new Map<number, DuckDBFileInfo>(),
    _udfFunctions: new Map(),

    resolveFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null {
        try {
            fileId = Number(fileId);
            const cached = NODE_RUNTIME._fileInfoCache.get(fileId);
            const [s, d, n] = callSRet(
                mod,
                'duckdb_web_fs_get_file_info_by_id',
                ['bigint', 'bigint'],
                [fileId, cached?.cacheEpoch || 0],
            );
            if (s !== StatusCode.SUCCESS) {
                failWith(mod, readString(mod, d, n));
                return null;
            } else if (Number(n) === 0) {
                // Epoch is up to date with WASM
                dropResponseBuffers(mod);
                return cached!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            const info = JSON.parse(infoStr) as DuckDBFileInfo;
            if (info == null) return null;
            NODE_RUNTIME._fileInfoCache.set(fileId, info);
            return info as DuckDBFileInfo;
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return null;
        }
    },
    testPlatformFeature: (_mod: DuckDBModule, feature: number): boolean => {
        switch (feature) {
            case 1:
                return typeof BigInt64Array !== 'undefined';
            default:
                console.warn(`test for unknown feature: ${feature}`);
                return false;
        }
    },
    getDefaultDataProtocol(mod: DuckDBModule): number {
        return DuckDBDataProtocol.NODE_FS;
    },
    openFile(mod: DuckDBModule, fileId: number, flags: FileFlags): number {
        try {
            fileId = Number(fileId);
            NODE_RUNTIME._fileInfoCache.delete(fileId);
            const file = NODE_RUNTIME.resolveFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                // Native file
                case DuckDBDataProtocol.NODE_FS: {
                    let fd = NODE_RUNTIME._files?.get(file.dataUrl!);
                    if (fd === null || fd === undefined) {
                        // Depending on file flags, return nullptr
                        if (flags & FileFlags.FILE_FLAGS_NULL_IF_NOT_EXISTS) {
                            return 0;
                        }

                        fd = fs.openSync(
                            file.dataUrl!,
                            fs.constants.O_CREAT | fs.constants.O_RDWR,
                            fs.constants.S_IRUSR | fs.constants.S_IWUSR,
                        );
                    }
                    NODE_RUNTIME._filesById.set(file.fileId, fd);
                    const fileSize = fs.fstatSync(fd).size;
                    const result = mod._malloc(isWasm64 ? 3 * 8 : 2 * 8);
                    packFileInfo(mod, result, fileSize, 0, 0);
                    return result;
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    failWith(mod, 'Unsupported data protocol');
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },
    syncFile: (_mod: DuckDBModule, _fileId: number) => {},
    closeFile: (mod: DuckDBModule, fileId: number) => {
        try {
            fileId = Number(fileId);
            const fileInfo = NODE_RUNTIME._fileInfoCache.get(fileId);
            NODE_RUNTIME._fileInfoCache.delete(fileId);
            switch (fileInfo?.dataProtocol) {
                case DuckDBDataProtocol.NODE_FS: {
                    const fileHandle = NODE_RUNTIME._filesById.get(fileId);
                    NODE_RUNTIME._filesById.delete(fileId);
                    if (fileHandle !== null && fileHandle !== undefined) {
                        fs.closeSync(fileHandle);
                    }
                    break;
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    break;
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },
    dropFile: (mod: DuckDBModule, _fileNamePtr: number | bigint, _fileNameLen: number) => {},
    truncateFile: (mod: DuckDBModule, fileId: number, newSize: number) => {
        try {
            fileId = Number(fileId);
            newSize = Number(newSize);
            const file = NODE_RUNTIME.resolveFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.NODE_FS: {
                    fs.truncateSync(file.dataUrl!, newSize);
                    break;
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    failWith(mod, 'Unsupported data protocol');
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },
    readFile: (mod: DuckDBModule, fileId: number, buf: number | bigint, bytes: number, location: number) => {
        try {
            fileId = Number(fileId);
            bytes = Number(bytes);
            location = Number(location);
            const file = NODE_RUNTIME.resolveFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.NODE_FS: {
                    const fileHandle = NODE_RUNTIME._filesById.get(fileId);
                    if (fileHandle === null || fileHandle === undefined) {
                        failWith(mod, `File ${fileId} is missing a file descriptor`);
                        return 0;
                    }
                    const bufNum = Number(buf);
                    if (typeof buf === 'bigint' && !Number.isSafeInteger(bufNum)) {
                        failWith(mod, `File ${fileId} readFile buffer pointer too large`);
                        return 0;
                    }
                    return fs.readSync(fileHandle, mod.HEAPU8, bufNum, bytes, location);
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    failWith(mod, 'Unsupported data protocol');
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },
    writeFile: (mod: DuckDBModule, fileId: number, buf: number | bigint, bytes: number, location: number) => {
        try {
            fileId = Number(fileId);
            bytes = Number(bytes);
            location = Number(location);
            const file = NODE_RUNTIME.resolveFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.NODE_FS: {
                    const fileHandle = NODE_RUNTIME._filesById.get(fileId);
                    if (fileHandle === null || fileHandle === undefined) {
                        failWith(mod, `File ${fileId} is missing a file descriptor`);
                        return 0;
                    }
                    const src = mod.HEAPU8.subarray(Number(buf), Number(buf) + bytes);
                    return fs.writeSync(fileHandle, src, 0, src.length, location);
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    failWith(mod, 'Unsupported data protocol');
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },
    progressUpdate: (_final: number, _percentage: number, _iteration: number): void => {
        return;
    },
    getLastFileModificationTime: (mod: DuckDBModule, fileId: number) => {
        try {
            fileId = Number(fileId);
            const file = NODE_RUNTIME.resolveFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.NODE_FS: {
                    const fileHandle = NODE_RUNTIME._filesById.get(fileId);
                    if (fileHandle === null || fileHandle === undefined) {
                        failWith(mod, `File ${fileId} is missing a file descriptor`);
                        return 0;
                    }
                    return fs.fstatSync(fileHandle!).mtime.getTime() / 1000;
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                case DuckDBDataProtocol.BROWSER_FSACCESS:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    failWith(mod, 'Unsupported data protocol');
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
        return 0;
    },

    checkDirectory: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = decodeText(mod.HEAPU8.subarray(Number(pathPtr), Number(pathPtr) + pathLen));
            return fs.existsSync(path);
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return false;
        }
    },
    createDirectory: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = decodeText(mod.HEAPU8.subarray(Number(pathPtr), Number(pathPtr) + pathLen));
            return fs.mkdirSync(path);
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    removeDirectory: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = decodeText(mod.HEAPU8.subarray(Number(pathPtr), Number(pathPtr) + pathLen));
            return fs.rmdirSync(path);
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    listDirectoryEntries: (mod: DuckDBModule, _pathPtr: number | bigint, _pathLen: number) => {
        failWith(mod, 'Not Implemented');
        return false;
    },
    glob: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = readString(mod, pathPtr, pathLen);
            const entries = fg.sync([path], { dot: true });
            for (const entry of entries) {
                mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [entry]);
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    moveFile: (mod: DuckDBModule, fromPtr: number | bigint, fromLen: number, toPtr: number | bigint, toLen: number) => {
        const from = readString(mod, fromPtr, fromLen);
        const to = readString(mod, toPtr, toLen);
        fs.renameSync(from, to);
        const handle = NODE_RUNTIME._files?.get(from);
        if (handle !== undefined) {
            NODE_RUNTIME._files!.delete(from);
            NODE_RUNTIME._files!.set(to, handle);
        }
        for (const [key, value] of NODE_RUNTIME._fileInfoCache?.entries() || []) {
            if (value.dataUrl == from) {
                NODE_RUNTIME._fileInfoCache.delete(key);
                break;
            }
        }
        return true;
    },
    checkFile: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = readString(mod, pathPtr, pathLen);
            return fs.existsSync(path);
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return false;
        }
    },
    removeFile: (mod: DuckDBModule, pathPtr: number | bigint, pathLen: number) => {
        try {
            const path = readString(mod, pathPtr, pathLen);
            return fs.rmSync(path);
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    callScalarUDF: (
        mod: DuckDBModule,
        response: number | bigint,
        funcId: number,
        descPtr: number | bigint,
        descSize: number,
        ptrsPtr: number | bigint,
        ptrsSize: number,
    ): void => {
        udf.callScalarUDF(NODE_RUNTIME, mod, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
    },
};

export function assertNodeWasm64Support(): void {
    if (!checkWasm64Support()) {
        throw new Error(
            'This Node.js version does not support 64-bit WebAssembly. Node.js >= 20 is required. Use { memoryModel: "wasm32" } instead.',
        );
    }
}

export default NODE_RUNTIME;
