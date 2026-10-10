/** How a user is shown when their profile has no name or picture yet. Pure helpers shared by the avatar and pages. */

export const displayName = (u: { name?: string | null; email?: string | null }): string =>
  u.name?.trim() || u.email?.split("@")[0] || "Account";

const firstLetter = (word: string) => Array.from(word)[0] ?? "";

/** "Ada Lovelace" -> "AL", "blair" -> "B", nothing at all -> "?". Falls back to the email's local part. */
export function initialsFor(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? firstLetter(words[0]) + firstLetter(words[1]) : firstLetter(words[0] ?? "");
  return letters ? letters.toLocaleUpperCase() : "?";
}
