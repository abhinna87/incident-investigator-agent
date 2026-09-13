/**
 * Strip markdown emphasis from model output.
 *
 * Phase output is shown in monospace panes and in a terminal, so a stray `**`
 * renders as two literal asterisks. The prompts forbid markdown, but instruction
 * following is not a guarantee — stripping on display means output already stored
 * in an agent's SQLite reads correctly too, without re-running the investigation.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // **bold** and __bold__
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      // Leading heading hashes.
      .replace(/^#{1,6}\s+/gm, "")
      // `code` — keep the contents, drop the ticks.
      .replace(/`([^`]+)`/g, "$1")
      // Bullet characters at the start of a line become a plain dash.
      .replace(/^\s*[*•]\s+/gm, "- ")
      // Any stray remaining emphasis markers.
      .replace(/\*\*/g, "")
      .trim()
  );
}
