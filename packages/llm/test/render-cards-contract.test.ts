import { describe, expect, it } from "vitest";
import {
  RENDER_CARDS_INPUT_SCHEMA,
  validateRenderCardsInput,
} from "../src/work/a2ui-contract";
import { RENDER_CARDS_DESCRIPTION } from "../src/work/render-catalog";
import { portableSchemaIssues } from "../src/tool-schema-portability";

const quarters = {
  title: "Revenue over the last four quarters",
  blocks: [
    {
      keyFigures: { items: [{ label: "2026 Q3", value: "$88.42M", sub: "up from $13.85M" }] },
    },
    {
      chart: {
        type: "line",
        title: "Revenue by quarter",
        valueLabel: "Revenue (USD)",
        points: [
          { label: "2025 Q4", value: 12_699_845.92 },
          { label: "2026 Q1", value: 11_565_433.28, baseline: 12_000_000 },
        ],
      },
    },
    {
      table: {
        columns: [{ label: "Quarter" }, { label: "Revenue", align: "right" }],
        rows: [["2025 Q4", "$12,699,845.92"], ["2026 Q1", "$11,565,433.28"]],
      },
    },
  ],
};

function components(input: unknown) {
  const result = validateRenderCardsInput(input, "answer-test");
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  const [message] = result.messages as Array<{ version: string; createSurface: Record<string, unknown> }>;
  expect(message.version).toBe("v1.0");
  expect(message.createSurface).toMatchObject({
    surfaceId: "answer-test",
    catalogId: "urn:openneko:catalog:work:v2",
  });
  return message.createSurface.components as Array<Record<string, unknown>>;
}

describe("render_cards contract", () => {
  it("builds an Answer surface whose root lists every block in order", () => {
    const [root, figures, chart, table] = components(quarters);
    expect(root).toEqual({
      id: "root",
      component: "Answer",
      title: "Revenue over the last four quarters",
      children: ["b0", "b1", "b2"],
    });
    expect(figures).toMatchObject({ id: "b0", component: "KeyFigures" });
    expect(chart).toEqual({
      id: "b1",
      component: "Chart",
      type: "line",
      title: "Revenue by quarter",
      valueLabel: "Revenue (USD)",
      data: [
        { d: "2025 Q4", v: 12_699_845.92 },
        { d: "2026 Q1", v: 11_565_433.28, t: 12_000_000 },
      ],
    });
    expect(table).toEqual({
      id: "b2",
      component: "Table",
      columns: [
        { key: "c0", label: "Quarter" },
        { key: "c1", label: "Revenue", align: "right" },
      ],
      rows: [
        { c0: "2025 Q4", c1: "$12,699,845.92" },
        { c0: "2026 Q1", c1: "$11,565,433.28" },
      ],
    });
  });

  it("maps markdown, callout and choices blocks to their components", () => {
    const [, markdown, callout, choices] = components({
      title: "Supplier risk",
      blocks: [
        { markdown: { text: "Two suppliers are late." } },
        { callout: { mood: "watch", title: "Q3 spike", text: "Q3 may include duplicated orders." } },
        { choices: { options: [{ label: "By supplier", prompt: "Break this down by supplier" }] } },
      ],
    });
    expect(markdown).toEqual({ id: "b0", component: "Markdown", text: "Two suppliers are late." });
    expect(callout).toEqual({ id: "b1", component: "Callout", mood: "watch", title: "Q3 spike", text: "Q3 may include duplicated orders." });
    expect(choices).toEqual({ id: "b2", component: "Choice", options: [{ label: "By supplier", prompt: "Break this down by supplier" }] });
  });

  it("names the fix when a block fills no field or more than one", () => {
    expect(validateRenderCardsInput({ title: "Orders", blocks: [{}] })).toMatchObject({
      success: false,
      issues: [{ path: "blocks.0", message: "blocks.0 fills no field; fill exactly one of keyFigures, chart, table, markdown, callout, choices." }],
    });
    expect(validateRenderCardsInput({
      title: "Orders",
      blocks: [{ markdown: { text: "A" }, callout: { mood: "good", text: "B" } }],
    })).toMatchObject({
      success: false,
      issues: [{ message: "blocks.0 fills markdown and callout; put each in its own block." }],
    });
  });

  it("requires one table cell per column", () => {
    const result = validateRenderCardsInput({
      title: "Orders",
      blocks: [{ table: { columns: [{ label: "A" }, { label: "B" }], rows: [["1", "2"], ["3"]] } }],
    });
    expect(result).toMatchObject({
      success: false,
      issues: [{ message: "blocks.0.table.rows.1 needs 2 cells, one per column." }],
    });
  });

  it("requires a donut to be 2 to 8 nonnegative parts of a positive whole", () => {
    const donut = (values: number[]) => validateRenderCardsInput({
      title: "Mix",
      blocks: [{
        chart: { type: "donut", title: "Mix", valueLabel: "Share", points: values.map((value, index) => ({ label: `p${index}`, value })) },
      }],
    });
    expect(donut([3, 4]).success).toBe(true);
    expect(donut([3, -1]).success).toBe(false);
    expect(donut([0, 0]).success).toBe(false);
    expect(donut([1, 1, 1, 1, 1, 1, 1, 1, 1]).success).toBe(false);
  });

  it("rejects a chart with fewer than two points or a non-numeric value", () => {
    const chart = (points: unknown[]) => validateRenderCardsInput({
      title: "Orders",
      blocks: [{ chart: { type: "line", title: "Orders", valueLabel: "Orders", points } }],
    });
    expect(chart([{ label: "Sep 7", value: 42 }]).success).toBe(false);
    expect(chart([{ label: "Sep 7", value: "42" }, { label: "Sep 14", value: 47 }]).success).toBe(false);
  });

  it("rejects the production payload shapes that the previous envelope invited", () => {
    const stringified = validateRenderCardsInput({
      messages: [{ version: "v1.0", createSurface: "{\"catalogId\": \"urn:openneko:catalog:work:v2\"}" }],
    });
    expect(stringified.success).toBe(false);
    const placeholders = validateRenderCardsInput({
      title: "Revenue",
      blocks: [{ table: true }],
    });
    expect(placeholders.success).toBe(false);
  });

  it("advertises a schema every provider can read in full", () => {
    expect(portableSchemaIssues(RENDER_CARDS_INPUT_SCHEMA)).toEqual([]);
  });

  it("keeps the tool description short and free of protocol vocabulary", () => {
    expect(RENDER_CARDS_DESCRIPTION.length).toBeLessThan(800);
    expect(RENDER_CARDS_DESCRIPTION).not.toMatch(/A2UI|createSurface|surfaceId|catalog/i);
  });
});
