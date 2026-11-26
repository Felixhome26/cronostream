import { vi } from "vitest";

// `i18n.ts` (imported by most utilities for the UI language) touches the
// DOM and calls the backend as soon as it loads. Under Node there is
// neither, so both get the smallest stand-in that lets it load.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const g = globalThis as Record<string, unknown>;
g.document ??= { documentElement: {} };
g.window ??= { addEventListener: () => {} };
