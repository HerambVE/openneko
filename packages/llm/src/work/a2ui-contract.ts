import { z } from "zod";
import type { AgentSurfaceMessage } from "../agent-backend";
import { randomUUID } from "node:crypto";

export const A2UI_VERSION = "v1.0" as const;
export const A2UI_CATALOG_ID = "urn:openneko:catalog:work:v2" as const;
export const A2UI_RENDER_SERVER_NAME = "neko_ui" as const;
export const A2UI_RENDER_TOOL_NAME = "render_cards" as const;
/** Registered name for render_cards on the brokered neko MCP server. */
export const A2UI_RENDER_MCP_TOOL_NAME =
  "mcp__neko__ui_render_cards" as const;

/**
 * ACP reports tools from the multiplexed `neko` bridge as
 * `mcp_neko_<logical-server>_<tool>` in ACP notifications.
 */
export const A2UI_RENDER_ACP_TITLE =
  "mcp_neko_ui_render_cards" as const;

const a2uiComponentSchema = z
  .object({ id: z.string().min(1), component: z.string().min(1) })
  .passthrough();

function messageSchema(opts: { generated: boolean }) {
  const version = opts.generated
    ? z.literal(A2UI_VERSION)
    : z.enum(["v0.9", A2UI_VERSION]);
  const catalogId = opts.generated
    ? z.literal(A2UI_CATALOG_ID)
    : z.string().min(1);

  const createSurfaceSchema = z
    .object({
      version,
      createSurface: z
        .object({
          surfaceId: z.string().min(1),
          catalogId,
          surfaceProperties: z.record(z.string(), z.unknown()).optional(),
          sendDataModel: z.boolean().optional(),
          components: z.array(a2uiComponentSchema).min(1).optional(),
          dataModel: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    })
    .strict();
  const updateComponentsSchema = z
    .object({
      version,
      updateComponents: z
        .object({
          surfaceId: z.string().min(1),
          components: z.array(a2uiComponentSchema).min(1),
        })
        .strict(),
    })
    .strict();
  const updateDataModelSchema = z
    .object({
      version,
      updateDataModel: z
        .object({
          surfaceId: z.string().min(1),
          path: z.string().optional(),
          value: z.unknown().optional(),
        })
        .strict(),
    })
    .strict();
  const deleteSurfaceSchema = z
    .object({
      version,
      deleteSurface: z.object({ surfaceId: z.string().min(1) }).strict(),
    })
    .strict();

  return z.union([
    createSurfaceSchema,
    updateComponentsSchema,
    updateDataModelSchema,
    deleteSurfaceSchema,
  ]);
}

/** The sole schema for newly generated A2UI messages. */
export const generatedA2UIMessageSchema = messageSchema({ generated: true });

/** Reader compatibility for already-persisted v0.9 surfaces. */
const readableA2UIMessageSchema = messageSchema({ generated: false });

const text = (max: number) => z.string().trim().min(1).max(max);

const keyFiguresBlock = z.object({
  items: z.array(z.object({
    label: text(80),
    value: text(40).describe("The value exactly as the tool result gives it, formatted for reading."),
    sub: text(120).optional().describe("Short context, such as the period or a change."),
    asOf: text(40).optional(),
    source: text(80).optional(),
  })).min(1).max(8).describe("A flat list with one object per figure."),
});

const chartBlock = z.object({
  type: z.enum(["line", "bar", "area", "donut"]),
  title: text(120),
  valueLabel: text(60).describe("The measure and unit, such as Revenue (USD)."),
  points: z.array(z.object({
    label: text(40).describe("The x-axis or category label."),
    value: z.number(),
    baseline: z.number().optional().describe("An optional comparison value for the same label."),
  })).min(2).max(60),
  baselineLabel: text(60).optional(),
  source: text(80).optional(),
  asOf: text(40).optional(),
});

const tableBlock = z.object({
  columns: z.array(z.object({
    label: text(60),
    align: z.enum(["left", "right", "center"]).optional(),
  })).min(1).max(12),
  rows: z.array(z.array(z.string().max(200)).describe("One cell per column, in column order."))
    .min(1).max(200),
  caption: text(200).optional(),
});

const markdownBlock = z.object({ text: text(4_000) });

const calloutBlock = z.object({
  mood: z.enum(["good", "watch", "act"]),
  title: text(80).optional(),
  text: text(600),
});

const choicesBlock = z.object({
  options: z.array(z.object({
    label: text(40),
    prompt: text(300).describe("The follow-up request sent when the operator picks this option."),
  })).min(1).max(4),
});

const ANSWER_BLOCK_KINDS = ["keyFigures", "chart", "table", "markdown", "callout", "choices"] as const;
type AnswerBlockKind = (typeof ANSWER_BLOCK_KINDS)[number];

const answerBlock = z.object({
  keyFigures: keyFiguresBlock.optional(),
  chart: chartBlock.optional(),
  table: tableBlock.optional(),
  markdown: markdownBlock.optional(),
  callout: calloutBlock.optional(),
  choices: choicesBlock.optional(),
});

/** Every field is declared, so each model provider receives the full structure. */
export const renderCardsArgsSchema = z.object({
  title: text(120),
  subtitle: text(240).optional(),
  blocks: z.array(answerBlock).min(1).max(12),
});

export const RENDER_CARDS_INPUT_SHAPE = renderCardsArgsSchema.shape;

/** JSON Schema is generated from the validator instead of maintained by hand. */
export const RENDER_CARDS_INPUT_SCHEMA = z.toJSONSchema(
  renderCardsArgsSchema,
) as Record<string, unknown>;

export type RenderCardsArgs = z.infer<typeof renderCardsArgsSchema>;

export type RenderInputValidation =
  | { success: true; messages: AgentSurfaceMessage[] }
  | {
      success: false;
      issues: Array<{ path: string; code: string; message: string }>;
    };

function blockKind(block: RenderCardsArgs["blocks"][number]): AnswerBlockKind {
  return ANSWER_BLOCK_KINDS.find((kind) => block[kind] !== undefined)!;
}

function blockIssues(blocks: RenderCardsArgs["blocks"]) {
  const issues: Array<{ path: string; code: string; message: string }> = [];
  blocks.forEach((block, index) => {
    const path = `blocks.${index}`;
    const filled = ANSWER_BLOCK_KINDS.filter((kind) => block[kind] !== undefined);
    if (filled.length !== 1) {
      issues.push({
        path,
        code: "block_field_count",
        message: filled.length === 0
          ? `${path} fills no field; fill exactly one of ${ANSWER_BLOCK_KINDS.join(", ")}.`
          : `${path} fills ${filled.join(" and ")}; put each in its own block.`,
      });
      return;
    }
    if (block.table) {
      const columns = block.table.columns.length;
      const row = block.table.rows.findIndex((cells) => cells.length !== columns);
      if (row >= 0) {
        issues.push({
          path: `${path}.table.rows.${row}`,
          code: "table_row_width",
          message: `${path}.table.rows.${row} needs ${columns} cells, one per column.`,
        });
      }
    }
    if (block.chart?.type === "donut") {
      const points = block.chart.points;
      if (points.length > 8 || points.some((point) => point.value < 0) ||
        points.reduce((sum, point) => sum + point.value, 0) <= 0) {
        issues.push({
          path: `${path}.chart.points`,
          code: "donut_parts",
          message: `${path}.chart is a donut; give 2 to 8 parts with nonnegative values and a positive total.`,
        });
      }
    }
  });
  return issues;
}

function blockComponent(block: RenderCardsArgs["blocks"][number], id: string): Record<string, unknown> {
  switch (blockKind(block)) {
    case "keyFigures":
      return { id, component: "KeyFigures", items: block.keyFigures!.items };
    case "chart": {
      const { points, ...chart } = block.chart!;
      return {
        id,
        component: "Chart",
        ...chart,
        data: points.map((point) => ({
          d: point.label,
          v: point.value,
          ...(point.baseline !== undefined ? { t: point.baseline } : {}),
        })),
      };
    }
    case "table": {
      const { columns, rows, caption } = block.table!;
      const keys = columns.map((_, index) => `c${index}`);
      return {
        id,
        component: "Table",
        columns: columns.map((column, index) => ({ key: keys[index], ...column })),
        rows: rows.map((cells) => Object.fromEntries(keys.map((key, index) => [key, cells[index]]))),
        ...(caption ? { caption } : {}),
      };
    }
    case "markdown":
      return { id, component: "Markdown", text: block.markdown!.text };
    case "callout":
      return { id, component: "Callout", ...block.callout! };
    case "choices":
      return { id, component: "Choice", options: block.choices!.options };
  }
}

/** Build one A2UI v1.0 answer surface from validated render_cards arguments. */
export function buildAnswerSurface(args: RenderCardsArgs, surfaceId: string): AgentSurfaceMessage[] {
  const children = args.blocks.map((_, index) => `b${index}`);
  return [{
    version: A2UI_VERSION,
    createSurface: {
      surfaceId,
      catalogId: A2UI_CATALOG_ID,
      dataModel: {},
      components: [
        {
          id: "root",
          component: "Answer",
          title: args.title,
          ...(args.subtitle ? { subtitle: args.subtitle } : {}),
          children,
        },
        ...args.blocks.map((block, index) => blockComponent(block, children[index])),
      ],
    },
  } as AgentSurfaceMessage];
}

/** Validate the complete tool argument object and build its surface. */
export function validateRenderCardsInput(
  value: unknown,
  surfaceId = `answer-${randomUUID()}`,
): RenderInputValidation {
  const parsed = renderCardsArgsSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: `${issue.path.join(".") || "input"}: ${issue.message}`,
      })),
    };
  }
  const issues = blockIssues(parsed.data.blocks);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, messages: buildAnswerSurface(parsed.data, surfaceId) };
}

/** Validate parsed reader input while retaining v0.9 history compatibility. */
export function coerceReadableSurfaceMessages(
  value: unknown,
): AgentSurfaceMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = readableA2UIMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data as AgentSurfaceMessage] : [];
  });
}

/** Validate parsed model output. New render calls are v1.0 only. */
export function coerceGeneratedSurfaceMessages(
  value: unknown,
): AgentSurfaceMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = generatedA2UIMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data as AgentSurfaceMessage] : [];
  });
}
