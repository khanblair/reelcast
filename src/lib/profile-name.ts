/**
 * The rules for a display name, shared by the edit form (instant feedback) and the server (the real check), so the two
 * can never disagree. Pure: no server or browser imports.
 */
export const NAME_MAX_LENGTH = 60;

/** Unicode-normalise and collapse whitespace. */
export const normalizeName = (raw: string) => raw.normalize("NFC").replace(/\s+/g, " ").trim();

/** An error message for a name that cannot be used, or null when it is fine. Expects an already-normalised name. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return "Enter your name";
  if ([...name].length > NAME_MAX_LENGTH) return `Use ${NAME_MAX_LENGTH} characters or fewer`;
  if (/[\p{C}<>]/u.test(name)) return "Names cannot contain control characters, < or >";
  return null;
}
