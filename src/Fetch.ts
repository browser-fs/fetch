import { FileSystemMetadata, ReadonlyAsyncFileSystem } from '@browserfs/core/filesystem.js';
import { ApiError, ErrorCode } from '@browserfs/core/ApiError.js';
import { FileFlag, NoSyncFile } from '@browserfs/core/file.js';
import { Stats } from '@browserfs/core/stats.js';
import { FileIndex, isIndexFileInode, isIndexDirInode, type ListingTree } from './FileIndex.js';
import { Cred } from '@browserfs/core/cred.js';
import type { Backend } from '@browserfs/core/backends/backend.js';
import { R_OK } from '@browserfs/core/emulation/constants.js';

/**
 * @hidden
 */
function convertError(e: Error): never {
	throw new ApiError(ErrorCode.EIO, e.message);
}

/**
 * Asynchronously download a file as a buffer or a JSON object.
 * Note that the third function signature with a non-specialized type is
 * invalid, but TypeScript requires it when you specialize string arguments to
 * constants.
 * @hidden
 */
async function fetchFile(p: string, type: 'buffer'): Promise<Uint8Array>;
async function fetchFile<T extends object>(p: string, type: 'json'): Promise<T>;
async function fetchFile<T extends object>(p: string, type: 'buffer' | 'json'): Promise<T | Uint8Array>;
async function fetchFile<T extends object>(p: string, type: 'buffer' | 'json'): Promise<T | Uint8Array> {
	const response = await fetch(p).catch(convertError);
	if (!response.ok) {
		throw new ApiError(ErrorCode.EIO, `fetch error: response returned code ${response.status}`);
	}
	switch (type) {
		case 'buffer':
			const arrayBuffer = await response.arrayBuffer().catch(convertError);
			return new Uint8Array(arrayBuffer);
		case 'json':
			return response.json().catch(convertError);
		default:
			throw new ApiError(ErrorCode.EINVAL, 'Invalid download type: ' + type);
	}
}

/**
 * Asynchronously retrieves the size of the given file in bytes.
 * @hidden
 */
async function fetchSize(p: string): Promise<number> {
	const response = await fetch(p, { method: 'HEAD' }).catch(convertError);
	if (!response.ok) {
		throw new ApiError(ErrorCode.EIO, 'fetch HEAD error: response returned code ' + response.status);
	}
	return parseInt(response.headers.get('Content-Length') || '-1', 10);
}

/**
 * Configuration options for a HTTPRequest file system.
 */
export interface FetchOptions {
	/**
	 * URL to a file index as a JSON file or the file index object itself.
	 * Defaults to `index.json`.
	 */
	index?: string | ListingTree;

	/** Used as the URL prefix for fetched files.
	 * Default: Fetch files relative to the index.
	 */
	baseUrl?: string;
}

/**
 * A simple filesystem backed by HTTP downloads.
 *
 *
 * Listings objects look like the following:
 *
 * ```json
 * {
 *   "home": {
 *     "jvilk": {
 *       "someFile.txt": null,
 *       "someDir": {
 *         // Empty directory
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * This example has the folder `/home/jvilk` with subfile `someFile.txt` and subfolder `someDir`.
 */
export class FetchFS extends ReadonlyAsyncFileSystem {
	public readonly prefixUrl: string;
	private _index: FileIndex<Stats>;

	protected _ready: Promise<void>;

	public async ready(): Promise<this> {
		await this._ready;
		return this;
	}

	public async loadIndex(index: string | ListingTree): Promise<void> {
		if (typeof index == 'string') {
			index = await fetchFile<ListingTree>(index, 'json');
		}

		this._index = FileIndex.FromListing<Stats>(index);
	}

	constructor({ index, baseUrl = '' }: FetchOptions) {
		super();
		if (!index) {
			index = 'index.json';
		}

		this._ready = this.loadIndex(index);

		// prefix_url must end in a directory separator.
		if (baseUrl.length > 0 && baseUrl.charAt(baseUrl.length - 1) !== '/') {
			baseUrl = baseUrl + '/';
		}
		this.prefixUrl = baseUrl;
	}

	public get metadata(): FileSystemMetadata {
		return {
			...super.metadata,
			name: FetchFS.Name,
			readonly: true,
		};
	}

