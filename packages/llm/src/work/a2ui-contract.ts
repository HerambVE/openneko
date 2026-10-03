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

/**
 * Every argument is a string, a list of strings, or an enum. Some agent
 * runtimes call deferred tools through a bridge whose arguments parameter is
 * an open object; small models fill flat text fields reliably there and nested
 * objects poorly. The host reads the text with plain string splitting.
 */
export const renderCardsArgsSchema = z.object({
  title: text(120),
  table: text(20_000).optional()
    .describe("A pipe table: a header row, then one row per line, cells separated by |."),
  chart: z.enum(["line", "bar", "area", "donut"]).optional()
    .describe("Chart the table: the first column gives the labels, chartColumn the values."),
  chartColumn: text(60).optional()
    .describe("The table column to chart. Write its cells as plain numbers, such as 12699845.92."),
  keyFigures: z.array(text(160)).min(1).max(6).optional()
    .describe('Headline numbers, each written as "Label: value" with an optional "(note)".'),
  callout: text(600).optional().describe("A status, risk, or recommended action."),
  mood: z.enum(["good", "watch", "act"]).optional().describe("The callout's tone."),
  followUps: z.array(text(200)).min(1).max(4).optional()
    .describe("Follow-up questions the operator can ask next."),
});

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

type Issue = { path: string; code: string; message: string };
type Table = { columns: string[]; rows: string[][] };
type Built<T> = { value: T } | { issue: Issue };

