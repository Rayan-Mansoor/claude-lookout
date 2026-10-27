/**
 * A tiny key-value store on IndexedDB, which the service worker can read too. Falls back to
 * memory when storage is unavailable (private windows, blocked site data).
 */
const DB = "claude-lookout";
const STORE = "kv";
const memory = new Map<string, unknown>();

let connection: Promise<IDBDatabase> | undefined;

/** One connection for the life of the page, opened again if the browser closes it. */
function openDb(): Promise<IDBDatabase> {
	connection ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => {
			const db = request.result;
			db.onclose = () => {
				connection = undefined;
			};
			db.onversionchange = () => {
				db.close();
				connection = undefined;
			};
			resolve(db);
		};
		request.onerror = () => reject(request.error);
	}).catch((err) => {
		connection = undefined;
		throw err;
	});
	return connection;
}

async function run<T>(
	mode: IDBTransactionMode,
	op: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const request = op(db.transaction(STORE, mode).objectStore(STORE));
		request.onsuccess = () => resolve(request.result as T);
		request.onerror = () => reject(request.error);
	});
}

export async function getItem<T>(key: string): Promise<T | undefined> {
	try {
		return (await run<T | undefined>("readonly", (s) => s.get(key))) ?? (memory.get(key) as T);
	} catch {
		return memory.get(key) as T | undefined;
	}
}

export async function setItem(key: string, value: unknown): Promise<void> {
	memory.set(key, value);
	try {
		await run("readwrite", (s) => s.put(value, key));
	} catch {}
}

export async function removeItem(key: string): Promise<void> {
	memory.delete(key);
	try {
		await run("readwrite", (s) => s.delete(key));
	} catch {}
}
