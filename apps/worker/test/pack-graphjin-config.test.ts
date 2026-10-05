import { describe, expect, it } from "vitest";
import { durablePackTables, unsupportedGraphjinConfigApi } from "../src/packs/graphjin-config";

describe("pack GraphJin config persistence", () => {
  it("keeps the live source-resolution hint out of durable YAML", () => {
    expect(durablePackTables([
      {
        name: "sales_order",
        source: "magento_analytics",
        database: "magento_analytics",
        read_only: true,
      },
      {
        name: "legacy_table",
        database: "legacy_database",
      },
    ])).toEqual([
      {
        name: "sales_order",
        source: "magento_analytics",
        read_only: true,
      },
      {
        name: "legacy_table",
        database: "legacy_database",
      },
    ]);
  });
});

describe("GraphJin without config preview", () => {
  it("explains a GraphJin that is too old for pack configuration", () => {
    const message = unsupportedGraphjinConfigApi(["field 'valid' is not a column or a function"]);
    expect(message).toContain("GraphJin on this OpenNeko install is too old to apply pack configuration");
    expect(message).toContain("needs GraphJin 3.18.35 or later");
    expect(message).toContain("field 'valid' is not a column or a function");
  });

  it("leaves other GraphJin errors alone", () => {
    expect(unsupportedGraphjinConfigApi(["stale catalog revision", null, undefined])).toBeNull();
    expect(unsupportedGraphjinConfigApi(["field 'customer_name' is not a column or a function"])).toBeNull();
  });
});

