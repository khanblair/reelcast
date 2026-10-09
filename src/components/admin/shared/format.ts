/** Human-readable byte size. `zero` is what to show for 0 bytes (a dash in tables where it means "unknown"). */
export function formatBytes(bytes: number | null | undefined, zero = "0 B"): string {
  if (!bytes) return zero;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
