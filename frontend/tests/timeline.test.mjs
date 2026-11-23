import assert from "node:assert/strict";
import test from "node:test";
import { timelineAxis } from "../src/timeline.ts";

test("a one-day plan uses the whole day, with its completion marker centered", () => {
  const { ticks, position } = timelineAxis("2026-11-12", 1);
  assert.deepEqual(ticks, [{ day: 0, label: "12/11/2026" }]);
  assert.equal(position(0), "0%");
  assert.equal(position(0.5), "50%");
  assert.equal(position(1), "100%");
});

test("cross-year ticks show full dates and keep bars aligned to calendar offsets", () => {
  const { ticks, position } = timelineAxis("2025-12-30", 4);
  assert.deepEqual(ticks.map(({ label }) => label), ["30/12/2025", "31/12/2025", "01/01/2026", "02/01/2026"]);
  assert.equal(position(ticks[2].day), "50%");
});

test("a long range remains scrollable and suppresses a tick label that would clip", () => {
  const { width, ticks, position } = timelineAxis("2026-01-01", 100);
  assert.ok(width > 1024);
  assert.equal(ticks.at(-1).day, 85);
  assert.ok(ticks.at(-1).label);
  const tight = timelineAxis("2026-01-01", 17);
  assert.deepEqual(tight.ticks.at(-1), { day: 15, label: null });
  assert.equal(position(100), "100%");
});
