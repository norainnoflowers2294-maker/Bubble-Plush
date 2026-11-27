/**
 * Central knobs. Everything the app tunes lives here so the modules below stay
 * free of magic numbers.
 */

export const APP = {
  name: 'Bubble Plush',
  /** Bumped whenever the service worker shell changes (keep in sync with sw.js). */
  shellVersion: 'v7',
};

/**
 * Model / generation settings.
 *
 * `ctxSize` is the llama.cpp context window we ask for. 4096 is the sweet spot
 * for phones: big enough for a persona plus a real conversation, small enough
 * that the KV cache still fits comfortably in wasm memory.
 */
export const MODEL = {
  ctxSize: 4096,
  /** Sliding-window size, in user/assistant pairs (see llm.js#buildPrompt). */
  maxTurns: 10,
  /** Hard cap on generated tokens per reply. */
  maxTokens: 512,
  sampling: {
    temp: 0.8,
    top_k: 40,
    top_p: 0.95,
    min_p: 0.05,
    penalty_last_n: 64,
    penalty_repeat: 1.08,
  },
};

export const UNTITLED = 'New chat';

/** Where things are stored. */
export const STORAGE = {
  dbName: 'bubble-plush',
  dbVersion: 1,
  /** Directory created inside the Origin Private File System. */
  opfsDir: 'models',
  /** Fixed name: one model at a time keeps the UI honest. */
  modelFileName: 'model.gguf',
  /** Keys used inside the IndexedDB `meta` store. */
  keys: {
    modelMeta: 'model-meta',
  },
};

/** Longest conversation title we derive from the first user message. */
export const TITLE_MAX_LENGTH = 42;
