/**
 * Local inference — a thin, honest wrapper around wllama (llama.cpp in wasm).
 *
 * Design notes
 * ------------
 * • wllama is stateless. Every call to `generate()` rebuilds the whole prompt
 *   from scratch: [system prompt] + [sliding window] + [new user message].
 *   Nothing is remembered between calls except what we pass in.
 * • We pin wllama 2.3.7's *single-thread* build: a 2.1 MB wasm with a 32-bit
 *   linear memory. It needs no SharedArrayBuffer (so no COOP/COEP headers,
 *   which a static, backend-less PWA cannot set) and — unlike 2.4.0 and 3.x —
 *   it does not require the WebAssembly Memory64 proposal, which Safari below
 *   18.4 and Chrome below 133 cannot compile at all. Newer wllama builds also
 *   drag in a ~28 MB JSPI/compat payload on Safari.
 * • Generation is exposed as an async generator of *cumulative* text, which is
 *   exactly what the UI needs to repaint a streaming bubble.
 */

import { Wllama } from '../vendor/wllama/index.js';
import { MODEL } from './config.js';

/** Resolved relative to this module, so it works from any deploy path. */
const WASM_PATH = new URL('../vendor/wllama/single-thread/wllama.wasm', import.meta.url).href;

/** Keep the native llama.cpp chatter out of the console, keep real problems. */
const logger = {
  debug() {},
  log() {},
  warn: (...args) => console.warn('[wllama]', ...args),
  error: (...args) => console.error('[wllama]', ...args),
};

/* ========================================================================== */
/* Prompt construction                                                        */
/* ========================================================================== */

/** Rough English heuristic: ~4 characters per token. Deliberately pessimistic. */
const CHARS_PER_TOKEN = 4;

/**
 * Pick a context window that leaves room for the weights.
 *
 * A phone has one memory budget for everything: weights + KV cache + compute
 * scratch. The KV cache grows with the context window, so a 4096-token window
 * that is free on a 350 MB model is what pushes a 1.2 GB model over the edge.
 * Shrinking the window is the cheapest way to make a bigger file fit.
 *
 * @param {number} bytes size of the .gguf on disk
 * @returns {number} context size to request from llama.cpp
 */
export function contextForSize(bytes) {
  const mb = (bytes || 0) / (1024 * 1024);
  if (mb <= 500) return MODEL.ctxSize; // 4096
  if (mb <= 1000) return 3072;
  if (mb <= 1600) return 2048;
  return 1536;
}

/**
 * The single system message, assembled from the two Settings tabs.
 *
 * Order is fixed: AI rules first, then the character/scenario. With both
 * present the result is exactly `aiRules + "\n\n" + characterScenario`; an
 * empty field simply drops out instead of leaving stray blank lines.
 *
 * @param {string} [aiRules]
 * @param {string} [characterScenario]
 * @returns {string}
 */
