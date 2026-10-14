import { describe, expect, test } from "bun:test";
import { parseProcStatUtimeStime, windowedCpuPercent } from "./perf-check.ts";

describe("parseProcStatUtimeStime", () => {
  test("parses a normal /proc/stat line", () => {
    // pid 1234, comm "(cat)", state "S", ppid 1, pgid 2, sid 3, tty_nr 4,
    // tty_pgrp 5, flags 6, min_flt 7, cmin_flt 8, maj_flt 9, cmaj_flt 10,
    // utime 11, stime 12, cutime 13, cstime 14, ...
    const line = "1234 (cat) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20";
    const result = parseProcStatUtimeStime(line);
    expect(result).toEqual({ utime: 11, stime: 12 });
  });

  test("parses a line with spaces in comm field", () => {
    const line = "5678 (my process name) S 1 2 3 4 5 6 7 8 9 10 100 200 13 14 15";
    const result = parseProcStatUtimeStime(line);
    expect(result).toEqual({ utime: 100, stime: 200 });
  });

  test("parses a line with closing paren in comm field", () => {
    const line = "9012 (a(b)c) S 1 2 3 4 5 6 7 8 9 10 50 60 13 14 15";
    const result = parseProcStatUtimeStime(line);
    expect(result).toEqual({ utime: 50, stime: 60 });
  });

  test("returns undefined for empty string", () => {
    expect(parseProcStatUtimeStime("")).toBeUndefined();
  });

  test("returns undefined for line without closing paren", () => {
    expect(parseProcStatUtimeStime("1234 no parens")).toBeUndefined();
  });

  test("returns undefined when fields are missing after comm", () => {
    const line = "1234 (comm) S 1 2";
    expect(parseProcStatUtimeStime(line)).toBeUndefined();
  });

  test("returns undefined when utime/stime are non-numeric", () => {
    const line = "1234 (comm) S 1 2 3 4 5 6 7 8 9 10 abc def 13 14 15";
    expect(parseProcStatUtimeStime(line)).toBeUndefined();
  });

  test("returns undefined when only closing paren is at end", () => {
    expect(parseProcStatUtimeStime("1234 ()")).toBeUndefined();
  });
});

describe("windowedCpuPercent", () => {
  test("computes 0% for zero delta", () => {
    expect(windowedCpuPercent(0, 100, 2)).toBe(0);
  });

  test("computes 50% for 100 jiffies over 2s at CLK_TCK=100", () => {
    // 100 jiffies / 100 ticks/s / 2s * 100 = 50%
    expect(windowedCpuPercent(100, 100, 2)).toBe(50);
  });

  test("computes 100% for 200 jiffies over 2s at CLK_TCK=100", () => {
    expect(windowedCpuPercent(200, 100, 2)).toBe(100);
  });

  test("handles CLK_TCK=1000 (some architectures)", () => {
    // 500 jiffies / 1000 ticks/s / 2s * 100 = 25%
    expect(windowedCpuPercent(500, 1000, 2)).toBe(25);
  });

  test("returns 0 for zero wall seconds", () => {
    expect(windowedCpuPercent(100, 100, 0)).toBe(0);
  });

  test("returns 0 for negative wall seconds", () => {
    expect(windowedCpuPercent(100, 100, -1)).toBe(0);
  });

  test("returns 0 for zero CLK_TCK", () => {
    expect(windowedCpuPercent(100, 0, 2)).toBe(0);
  });

  test("handles fractional CPU usage", () => {
    // 5 jiffies / 100 ticks/s / 2s * 100 = 2.5%
    expect(windowedCpuPercent(5, 100, 2)).toBe(2.5);
  });
});
