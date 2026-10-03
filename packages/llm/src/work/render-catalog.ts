export { RENDER_CARDS_INPUT_SCHEMA } from "./a2ui-contract";

/** Tool description. The prompt's rendering section says when to use each block. */
export const RENDER_CARDS_DESCRIPTION = [
  "Show the evidence for an answer as cards with figures, charts, tables and follow-up options.",
  "Give a title and an ordered list of blocks. Each block fills exactly one of these fields:",
  "keyFigures for headline numbers;",
  "chart for a trend, comparison or breakdown (line, bar, area or donut, with 2 to 60 labelled points);",
  "table for exact values (one cell per column in each row);",
  "markdown for a short explanation;",
  "callout for a status or takeaway (mood good, watch or act);",
  "choices for up to 4 follow-up requests.",
  "Copy each value exactly as the tool result gives it.",
].join(" ");
