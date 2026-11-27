/**
 * App controller.
 *
 * Owns the mutable state (active conversation, settings, model status) and is
 * the only module that talks to both storage and inference. The view is driven
 * through `ui`; user intent arrives through the handlers passed to `ui.init`.
 *
 * Boot sequence
 *   1. open IndexedDB, restore settings + the most recent conversation
 *   2. render that conversation (so the chat is on screen immediately)
 *   3. look for a model in OPFS → load it silently in the background
 *   4. if there is no model, show the .gguf picker instead
 */

import { TITLE_MAX_LENGTH, UNTITLED } from './config.js';
import { openDB, putConversation, getRecentConversation } from './db.js';
import {
  getModelMeta,
  readModelBlob,
  saveModel,
  deleteModel,
  isGguf,
  formatBytes,
  getStorageEstimate,
  requestPersistence,
} from './model-store.js';
import { localModel } from './llm.js';
import { ui } from './ui.js';

/* ========================================================================== */
/* State                                                                      */
/* ========================================================================== */

/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {string} characterScenario  who the AI is, and where we are
 * @property {string} aiRules            hard rules that outrank the scenario
 * @property {Array<{role: string, content: string}>} messages
 * @property {number} lastModified
 */

const state = {
  /** @type {Conversation|null} */
  conversation: null,
  /** 'unknown' | 'missing' | 'loading' | 'ready' | 'error' */
  modelStatus: 'unknown',
  /** @type {{name: string, size: number, savedAt: number, mode: string}|null} */
  modelMeta: null,
  /** @type {AbortController|null} */
  abortController: null,
  busy: false,
};

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

function createConversation() {
  return {
    id: uid(),
    title: UNTITLED,
    characterScenario: '',
    aiRules: '',
    messages: [],
    lastModified: Date.now(),
  };
}

/**
 * Fill in fields that older records may lack, so the rest of the app can
 * assume they exist. Conversations written before the two-tab settings screen
 * had a single `systemPrompt`; keep that text as the character.
 * @param {any} raw
 * @returns {Conversation}
 */
function normalizeConversation(raw) {
  const conversation = { ...raw };

  if (typeof conversation.characterScenario !== 'string') {
    conversation.characterScenario =
      typeof conversation.systemPrompt === 'string' ? conversation.systemPrompt : '';
  }
  if (typeof conversation.aiRules !== 'string') conversation.aiRules = '';
  if (!Array.isArray(conversation.messages)) conversation.messages = [];
  delete conversation.systemPrompt;

  return conversation;
}

