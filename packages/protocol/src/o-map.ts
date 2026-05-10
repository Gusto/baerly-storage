export class OMap<K, V> {
  key: (key: K) => string;
  readonly #vals: Map<string, V>;
  readonly #keys: Map<string, K>;

  constructor(key: (key: K) => string, values?: Iterable<readonly [K, V]>) {
    this.key = key;
    this.#vals = new Map();
    this.#keys = new Map();
    if (values) {
      for (const [k, v] of values) {
        this.set(k, v);
      }
    }
  }
  get size(): number {
    return this.#vals.size;
  }
  set(key: K, value: V): this {
    const k = this.key(key);
    this.#vals.set(k, value);
    this.#keys.set(k, key);
    return this;
  }
  get(key: K): V | undefined {
    return this.#vals.get(this.key(key));
  }
  delete(key: K): boolean {
    const k = this.key(key);
    this.#keys.delete(k);
    return this.#vals.delete(k);
  }
  has(key: K): boolean {
    return this.#vals.has(this.key(key));
  }
  values(): IterableIterator<V> {
    return this.#vals.values();
  }
  keys(): IterableIterator<K> {
    return this.#keys.values();
  }
  forEach(callback: (value: V, key: K) => void) {
    return this.#vals.forEach((v, k) => callback(v, this.#keys.get(k)!));
  }
}
