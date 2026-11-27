/**
 * View layer — plain DOM, no framework.
 *
 * The UI is a dumb renderer: it never talks to IndexedDB or wllama. `main.js`
 * owns state and calls into this module; user intent comes back through the
 * handlers registered in `init()`.
 *
 * Message text is always written with `textContent` (never innerHTML), so model
 * output and user input cannot inject markup.
 */

/* Inline icons: swapping these is cheaper than juggling two <svg> nodes. */
const ICON_SEND = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </svg>`;

const ICON_STOP = `
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="2.6" />
  </svg>`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The orb markup, reused in the log, the onboarding card and the status pill. */
function createOrb(size = '') {
  const orb = el('div', `orb ${size}`.trim());
  orb.setAttribute('aria-hidden', 'true');
  orb.append(el('span', 'orb__aura'), el('span', 'orb__core'));
  return orb;
}

class UI {
  constructor() {
    /** @type {Record<string, any>} */
    this.handlers = {};
    this.stickToBottom = true;
    this.generating = false;
    this.#streamBubble = null;
    this.#orbRow = null;
    this.#toastTimer = 0;
    /** @type {Array<{tab: HTMLElement, panel: HTMLElement}>} */
    this.tabs = [];
  }

  #streamBubble;
  #orbRow;
  #toastTimer;

  /* ---------------------------------------------------------------- setup */

  /** Cache elements and wire every event listener once. */
  init(handlers) {
    this.handlers = handlers;

    this.els = {
      log: document.getElementById('log'),
      logInner: document.getElementById('log-inner'),
      composer: document.getElementById('composer'),
      input: document.getElementById('input'),
      send: document.getElementById('btn-send'),
      status: document.getElementById('status'),
      brandSub: document.getElementById('brand-sub'),
      sheet: document.getElementById('sheet'),
      modelName: document.getElementById('model-name'),
      modelMeta: document.getElementById('model-meta'),
      pickModel: document.getElementById('btn-pick-model'),
      pickModelLabel: document.getElementById('pick-model-label'),
      removeModel: document.getElementById('btn-remove-model'),
      characterScenario: document.getElementById('character-scenario'),
      aiRules: document.getElementById('ai-rules'),
      saveCharacter: document.getElementById('btn-save-character'),
      saveRules: document.getElementById('btn-save-rules'),
      storageNote: document.getElementById('storage-note'),
      diag: document.getElementById('diag'),
      fileInput: document.getElementById('file-input'),
      toast: document.getElementById('toast'),
    };

    // ---- composer -------------------------------------------------------
    this.els.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.generating) {
        this.handlers.onStop?.();
        return;
      }
      this.#submit();
    });

    this.els.input.addEventListener('input', () => {
      this.#autoGrow();
      this.#syncSendState();
    });

    // iOS can leave the whole page scrolled after the keyboard closes; snap it
    // back so the layout doesn't sit half-way up the screen.
    this.els.input.addEventListener('blur', () => window.scrollTo(0, 0));

    // Enter sends, Shift+Enter makes a newline. `isComposing` keeps IME
    // (Japanese/Chinese keyboards) from sending half a word.
    this.els.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!this.generating) this.#submit();
    });

    // ---- header / settings ---------------------------------------------
    document.getElementById('btn-new').addEventListener('click', () => {
      this.handlers.onNewChat?.();
    });
    document.getElementById('btn-settings').addEventListener('click', () => this.openSettings());
    document.getElementById('btn-close-settings').addEventListener('click', () => this.closeSettings());

    // ---- model ---------------------------------------------------------
    this.els.pickModel.addEventListener('click', () => this.handlers.onPickModel?.());
    this.els.removeModel.addEventListener('click', () => this.handlers.onRemoveModel?.());

    this.els.fileInput.addEventListener('change', () => {
      const file = this.els.fileInput.files?.[0];
      // Reset first: picking the same file twice must still fire `change`.
      this.els.fileInput.value = '';
      if (file) this.handlers.onModelFile?.(file);
    });

    // ---- persona -------------------------------------------------------
    // Two tabs, each with its own field and explicit Save. Arrow keys move
    // between tabs, as expected of a tablist.
    this.tabs = [
      {
        tab: document.getElementById('tab-character'),
        panel: document.getElementById('panel-character'),
      },
      { tab: document.getElementById('tab-rules'), panel: document.getElementById('panel-rules') },
    ];

    this.tabs.forEach(({ tab }, index) => {
      tab.addEventListener('click', () => this.showTab(index));
      tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = (index + step + this.tabs.length) % this.tabs.length;
        this.showTab(next);
        this.tabs[next].tab.focus();
      });
    });

    this.els.saveCharacter.addEventListener('click', () =>
      this.handlers.onSaveCharacterScenario?.(this.els.characterScenario.value)
    );
    this.els.saveRules.addEventListener('click', () =>
      this.handlers.onSaveAiRules?.(this.els.aiRules.value)
    );

    // ---- scroll stickiness --------------------------------------------
    this.els.log.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.els.log;
      this.stickToBottom = scrollHeight - scrollTop - clientHeight < 60;
    }, { passive: true });
  }

  /* ------------------------------------------------------------- composer */

  #submit() {
    const text = this.els.input.value.trim();
    if (!text) return;
    this.els.input.value = '';
    this.#autoGrow();
    this.#syncSendState();
    this.handlers.onSend?.(text);
  }

  /** Grow the textarea with its content, up to the CSS max-height. */
  #autoGrow() {
    const input = this.els.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  #syncSendState() {
    if (this.generating) {
      this.els.send.disabled = false;
      return;
    }
    this.els.send.disabled = this.els.input.value.trim().length === 0 || this.els.input.disabled;
  }

  setComposerEnabled(enabled, placeholder) {
    this.els.input.disabled = !enabled;
    if (placeholder) this.els.input.placeholder = placeholder;
    this.#syncSendState();
  }

  /** Toggle the send button between "send" and "stop". */
  setGenerating(generating) {
    this.generating = generating;
    this.els.send.classList.toggle('send--stop', generating);
    this.els.send.innerHTML = generating ? ICON_STOP : ICON_SEND;
    this.els.send.setAttribute('aria-label', generating ? 'Stop generating' : 'Send');
    this.els.send.disabled = generating ? false : this.els.input.value.trim().length === 0;
  }

  /* ------------------------------------------------------------ chat log */

  clearLog() {
    this.els.logInner.replaceChildren();
    this.#streamBubble = null;
    this.#orbRow = null;
    this.stickToBottom = true;
  }

  /**
   * @param {{role: 'user'|'assistant', content: string}} message
   * @returns {HTMLElement} the bubble
   */
  appendMessage(message) {
    // The greeting / onboarding card is a placeholder for "nothing here yet".
    this.els.logInner.querySelector('.empty')?.remove();

    const row = el('article', `msg msg--${message.role === 'user' ? 'user' : 'ai'}`);
    const bubble = el('div', 'bubble', message.content);
    row.append(bubble);
    this.els.logInner.append(row);
    this.#scrollIfSticky();
    return bubble;
  }

  /** Paint a full conversation from storage. */
  renderConversation(conversation) {
    this.clearLog();
    for (const message of conversation.messages) {
      this.appendMessage(message);
    }
    this.scrollToBottom(true);
  }

  /**
   * Start a reply: shows the orb immediately, then swaps in a streaming bubble
   * as soon as the first token lands.
   */
  beginStream(label = 'Thinking…') {
    this.showOrb(label);
    // Tell assistive tech to hold announcements until the reply is complete,
    // instead of re-reading the bubble on every token.
    this.els.log.setAttribute('aria-busy', 'true');

    return {
      setText: (text) => {
        if (!this.#streamBubble) {
          // The orb was the "still thinking" placeholder; the bubble replaces it.
          this.hideOrb();
          this.#streamBubble = this.appendMessage({ role: 'assistant', content: '' });
          this.#streamBubble.classList.add('bubble--streaming');
        }
        this.#streamBubble.textContent = text;
        this.#scrollIfSticky();
      },
      end: () => {
        if (this.#streamBubble) {
          this.#streamBubble.classList.remove('bubble--streaming');
          this.#streamBubble = null;
        }
        this.hideOrb();
        this.els.log.setAttribute('aria-busy', 'false');
      },
    };
  }

  showOrb(label) {
    this.hideOrb();
    const row = el('div', 'orb-row');
    row.append(createOrb());
    if (label) row.append(el('span', 'orb-row__label', label));
    this.els.logInner.append(row);
    this.#orbRow = row;
    this.#scrollIfSticky();
  }

  hideOrb() {
    this.#orbRow?.remove();
    this.#orbRow = null;
  }

  #scrollIfSticky() {
    if (this.stickToBottom) this.scrollToBottom();
  }

  scrollToBottom(force = false) {
    if (!force && !this.stickToBottom) return;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  /* -------------------------------------------------------- empty states */

  /** First run, or the model was removed: ask for the .gguf file. */
  showOnboarding() {
    this.clearLog();
    const wrap = el('div', 'empty');
    const orb = createOrb();
    orb.style.setProperty('--orb-size', '64px');

    const button = el('button', 'btn btn--primary', 'Choose .gguf');
    button.type = 'button';
    button.addEventListener('click', () => this.handlers.onPickModel?.());

    wrap.append(
      orb,
      el('h2', 'empty__title', 'Add a model'),
      el(
        'p',
        'empty__body',
        'Bubble Plush runs entirely on your phone. Pick a .gguf model file once — it gets copied into private storage and loads itself from then on.'
      ),
      button,
      el('span', 'empty__hint', 'Nothing is uploaded. No account needed.')
    );
    this.els.logInner.append(wrap);
  }

  /** Model ready but the conversation is empty. */
  showGreeting() {
    this.clearLog();
    const wrap = el('div', 'empty');
    wrap.append(
      createOrb(),
      el('h2', 'empty__title', 'Hi, I’m Bubble Plush.'),
      el('p', 'empty__body', 'Say something soft — I’m all ears. Everything we talk about stays on this device.')
    );
    this.els.logInner.append(wrap);
  }

  /** Unrecoverable start-up problem (no local storage, corrupt database). */
  showFatal(title, body) {
    this.clearLog();
    this.setStatus(null);
    this.setComposerEnabled(false, 'Unavailable');

    const wrap = el('div', 'empty');
    wrap.append(
      el('h2', 'empty__title', title),
      el('p', 'empty__body', body),
      el(
        'p',
        'empty__hint',
        'Bubble Plush keeps everything on this device, so it needs local storage. Private browsing and “block all cookies” settings can prevent that.'
      )
    );
    this.els.logInner.append(wrap);
  }

  /* ------------------------------------------------------------- status */

  /**
   * @param {{text: string, progress?: number}|null} status
   */
  setStatus(status) {
    const node = this.els.status;
    if (!status) {
      node.hidden = true;
      node.replaceChildren();
      return;
    }

    const pill = el('span', 'status__pill');
    pill.append(createOrb('orb--sm'), el('span', '', status.text));

    if (typeof status.progress === 'number') {
      const pct = Math.min(100, Math.max(0, Math.round(status.progress)));
      pill.append(el('span', 'status__pct', `${pct}%`));
    }

    node.replaceChildren(pill);
    node.hidden = false;
  }

  setSubtitle(text) {
    this.els.brandSub.textContent = text;
  }

  /* ----------------------------------------------------------- settings */

  get isSettingsOpen() {
    return this.els.sheet.classList.contains('is-open');
  }

  openSettings() {
    this.els.sheet.classList.add('is-open');
    this.els.sheet.setAttribute('aria-hidden', 'false');
    this.handlers.onOpenSettings?.();
  }

  closeSettings() {
    this.els.sheet.classList.remove('is-open');
    this.els.sheet.setAttribute('aria-hidden', 'true');
    this.handlers.onCloseSettings?.();
  }

  /** @param {{name: string, size: number, savedAt: number}|null} meta */
  renderModelInfo(meta, sizeLabel) {
    if (meta) {
      this.els.modelName.textContent = meta.name || 'model.gguf';
      this.els.modelMeta.textContent = `${sizeLabel} · saved ${new Date(meta.savedAt).toLocaleDateString()}`;
      this.els.removeModel.hidden = false;
      // Picking again overwrites the stored file, so say so.
      this.els.pickModelLabel.textContent = 'Change model';
    } else {
      this.els.modelName.textContent = 'No model loaded';
      this.els.modelMeta.textContent = 'Add a .gguf file to begin';
      this.els.removeModel.hidden = true;
      this.els.pickModelLabel.textContent = 'Choose .gguf';
    }
  }

  /** @param {number} index 0 = Character & Scenario, 1 = AI Rules */
  showTab(index) {
    this.tabs.forEach(({ tab, panel }, i) => {
      const active = i === index;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    });
  }

  /**
   * Load one conversation's prompt fields into the sheet.
   * @param {{characterScenario?: string, aiRules?: string}|null} conversation
   */
  setPromptFields(conversation) {
    // Never overwrite what the user is currently typing.
    if (document.activeElement !== this.els.characterScenario) {
      this.els.characterScenario.value = conversation?.characterScenario ?? '';
    }
    if (document.activeElement !== this.els.aiRules) {
      this.els.aiRules.value = conversation?.aiRules ?? '';
    }
  }

  setStorageNote(text) {
    this.els.storageNote.textContent = text ?? '';
  }

  /**
   * Quiet key/value list under About, for when the app misbehaves on a phone
   * with no console to open.
   * @param {Array<{label: string, value: string}>} rows
   */
  setDiagnostics(rows) {
    const nodes = [];
    for (const { label, value } of rows) {
      nodes.push(el('dt', 'diag__key', label), el('dd', 'diag__val', value));
    }
    this.els.diag.replaceChildren(...nodes);
  }

  /* -------------------------------------------------------------- toast */

  toast(text, duration = 2600) {
    const node = this.els.toast;
    node.textContent = text;
    node.classList.add('is-visible');
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => node.classList.remove('is-visible'), duration);
  }
}

export const ui = new UI();
