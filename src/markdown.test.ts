import { describe, expect, it } from "vitest";

import { stripMarkdown } from "./markdown";

/**
 * Real samples from Llama 3.3 phase output. The model is told to emit plain text
 * and mostly does, but "**Candidate causes:**" showed up in a live run and
 * rendered as literal asterisks in the monospace pane.
 */
describe("stripMarkdown", () => {
  it("removes bold markers seen in real phase output", () => {
    expect(stripMarkdown("**Candidate causes:**")).toBe("Candidate causes:");
    expect(
      stripMarkdown(
        "1. **Route-exchange daemon bug**: Mechanism: Daemon malfunction causes reconnect loop."
      )
    ).toBe(
      "1. Route-exchange daemon bug: Mechanism: Daemon malfunction causes reconnect loop."
    );
  });

  it("removes heading hashes but keeps the heading text", () => {
    expect(stripMarkdown("## Summary\nRouting peers are looping.")).toBe(
      "Summary\nRouting peers are looping."
    );
  });

  it("unwraps inline code so metric names stay readable", () => {
    expect(stripMarkdown("Evidence: `suppression_profile_applied: 0`")).toBe(
      "Evidence: suppression_profile_applied: 0"
    );
  });

  it("normalises bullet characters to dashes", () => {
    expect(stripMarkdown("* first\n* second")).toBe("- first\n- second");
    expect(stripMarkdown("• first")).toBe("- first");
  });

  it("strips orphaned markers rather than leaving them visible", () => {
    expect(stripMarkdown("**unclosed bold")).toBe("unclosed bold");
  });

  it("leaves plain text untouched", () => {
    const plain =
      "Tunnel sessions in region alpha are affected. Confidence: high.";
    expect(stripMarkdown(plain)).toBe(plain);
  });

  it("does not mangle multiplication or emphasis-free asterisk use", () => {
    // A single asterisk with no pair should survive as-is.
    expect(stripMarkdown("rate is 3 * 4 per second")).toBe(
      "rate is 3 * 4 per second"
    );
  });
});