	public empty(): void {
		for (const file of this._index.files()) {
			file.data.fileData = null;
		}
	}

	/**
	 * Special function: Preload the given file into the index.
	 * @param path
	 * @param buffer
	 */
	public preloadFile(path: string, buffer: Uint8Array): void {
		const inode = this._index.getInode(path);
		if (!isIndexFileInode<Stats>(inode)) {
			throw ApiError.EISDIR(path);
		}

		if (!inode) {
			throw ApiError.ENOENT(path);
		}
		const stats = inode.data;
		stats.size = buffer.length;
		stats.fileData = buffer;
	}

	public async stat(path: string, cred: Cred): Promise<Stats> {
		const inode = this._index.getInode(path);
		if (!inode) {
			throw ApiError.ENOENT(path);
		}
		if (!inode.toStats().hasAccess(R_OK, cred)) {
			throw ApiError.EACCES(path);
		}

		if (isIndexDirInode<Stats>(inode)) {
			return inode.stats;
		}

		if (isIndexFileInode<Stats>(inode)) {
			const stats = inode.data;
			// At this point, a non-opened file will still have default stats from the listing.
			if (stats.size < 0) {
				stats.size = await this._fetchSize(path);
			}

			return stats;
		}

		throw ApiError.OnPath(ErrorCode.EINVAL, path);
	}

	public async openFile(path: string, flag: FileFlag, cred: Cred): Promise<NoSyncFile<this>> {
		if (flag.isWriteable()) {
			// You can't write to files on this file system.
			throw new ApiError(ErrorCode.EPERM, path);
		}

		// Check if the path exists, and is a file.
		const inode = this._index.getInode(path);

		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (!inode.toStats().hasAccess(flag.mode, cred)) {
			throw ApiError.EACCES(path);
		}

		if (isIndexDirInode<Stats>(inode)) {
			const stats = inode.stats;
			return new NoSyncFile(this, path, flag, stats, stats.fileData);
		}

		const stats = inode.data;
		// Use existing file contents. This maintains the previously-used flag.
		if (stats.fileData) {
			return new NoSyncFile(this, path, flag, Stats.clone(stats), stats.fileData);
		}
		// @todo be lazier about actually requesting the file
		const data = await this._fetchFile(path, 'buffer');
		// we don't initially have file sizes
		stats.size = data.length;
		stats.fileData = data;
		return new NoSyncFile(this, path, flag, Stats.clone(stats), data);
	}

	public async readdir(path: string, cred: Cred): Promise<string[]> {
		return this.readdirSync(path, cred);
	}

	/**
	 * We have the entire file as a buffer; optimize readFile.
	 */
	public async readFile(fname: string, flag: FileFlag, cred: Cred): Promise<Uint8Array> {
		// Get file.
		const fd: NoSyncFile<FetchFS> = await this.openFile(fname, flag, cred);
		try {
			return fd.buffer;
		} finally {
			await fd.close();
		}
	}

	private _getRemotePath(filePath: string): string {
		if (filePath.charAt(0) === '/') {
			filePath = filePath.slice(1);
		}
		return this.prefixUrl + filePath;
	}

	/**
	 * Asynchronously download the given file.
	 */
	protected _fetchFile(p: string, type: 'buffer'): Promise<Uint8Array>;
	protected _fetchFile(p: string, type: 'json'): Promise<object>;
	protected _fetchFile(p: string, type: 'buffer' | 'json'): Promise<object>;
	protected _fetchFile(p: string, type: 'buffer' | 'json'): Promise<object> {
		return fetchFile(this._getRemotePath(p), type);
	}

	/**
	 * Only requests the HEAD content, for the file size.
	 */
	protected _fetchSize(path: string): Promise<number> {
		return fetchSize(this._getRemotePath(path));
	}
}

export const Fetch: Backend = {
	name: 'Fetch',

	options: {
		index: {
			type: ['string', 'object'],
			description: 'URL to a file index as a JSON file or the file index object itself, generated with the make_http_index script. Defaults to `index.json`.',
		},
		baseUrl: {
			type: 'string',
			description: 'Used as the URL prefix for fetched files. Default: Fetch files relative to the index.',
		},
	},

	isAvailable(): boolean {
		return typeof globalThis.fetch == 'function';
	},

	create(options: FetchOptions) {
		return new FetchFS(options);
	},
};
