export class OMap<K, V> {
  key: (key: K) => string;
  private _vals: Map<string, V>;
  private _keys: Map<string, K>;

  constructor(key: (key: K) => string, values?: Iterable<readonly [K, V]>) {
    this.key = key;
    this._vals = new Map();
    this._keys = new Map();
    if (values) {
      for (const [k, v] of values) {
        this.set(k, v);
      }
    }
  }
  get size(): number {
    return this._vals.size;
  }
  set(key: K, value: V): this {
    const k = this.key(key);
    this._vals.set(k, value);
    this._keys.set(k, key);
    return this;
  }
  get(key: K): V | undefined {
    return this._vals.get(this.key(key));
  }
  delete(key: K): boolean {
    const k = this.key(key);
    this._keys.delete(k);
    return this._vals.delete(k);
  }
  has(key: K): boolean {
    return this._vals.has(this.key(key));
  }
  values(): IterableIterator<V> {
    return this._vals.values();
  }
  keys(): IterableIterator<K> {
    return this._keys.values();
  }
  forEach(callback: (value: V, key: K) => void) {
    return this._vals.forEach((v, k, map) => callback(v, this._keys.get(k)!));
  }
}
