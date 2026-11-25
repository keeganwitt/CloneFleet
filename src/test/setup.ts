import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

if (typeof HTMLDialogElement !== "undefined") {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
}

afterEach(() => {
  if (typeof window !== "undefined") {
    cleanup();
    clearMocks();
  }
});
