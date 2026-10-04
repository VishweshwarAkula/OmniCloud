import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";

describe("Button", () => {
  it("is a real button that activates from the keyboard", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Sign in</Button>);
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn).toHaveAttribute("type", "button");
    btn.focus();
    fireEvent.click(btn); // Enter/Space on a native button dispatch click
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled while loading", () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Hello">
      <button>Inside</button>
    </Modal>
  );
}

describe("Modal", () => {
  it("exposes dialog semantics and closes on Escape", async () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Hello" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