export function composeSystemPrompt(aiRules, characterScenario) {
  return [aiRules, characterScenario]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build the exact array handed to `createChatCompletion`.
 *
 * Order is fixed by the app's contract:
 *   1. one system message: AI rules, then character & scenario
 *   2. a sliding window of recent history — at most `maxTurns` pairs
 *   3. the new user message
 *
 * Two independent guards keep us away from the context ceiling:
 *   • a hard cap of `maxTurns` turn-pairs (older messages stay in IndexedDB,
 *     they're just not sent), and
 *   • a character budget derived from `ctxSize`, because ten long messages can
 *     still overflow a 4096-token window and crash generation.
 *
 * The window always starts on a *user* turn: some chat templates misbehave
 * when the history begins with an orphaned assistant message.
 *
 * @param {object} params
 * @param {string} [params.aiRules]
 * @param {string} [params.characterScenario]
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages
 *        Full conversation, newest message last.
 * @param {number} [params.maxTurns]
 * @returns {Array<{role: 'system'|'user'|'assistant', content: string}>}
 */
export function buildPrompt({
  aiRules = '',
  characterScenario = '',
  messages,
  maxTurns = MODEL.maxTurns,
  ctxSize = MODEL.ctxSize,
}) {
  const systemPrompt = composeSystemPrompt(aiRules, characterScenario);
  const newMessage = messages[messages.length - 1];
  const history = messages.slice(0, -1);

  // 1. Sliding window: last N pairs, then trim a leading assistant turn.
  const window = history.slice(-maxTurns * 2);
  while (window.length > 0 && window[0].role !== 'user') {
    window.shift();
  }

  // 2. Character budget: drop the oldest pairs until the window fits.
  const budget = Math.max(1200, (ctxSize - MODEL.maxTokens - 512) * CHARS_PER_TOKEN);
  const baseCost = (systemPrompt?.length ?? 0) + (newMessage?.content.length ?? 0);
  let windowCost = window.reduce((sum, message) => sum + message.content.length, 0);
  while (window.length >= 2 && baseCost + windowCost > budget) {
    windowCost -= window[0].content.length + window[1].content.length;
    window.splice(0, 2);
  }

  // 3. Assemble in the required order.
  const prompt = [];
  if (systemPrompt && systemPrompt.trim()) {
    prompt.push({ role: 'system', content: systemPrompt.trim() });
  }
  for (const message of window) {
    prompt.push({ role: message.role, content: message.content });
  }
  prompt.push({ role: 'user', content: newMessage.content });

  return prompt;
}

/* ========================================================================== */
/* Model                                                                      */
/* ========================================================================== */

export class LocalModel {
  /** @type {Wllama|null} */
  #wllama = null;

  /** 'idle' | 'loading' | 'ready' */
  #state = 'idle';

  /** Context window actually requested; drives the prompt budget. */
  #ctxSize = MODEL.ctxSize;

  get state() {
    return this.#state;
  }

  get isReady() {
    return this.#state === 'ready' && this.#wllama !== null;
  }

  /**
   * Load a GGUF blob into wasm memory.
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  async load(blob) {
    if (this.#state === 'loading') throw new Error('A model is already loading.');

    this.#state = 'loading';

    try {
      const wllama = new Wllama(
        { 'single-thread/wllama.wasm': WASM_PATH },
        { logger }
      );

      // Small models get the full window; big files get a shorter one so the
      // weights still fit in the tab's memory.
      const ctxSize = contextForSize(blob.size);

      await wllama.loadModel([blob], {
        n_ctx: ctxSize,
        // Batched prompt processing: bigger batch = faster "reading" of the
        // system prompt and history before the first token appears.
        n_batch: 256,
      });

      this.#wllama = wllama;
      this.#ctxSize = ctxSize;
      this.#state = 'ready';
    } catch (error) {
      this.#state = 'idle';
      this.#wllama = null;
      throw error;
    }
  }

  /**
   * Stream a reply.
   *
   * Yields cumulative text after each token (chunk.currentText), so callers can
   * simply replace the bubble contents. Stops early on `signal.abort()`.
   *
   * @param {object} params
   * @param {string} [params.aiRules]
   * @param {string} [params.characterScenario]
   * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages
   * @param {AbortSignal} [params.signal]
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *generate({ aiRules, characterScenario, messages, signal }) {
    if (!this.isReady) throw new Error('The model is not loaded yet.');

    const prompt = buildPrompt({
      aiRules,
      characterScenario,
      messages,
      ctxSize: this.#ctxSize,
    });

    const stream = await this.#wllama.createChatCompletion(prompt, {
      stream: true,
      // Never ask for more room than the window can give.
      nPredict: Math.min(MODEL.maxTokens, Math.max(128, Math.floor(this.#ctxSize / 4))),
      sampling: MODEL.sampling,
      abortSignal: signal,
      // Re-evaluate the prompt each turn. Our sliding window changes the prefix
      // anyway, and a stale KV cache is a classic source of "the AI answered
      // the previous question" bugs.
      useCache: false,
    });

    for await (const chunk of stream) {
      yield chunk.currentText;
    }
  }

  /** Free wasm memory. Required before swapping models on a phone. */
  async unload() {
    const wllama = this.#wllama;
    this.#wllama = null;
    this.#state = 'idle';
    this.#ctxSize = MODEL.ctxSize;
    if (wllama) {
      try {
        await wllama.exit();
      } catch (error) {
        console.warn('[llm] exit() failed:', error);
      }
    }
  }
}

/** Single shared instance — wasm memory is far too expensive for more. */
export const localModel = new LocalModel();
