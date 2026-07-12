import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { WeeklyStackedBar, type WeeklyStackedBarPoint } from "./WeeklyStackedBar";

afterEach(() => {
  cleanup();
});

function makeWeeks(): WeeklyStackedBarPoint[] {
  return Array.from({ length: 8 }, (_, i) => ({
    label: `W${i + 1}`,
    CRITICAL: i + 1,
    WARNING: i,
    SUGGESTION: 2,
  }));
}

describe("WeeklyStackedBar", () => {
  it("renders with 8 data points and exposes an accurate aria-label summary", () => {
    const data = makeWeeks();
    // CRITICAL: 1+2+...+8 = 36, WARNING: 0+1+...+7 = 28, SUGGESTION: 2*8 = 16
    render(<WeeklyStackedBar data={data} />);

    const el = screen.getByRole("img", {
      name: "36 critical, 28 warning, 16 suggestion findings over the last 8 weeks",
    });
    expect(el).not.toBeNull();
  });

  it("renders a chart container even with an empty data array", () => {
    render(<WeeklyStackedBar data={[]} />);
    const el = screen.getByRole("img", {
      name: "0 critical, 0 warning, 0 suggestion findings over the last 0 weeks",
    });
    expect(el).not.toBeNull();
  });

  it("derives the aria-label's week count from data.length instead of hardcoding 8", () => {
    const data = [{ label: "W1", CRITICAL: 1, WARNING: 0, SUGGESTION: 0 }];
    render(<WeeklyStackedBar data={data} />);
    const el = screen.getByRole("img", {
      name: "1 critical, 0 warning, 0 suggestion findings over the last 1 week",
    });
    expect(el).not.toBeNull();
  });
});
