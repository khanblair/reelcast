/**
 * Wire format. Handlers return plain DB rows / DTOs; the RPC route converts them so the
 * browser sees the same document shape the app was written against under Convex:
 *   - `id`        -> `_id`
 *   - `createdAt` -> also `_creationTime` (epoch ms)
 *   - Date        -> epoch ms number
 *   - null        -> key omitted (Convex "optional field" semantics)
 *
 * The type-level `Wire<T>` mirrors the runtime transform so UI code stays type-safe.
 * This module is imported by client code for types only; keep it free of server imports.
 */

type Rename<K> = K extends "id" ? "_id" : K;
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

export type WireValue<T> = T extends Date
  ? number
  : T extends readonly (infer U)[]
    ? WireValue<U>[]
    : T extends object
      ? WireObject<T>
      : T;

export type WireObject<T> = {
  [K in Exclude<keyof T, NullableKeys<T>> as Rename<K>]: WireValue<T[K]>;
} & {
  [K in NullableKeys<T> as Rename<K>]?: WireValue<Exclude<T[K], null>>;
} & (T extends { createdAt: Date } ? { _creationTime: number } : unknown);

export type Wire<T> = WireValue<T>;

/** Runtime transform matching `Wire<T>`. */
export function toWire(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map((v) => toWire(v));
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined) continue;
      out[k === "id" ? "_id" : k] = toWire(v);
    }
    if (src.createdAt instanceof Date) out._creationTime = src.createdAt.getTime();
    return out;
  }
  return value;
}
