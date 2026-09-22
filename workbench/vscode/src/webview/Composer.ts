/** Anchored composer: textarea + Send/Interrupt, Enter to send, draft autosave. */
export interface ComposerCallbacks {
  onSend: (text: string) => void;
  onCancel: () => void;
  onDraft: (text: string) => void;
}

export function mountComposer(root: HTMLElement, callbacks: ComposerCallbacks, initialDraft: string): void {
  root.innerHTML = ""
    + `<div class="wb-context" id="wb-context" hidden></div>`
    + `<textarea id="wb-input" rows="3" placeholder="Message Codex… (Enter to send, Shift+Enter for newline)"></textarea>`
    + `<div class="wb-composer-row"><button id="wb-send">Send</button>`
    + `<button id="wb-stop">Interrupt</button></div>`;
  const input = root.querySelector<HTMLTextAreaElement>("#wb-input");
  if (input === null) {
    return;
  }
  input.value = initialDraft;
  let draftTimer: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(draftTimer);
    const value = input.value;
    draftTimer = window.setTimeout(() => callbacks.onDraft(value), 500);
  });
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const text = input.value.trim();
      if (text !== "") {
        input.value = "";
        callbacks.onSend(text);
      }
    }
  });
  root.querySelector("#wb-send")?.addEventListener("click", () => {
    const text = input.value.trim();
    if (text !== "") {
      input.value = "";
      callbacks.onSend(text);
    }
  });
  root.querySelector("#wb-stop")?.addEventListener("click", () => callbacks.onCancel());
}

export function setComposerContext(root: HTMLElement, mentions: string[]): void {
  const context = root.querySelector("#wb-context");
  if (context === null) {
    return;
  }
  if (mentions.length === 0) {
    context.setAttribute("hidden", "");
    context.innerHTML = "";
    return;
  }
  context.removeAttribute("hidden");
  context.textContent = `Context: ${mentions.join(", ")}`;
}