const SECTIONS = ["table", "keyFigures", "callout", "followUps"] as const;
const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A plain number with optional thousands separators, such as 1,250 or -3.5. */
function plainNumber(cell: string): number | undefined {
  const compact = cell.trim().replaceAll(",", "");
  if (compact === "") return undefined;
  const value = Number(compact);
  return Number.isFinite(value) ? value : undefined;
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function isDivider(line: string): boolean {
  return [...line].every((char) => "|-: ".includes(char));
}

/** Split text into lines. Some models write the two characters \ and n for a line break. */
function lines(source: string): string[] {
  return source.replaceAll("\\n", "\n").split("\n");
}

function readTable(source: string): Built<Table> {
  const rowsText = lines(source).filter((line) => line.trim() !== "" && !isDivider(line));
  if (rowsText.length < 2) {
    return { issue: { path: "table", code: "table_shape", message: "table needs a header row and at least one data row." } };
  }
  const columns = cells(rowsText[0]!);
  const rows = rowsText.slice(1).map(cells);
  const short = rows.findIndex((row) => row.length !== columns.length);
  if (short >= 0) {
    return { issue: { path: "table", code: "table_row_width", message: `table row ${short + 1} needs ${columns.length} cells, one per column.` } };
  }
  return { value: { columns, rows } };
}

function numericColumn(table: Table, index: number): boolean {
  return index > 0 && table.rows.every((row) => plainNumber(row[index]!) !== undefined);
}

function chartFromTable(args: RenderCardsArgs, table: Table): Built<Record<string, unknown>> {
  const requested = args.chartColumn
    ? table.columns.findIndex((name) => name.toLowerCase() === args.chartColumn!.trim().toLowerCase())
    : -1;
  if (args.chartColumn && requested < 1) {
    return { issue: { path: "chartColumn", code: "chart_column", message: `chartColumn must be one of the table's value columns: ${table.columns.slice(1).join(", ")}.` } };
  }
  const column = requested >= 1 ? requested : table.columns.findIndex((_, index) => numericColumn(table, index));
  if (column < 1) {
    return { issue: { path: "chartColumn", code: "chart_column", message: "chart needs a table column of plain numbers, such as 12699845.92; name it in chartColumn." } };
  }
  const bad = table.rows.findIndex((row) => plainNumber(row[column]!) === undefined);
  if (bad >= 0) {
    return { issue: { path: "table", code: "chart_value", message: `table row ${bad + 1} needs a plain number in the ${table.columns[column]} column, such as 12699845.92.` } };
  }
  const data = table.rows.map((row) => ({ d: row[0]!, v: plainNumber(row[column]!)! }));
  if (data.length < 2 || data.length > 60) {
    return { issue: { path: "chart", code: "chart_points", message: "chart needs 2 to 60 table rows." } };
  }
  if (args.chart === "donut" && (data.length > 8 || data.some((point) => point.v < 0))) {
    return { issue: { path: "chart", code: "donut_parts", message: "a donut needs 2 to 8 rows with nonnegative values." } };
  }
  return {
    value: { id: "chart", component: "Chart", type: args.chart, title: args.title, valueLabel: table.columns[column], data },
  };
}

function tableComponent(table: Table): Record<string, unknown> {
  const numeric = table.columns.map((_, index) => numericColumn(table, index));
  return {
    id: "table",
    component: "Table",
    columns: table.columns.map((label, index) => ({ key: `c${index}`, label, ...(numeric[index] ? { align: "right" } : {}) })),
    rows: table.rows.map((row) => Object.fromEntries(row.map((cell, index) => [
      `c${index}`,
      numeric[index] ? NUMBER_FORMAT.format(plainNumber(cell)!) : cell,
    ]))),
  };
}

function keyFigure(line: string, index: number): Built<Record<string, string>> {
  const colon = line.indexOf(":");
  let value = colon > 0 ? line.slice(colon + 1).trim() : "";
  let sub: string | undefined;
  const open = value.lastIndexOf("(");
  if (open > 0 && value.endsWith(")")) {
    sub = value.slice(open + 1, -1).trim();
    value = value.slice(0, open).trim();
  }
  if (!value) {
    return { issue: { path: `keyFigures.${index}`, code: "key_figure", message: `keyFigures.${index} needs the form "Label: value".` } };
  }
  return { value: { label: line.slice(0, colon).trim(), value, ...(sub ? { sub } : {}) } };
}

function answerComponents(args: RenderCardsArgs): { components: Array<Record<string, unknown>>; issues: Issue[] } {
  const components: Array<Record<string, unknown>> = [];
  const issues: Issue[] = [];
  if (SECTIONS.every((section) => args[section] === undefined)) {
    issues.push({ path: "", code: "empty_answer", message: `Fill at least one of ${SECTIONS.join(", ")}.` });
  }
  if (args.keyFigures) {
    const figures = args.keyFigures.map(keyFigure);
    for (const figure of figures) if ("issue" in figure) issues.push(figure.issue);
    components.push({ id: "keyFigures", component: "KeyFigures", items: figures.flatMap((figure) => "value" in figure ? [figure.value] : []) });
  }
  const table = args.table ? readTable(args.table) : undefined;
  if (table && "issue" in table) issues.push(table.issue);
  if (args.chart && !table) {
    issues.push({ path: "chart", code: "chart_table", message: "chart draws from table; add a table." });
  }
  if (args.chart && table && "value" in table) {
    const chart = chartFromTable(args, table.value);
    if ("issue" in chart) issues.push(chart.issue);
    else components.push(chart.value);
  }
  if (table && "value" in table) components.push(tableComponent(table.value));
  if (args.callout) components.push({ id: "callout", component: "Callout", mood: args.mood ?? "watch", text: args.callout });
  if (args.followUps) {
    components.push({ id: "followUps", component: "Choice", options: args.followUps.map((prompt) => ({ label: prompt, prompt })) });
  }
  return { components, issues };
}

function answerSurface(title: string, sections: Array<Record<string, unknown>>, surfaceId: string): AgentSurfaceMessage[] {
  return [{
    version: A2UI_VERSION,
    createSurface: {
      surfaceId,
      catalogId: A2UI_CATALOG_ID,
      dataModel: {},
      components: [
        { id: "root", component: "Answer", title, children: sections.map((section) => section.id) },
        ...sections,
      ],
    },
  } as AgentSurfaceMessage];
}

const ANSWER_FIELDS = new Set(["title", "table", "chart", "chartColumn", "keyFigures", "callout", "mood", "followUps"]);
const LIST_FIELDS = new Set(["keyFigures", "followUps"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Some agent runtimes call deferred tools through a bridge whose arguments
 * parameter is an open object. Models then nest the call again, send it as
 * JSON text, write a list as lines, or fill unused fields with null, false or
 * "". Recover the answer object; validation still decides what is accepted.
 */
export function normalizeRenderCardsInput(value: unknown): unknown {
  let answer = parseJsonObject(value);
  for (let depth = 0; depth < 3 && isRecord(answer) && !("title" in answer); depth += 1) {
    const nested = parseJsonObject("arguments" in answer
      ? answer.arguments
      : Object.keys(answer).length === 1 ? Object.values(answer)[0] : undefined);
    if (!isRecord(nested)) break;
    answer = nested;
  }
  if (!isRecord(answer)) return answer;
  const normalized: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(answer)) {
    if (!ANSWER_FIELDS.has(field) || raw === null || raw === false || raw === "" ||
      (Array.isArray(raw) && raw.length === 0)) continue;
    normalized[field] = LIST_FIELDS.has(field) && typeof raw === "string"
      ? lines(raw).map((line) => line.trim()).filter(Boolean)
      : raw;
  }
  return normalized;
}

/** Validate the complete tool argument object and build its surface. */
export function validateRenderCardsInput(
  value: unknown,
  surfaceId = `answer-${randomUUID()}`,
): RenderInputValidation {
  const parsed = renderCardsArgsSchema.safeParse(normalizeRenderCardsInput(value));
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
  const { components, issues } = answerComponents(parsed.data);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, messages: answerSurface(parsed.data.title, components, surfaceId) };
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
