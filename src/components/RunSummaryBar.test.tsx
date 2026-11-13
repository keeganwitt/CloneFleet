import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunSummaryBar } from "./RunSummaryBar";

describe("RunSummaryBar", () => {
  it("closes with a labeled Close button", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <RunSummaryBar
        label="Pull"
        summary={{
          running: 0,
          byStatus: { succeeded: ["/a"], skipped: [], failed: [] },
          reasons: [],
        }}
        activeStatus={undefined}
        onShowStatus={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const close = screen.getByRole("button", { name: "Close run summary" });
    expect(close).toHaveTextContent("Close");
    await user.click(close);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
