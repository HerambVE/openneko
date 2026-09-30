export { RENDER_CARDS_INPUT_SCHEMA } from "./a2ui-contract";

/** Short search text for tool discovery. Full usage lives in the messages schema. */
export const RENDER_CARDS_DESCRIPTION = [
  "Render cards and interactive UI for web Work answers with A2UI v1.0.",
  "Use for figures, comparisons, tables, findings, decisions, forms, and recovery steps.",
  "Call with {messages:[...]}. The messages parameter schema has the component",
  "catalog, payload example, and validation guidance; use tool_describe to read it.",
].join(" ");
