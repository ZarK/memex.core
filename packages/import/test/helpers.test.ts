import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  contentHash,
  decodeText,
  detectDateFormat,
  detectDecimal,
  findHeaderRow,
  parseAmount,
  parseCsv,
  parseDate,
  repairDoubleEncoding,
  tableRecords,
  toIsoUtc,
  toMinorUnits,
} from "../src/index.js";

describe("hashes", () => {
  it("spells one value one way", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("numbers identical records, and ordinal 0 is the plain hash", () => {
    expect(contentHash("x", 0)).toBe(contentHash("x"));
    expect(contentHash("x", 1)).not.toBe(contentHash("x"));
    expect(contentHash("x", 1)).not.toBe(contentHash("x", 2));
  });

  it("refuses values without one spelling", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});

describe("text", () => {
  it("splits quoted fields with delimiters, quotes, and line breaks", () => {
    expect(parseCsv('a;b\n"x;1";"say ""hi""\nthere"\n', ";")).toEqual([
      ["a", "b"],
      ["x;1", 'say "hi"\nthere'],
    ]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("decodes UTF-16, Windows-1252, and double-encoded UTF-8", () => {
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x70, 0, 0xe5, 0]))).toBe("på");
    expect(decodeText(Buffer.from([0x70, 0xe5]))).toBe("på");
    expect(decodeText(Buffer.from("﻿på", "utf8"))).toBe("på");
    expect(repairDoubleEncoding("pÃ¥")).toBe("på");
  });

  it("gives table records with row numbers and counts empty rows", () => {
    const { header, records, empty } = tableRecords([["id", "name"], ["1", "a"], ["", ""], ["2", "b"]]);
    expect(header).toEqual(["id", "name"]);
    expect(records).toEqual([
      { row: 2, values: { id: "1", name: "a" } },
      { row: 4, values: { id: "2", name: "b" } },
    ]);
    expect(empty).toBe(1);
  });
});

describe("normalize", () => {
  it("reads dates in their formats", () => {
    expect(parseDate("2025-01-31", "dmy")).toBe("2025-01-31");
    expect(parseDate("31.01.2025", "dmy")).toBe("2025-01-31");
    expect(parseDate("1/31/2025", "mdy")).toBe("2025-01-31");
    expect(parseDate("31.02.2025", "dmy")).toBeNull();
    expect(detectDateFormat(["13/01/2025", "14/01/2025"])).toBe("dmy");
    expect(detectDateFormat(["01/13/2025", "01/14/2025"])).toBe("mdy");
    expect(toIsoUtc(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoUtc("not a time")).toBeNull();
  });

  it("reads amounts with signs, symbols, and separators", () => {
    expect(parseAmount("1.234,50", ",")).toBe(1234.5);
    expect(parseAmount("-kr 123", ",")).toBe(-123);
    expect(parseAmount("(12.00)", ".")).toBe(-12);
    expect(parseAmount("abc", ".")).toBeNull();
    expect(detectDecimal(["1.234,50", "12,00"])).toBe(",");
    expect(toMinorUnits(12.345)).toBe(1235);
  });

  it("finds the header row after opening lines", () => {
    expect(findHeaderRow([["Account 1234"], ["Date", "Text", "Amount"], ["2025-01-01", "x", "1"]])).toBe(1);
    expect(findHeaderRow([["2025-01-01", "x", "1"]])).toBe(-1);
  });
});
