import { dateAtOffset, formatDate } from "./calendar.ts";

// A single scale places dates at day boundaries, with room for complete tick labels.
export function timelineAxis(start: string, span: number) {
  const crossesYear = start.slice(0, 4) !== dateAtOffset(start, span - 1).slice(0, 4);
  const tickStep = Math.ceil(span / (crossesYear ? 6 : 9));
  const width = Math.min(1520, Math.max(crossesYear ? 760 : 700, 208 + span * 23));
  const tickCount = Math.ceil(span / tickStep);
  // If a final tick lands close to the edge, omit its label to avoid clipping.
  const minLabelSpace = crossesYear ? 76 : 49;
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const day = index * tickStep;
    const hasRoom = (span - day) * (width - 208) / span >= minLabelSpace;
    return { day, label: hasRoom ? formatDate(dateAtOffset(start, day), crossesYear) : null };
  });
  return { width, ticks, position: (day: number) => `${day * 100 / span}%` };
}
