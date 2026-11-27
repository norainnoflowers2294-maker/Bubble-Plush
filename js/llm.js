/**
 * Local inference — a thin, honest wrapper around wllama (llama.cpp in wasm).
 *
 * Design notes
 * ------------
 * • wllama is stateless. Every call to `generate()` rebuilds the whole prompt
 *   from scratch: [system prompt] + [sliding window] + [new user message].
 *   Nothing is remembered between calls except what we pass in.
 * • We pin wllama 2.4.0's *single-thread* build. It needs no SharedArrayBuffer,
 *   so it runs without COOP/COEP headers — which a static, backend-less PWA
 *   cannot set — and it avoids the ~28 MB JSPI/compat payload that newer
 *   builds require on Safari. Total wasm cost: ~2.7 MB, cached by the SW.
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
 * Build the exact array handed to `createChatCompletion`.
 *
 * Order is fixed by the app's contract:
 *   1. the system prompt (roleplay persona)
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
 * @param {string} params.systemPrompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages
 *        Full conversation, newest message last.
 * @param {number} [params.maxTurns]
 * @returns {Array<{role: 'system'|'user'|'assistant', content: string}>}
 */
export function buildPrompt({ systemPrompt, messages, maxTurns = MODEL.maxTurns }) {
  const newMessage = messages[messages.length - 1];
  const history = messages.slice(0, -1);

  // 1. Sliding window: last N pairs, then trim a leading assistant turn.
  const window = history.slice(-maxTurns * 2);
  while (window.length > 0 && window[0].role !== 'user') {
    window.shift();
  }

  // 2. Character budget: drop the oldest pairs until the window fits.
  const budget = Math.max(
    1200,
    (MODEL.ctxSize - MODEL.maxTokens - 512) * CHARS_PER_TOKEN
  );
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

      await wllama.loadModel([blob], {
        n_ctx: MODEL.ctxSize,
        // Batched prompt processing: bigger batch = faster "reading" of the
        // system prompt and history before the first token appears.
        n_batch: 256,
      });

      this.#wllama = wllama;
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
   * @param {string} params.systemPrompt
   * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages
   * @param {AbortSignal} [params.signal]
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *generate({ systemPrompt, messages, signal }) {
    if (!this.isReady) throw new Error('The model is not loaded yet.');

    const prompt = buildPrompt({ systemPrompt, messages });

    const stream = await this.#wllama.createChatCompletion(prompt, {
      stream: true,
      nPredict: MODEL.maxTokens,
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