/** First user message becomes the conversation title, clipped to one line. */
function deriveTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_MAX_LENGTH
    ? `${clean.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : clean;
}

/** Persist the active conversation. Called after *every* message change. */
async function persistConversation() {
  if (!state.conversation) return;
  state.conversation.lastModified = Date.now();
  await putConversation(state.conversation);
}

/** Turn raw errors into something a human can act on. */
function friendlyError(error) {
  const message = String(error?.message ?? error);
  if (/out of memory|OOM|memory access|RangeError/i.test(message)) {
    return 'That model is too big for this device to load.';
  }
  if (/version mismatch/i.test(message)) {
    return 'This .gguf was built for a different llama.cpp. Try another file.';
  }
  if (/template/i.test(message)) {
    return 'This model has no chat template, so it can’t chat. Try an instruct model.';
  }
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

/* ========================================================================== */
/* Model lifecycle                                                            */
/* ========================================================================== */

/** Composer/subtitle reflect the model state in one place. */
function applyModelGate() {
  switch (state.modelStatus) {
    case 'ready':
      ui.setSubtitle('on-device');
      ui.setStatus(null);
      ui.setComposerEnabled(true, 'Say something soft…');
      break;
    case 'loading':
      ui.setSubtitle('waking up…');
      ui.setComposerEnabled(false, 'Waking up…');
      break;
    case 'missing':
      ui.setSubtitle('no model');
      ui.setStatus(null);
      ui.setComposerEnabled(false, 'Add a model first');
      break;
    case 'error':
      ui.setSubtitle('model error');
      ui.setStatus(null);
      ui.setComposerEnabled(false, 'Model unavailable');
      break;
    default:
      break;
  }
}

/** Load whatever the model store currently holds. */
async function loadStoredModel({ announce = true } = {}) {
  state.modelStatus = 'loading';
  applyModelGate();
  ui.setStatus({ text: 'Waking up the model…' });

  try {
    const blob = await readModelBlob();
    if (!blob) throw new Error('The model file is missing from storage.');

    await localModel.load(blob);

    state.modelStatus = 'ready';
    applyModelGate();
    if (announce) ui.toast('Model ready');
    // Nothing said yet? Offer a greeting now that we can actually answer.
    if (state.conversation && state.conversation.messages.length === 0) {
      ui.showGreeting();
    }
  } catch (error) {
    console.error('[app] model load failed:', error);
    state.modelStatus = 'error';
    applyModelGate();
    ui.toast(friendlyError(error), 4200);
  }
}

/** No model in storage: ask for one, or explain how to add one. */
function handleMissingModel() {
  state.modelStatus = 'missing';
  applyModelGate();

  if (state.conversation && state.conversation.messages.length === 0) {
    ui.showOnboarding();
  } else {
    ui.toast('Add a model in Settings to keep chatting.');
  }
}

/** Copy a picked .gguf into private storage, then load it. */
async function importModel(file) {
  if (state.modelStatus === 'loading') {
    ui.toast('Hang on — a model is still loading.');
    return;
  }

  if (!(await isGguf(file))) {
    ui.toast('That file doesn’t look like a .gguf model.');
    return;
  }

  ui.setSubtitle('saving…');
  ui.setComposerEnabled(false, 'Copying model…');
  ui.setStatus({ text: 'Copying the model', progress: 0 });

  try {
    const meta = await saveModel(file, (received, total) => {
      const progress = total > 0 ? (received / total) * 100 : 0;
      ui.setStatus({ text: 'Copying the model', progress });
    });

    state.modelMeta = meta;
    ui.renderModelInfo(meta, formatBytes(meta.size));
    ui.toast('Saved. It will load itself from now on.');

    // Free the previous model before allocating a new one — phones have little
    // headroom for two wasm instances.
    await localModel.unload();
    state.modelStatus = 'unknown';

    await loadStoredModel({ announce: false });
    await updateStorageNote();
  } catch (error) {
    console.error('[app] import failed:', error);
    state.modelStatus = 'error';
    applyModelGate();
    ui.setStatus(null);
    ui.toast(`Could not save the model: ${friendlyError(error)}`, 4200);
  }
}

async function removeModel() {
  if (!window.confirm('Remove the model from this device? Your chats stay.')) return;

  await localModel.unload();
  await deleteModel();

  state.modelMeta = null;
  ui.renderModelInfo(null);
  handleMissingModel();
  await updateStorageNote();
  ui.toast('Model removed');
}

/* ========================================================================== */
/* Chat                                                                       */
/* ========================================================================== */

async function sendMessage(text) {
  if (state.busy) return;

  if (state.modelStatus !== 'ready') {
    ui.toast(
      state.modelStatus === 'loading'
        ? 'Still waking up — one moment.'
        : 'Add a model in Settings first.'
    );
    return;
  }

  const conversation = state.conversation;

  // 1. Record + paint the user message, persist immediately.
  conversation.messages.push({ role: 'user', content: text });
  if (conversation.title === UNTITLED) conversation.title = deriveTitle(text);
  ui.appendMessage({ role: 'user', content: text });
  await persistConversation();

  // 2. Generate.
  state.busy = true;
  ui.setGenerating(true);

  const controller = new AbortController();
  state.abortController = controller;
  const stream = ui.beginStream('Thinking…');
  let reply = '';

  try {
    // The whole conversation is passed in; llm.js rebuilds the prompt
    // ([rules + scenario] + [sliding window] + [new user message]) every call.
    for await (const partial of localModel.generate({
      aiRules: conversation.aiRules,
      characterScenario: conversation.characterScenario,
      messages: conversation.messages,
      signal: controller.signal,
    })) {
      reply = partial;
      stream.setText(reply);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[app] generation failed:', error);
      ui.toast(friendlyError(error), 4000);
    }
    // An abort keeps whatever partial text already streamed.
  } finally {
    stream.end();
    state.busy = false;
    state.abortController = null;
    ui.setGenerating(false);

    const finalText = reply.trim();
    if (finalText) {
      conversation.messages.push({ role: 'assistant', content: finalText });
      await persistConversation();
    } else if (!controller.signal.aborted) {
      ui.toast('The model stayed quiet. Try again?');
    }
  }
}

function stopGenerating() {
  state.abortController?.abort();
}

async function startNewChat() {
  if (state.busy) {
    ui.toast('Let this reply finish first.');
    return;
  }

  const conversation = createConversation();
  await putConversation(conversation);
  state.conversation = conversation;

  ui.renderConversation(conversation);
  ui.setPromptFields(conversation);
  ui.closeSettings();

  if (state.modelStatus === 'ready') ui.showGreeting();
  else if (state.modelStatus === 'missing') ui.showOnboarding();
}

/**
 * Write one prompt field on the *current* conversation and persist it.
 * @param {'characterScenario'|'aiRules'} field
 * @param {string} value
 */
async function savePromptField(field, value) {
  if (!state.conversation) {
    state.conversation = createConversation();
    await putConversation(state.conversation);
  }

  state.conversation[field] = String(value ?? '').trim();
  await persistConversation();

  ui.toast('Saved ✓');
}

/* ========================================================================== */
/* Misc                                                                       */
/* ========================================================================== */

async function updateStorageNote() {
  const estimate = await getStorageEstimate();
  if (!estimate) return;
  ui.setStorageNote(
    `Storage: ${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} available.`
  );
}

/**
 * iOS: the on-screen keyboard shrinks the *visual* viewport without resizing
 * the layout viewport. Mirroring visualViewport.height into --app-height keeps
 * the composer above the keyboard instead of hidden behind it.
 */
function bindViewportHeight() {
  const apply = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
  };
  apply();
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const register = () =>
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('[app] service worker registration failed:', error);
    });

  // `boot()` is async, so by the time we get here the `load` event has usually
  // already fired. Registering only from a `load` listener would silently never
  // run — check readyState instead.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/* ========================================================================== */
/* Boot                                                                       */
/* ========================================================================== */

async function boot() {
  bindViewportHeight();

  // Ask for durable storage up front: Safari evicts "best effort" origins, and
  // losing a 1 GB model is the one thing this app can't recover from cheaply.
  requestPersistence();

  ui.init({
    onSend: sendMessage,
    onStop: stopGenerating,
    onNewChat: startNewChat,
    onOpenSettings: () => {
      ui.renderModelInfo(state.modelMeta ?? null, state.modelMeta ? formatBytes(state.modelMeta.size) : '');
      ui.setPromptFields(state.conversation);
      updateStorageNote();
    },
    onCloseSettings: () => {},
    onPickModel: () => document.getElementById('file-input').click(),
    onModelFile: importModel,
    onSaveCharacterScenario: (text) => savePromptField('characterScenario', text),
    onSaveAiRules: (text) => savePromptField('aiRules', text),
    onRemoveModel: removeModel,
  });

  await openDB();

  // Most recent conversation, with any missing prompt fields filled in.
  let conversation = await getRecentConversation();
  conversation = conversation ? normalizeConversation(conversation) : createConversation();
  await putConversation(conversation);

  state.conversation = conversation;
  ui.renderConversation(conversation);
  ui.setPromptFields(conversation);

  // Model: import once, auto-load forever. (Whether to greet or to ask for a
  // model is decided below, once we know whether one exists.)
  state.modelMeta = await getModelMeta();
  ui.renderModelInfo(state.modelMeta, state.modelMeta ? formatBytes(state.modelMeta.size) : '');

  if (state.modelMeta) {
    // Greet straight away; loading happens silently underneath.
    if (conversation.messages.length === 0) ui.showGreeting();
    loadStoredModel({ announce: false });
  } else {
    handleMissingModel();
  }

  updateStorageNote();
  registerServiceWorker();
}

boot().catch((error) => {
  console.error('[app] boot failed:', error);
  ui.showFatal(
    'Bubble Plush can’t start.',
    friendlyError(error) || 'Local storage is not available in this browser.'
  );
});
