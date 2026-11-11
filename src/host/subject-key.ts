/** Normalize a subject for conversation grouping (prefixes, whitespace, case). */
export function subjectKey(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
