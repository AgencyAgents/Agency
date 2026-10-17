import { expect, test } from "bun:test";
import * as api from "../src/index.ts";

const day = new Date("2026-03-04T10:00:00Z");

test("formatDate is the name", () => {
  expect(api.formatDate(day)).toBe("2026-03-04");
  expect("fmtDate" in api).toBe(false);
});
test("the users still work", () => {
  expect(api.reportLine("ok", day)).toBe("2026-03-04 ok");
  expect(api.invoiceHeader({ id: "7", issued: day, due: day })).toBe(
    "Invoice 7, issued 2026-03-04, due 2026-03-04",
  );
});
