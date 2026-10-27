/** Key-value storage a hub keeps its spaces in: Durable Object storage, a file, or memory. */
export interface HubStore {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	/** Every entry whose key starts with `prefix`. */
	list<T>(prefix: string): Promise<Map<string, T>>;
}

export class MemoryStore implements HubStore {
	protected readonly data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.data.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}

	async list<T>(prefix: string): Promise<Map<string, T>> {
		const out = new Map<string, T>();
		for (const [key, value] of this.data) if (key.startsWith(prefix)) out.set(key, value as T);
		return out;
	}
}
