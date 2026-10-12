(() => {
  const narrow = matchMedia("(max-width: 1023px)");
  let frame;
  let backdrop;
  let inputFocus;
  let inputObserver;
  let pendingSend;
  let restoreFocus;
  let composing = false;
  let composingUntil = 0;
  const composerSelector = "[data-composer-input]";
  const editableSelector = 'input, textarea, select, [contenteditable="true"]';

  function restoreInputViewport(snapshot) {
    restoreFocus = snapshot;
    const restore = () => {
      if (restoreFocus !== snapshot || document.activeElement?.matches(editableSelector)) return;
      window.scrollTo(snapshot.x, snapshot.y);
    };
    requestAnimationFrame(restore);
    // The final keyboard animation may finish after focusout and the first frame.
    setTimeout(() => {
      restore();
      if (restoreFocus === snapshot) restoreFocus = undefined;
    }, 450);
  }
  window.visualViewport?.addEventListener("resize", () => {
    if (restoreFocus && !document.activeElement?.matches(editableSelector)) {
      window.scrollTo(restoreFocus.x, restoreFocus.y);
    }
  });
  function finishSend() {
    const editor = pendingSend;
    if (!editor || editor.getAttribute("data-phase") !== "plain" || editor.textContent.trim() !== "") return;
    pendingSend = undefined;
    if (document.activeElement === editor) editor.blur();
    if (inputFocus?.editor === editor) restoreInputViewport(inputFocus);
  }
  function rememberInput(editor) {
    restoreFocus = undefined;
    if (inputFocus?.editor === editor && document.activeElement === editor) return;
    inputObserver?.disconnect();
    pendingSend = undefined;
    inputFocus = { editor, x: window.scrollX, y: window.scrollY };
    inputObserver = new MutationObserver(finishSend);
    inputObserver.observe(editor, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-phase"] });
  }
  function prepareSend(editor) {
    if (!narrow.matches || composing || Date.now() < composingUntil || !editor?.textContent.trim()) return;
    pendingSend = editor;
    requestAnimationFrame(finishSend);
  }
  document.addEventListener("pointerdown", event => {
    if (!narrow.matches || !(event.target instanceof Element)) return;
    const editor = event.target.closest(composerSelector);
    if (editor) rememberInput(editor);
  }, true);
  document.addEventListener("focusin", event => {
    restoreFocus = undefined;
    if (narrow.matches && event.target.matches?.(composerSelector)) rememberInput(event.target);
  });
  document.addEventListener("focusout", event => {
    if (narrow.matches && inputFocus?.editor === event.target) restoreInputViewport(inputFocus);
  });
  document.addEventListener("compositionstart", () => { composing = true; pendingSend = undefined; }, true);
  document.addEventListener("compositionend", () => { composing = false; composingUntil = Date.now() + 10; }, true);
  document.addEventListener("input", () => { pendingSend = undefined; }, true);
  document.addEventListener("keydown", event => {
    if (!event.target.matches?.(composerSelector)) return;
    pendingSend = undefined;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) prepareSend(event.target);
  }, true);
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (button && !button.disabled) prepareSend(button.closest("[data-composer-card]")?.querySelector(composerSelector));
  }, true);
  function muteNativeHints(root) {
    if (!(root instanceof Element)) return;
    const elements = [...root.querySelectorAll("[title]")];
    if (root.hasAttribute("title")) elements.unshift(root);
    for (const element of elements) {
      const label = element.getAttribute("title");
      if (label && element.matches('button, input, select, textarea, a[href], [role="button"]') &&
          !element.hasAttribute("aria-label") && !element.hasAttribute("aria-labelledby") && !element.textContent.trim()) {
        element.setAttribute("aria-label", label);
      }
      element.removeAttribute("title");
    }
  }
  function close() {
    if (!frame || frame.hasAttribute("data-sidebar-collapsed")) return;
    const toggle = frame.querySelector(".hHd-Xa_toggle");
    toggle?.click();
    toggle?.focus();
  }
  function update() {
    if (!frame) return;
    const width = parseFloat(frame.style.gridTemplateColumns);
    if (!frame.hasAttribute("data-sidebar-collapsed") && width >= 264) {
      const next = `${width}px`;
      if (frame.style.getPropertyValue("--dsh-ios-drawer-width") !== next) frame.style.setProperty("--dsh-ios-drawer-width", next);
    }
    backdrop.hidden = !narrow.matches || frame.hasAttribute("data-sidebar-collapsed");
  }
  function attach() {
    const next = document.querySelector(".pI_x6G_frame");
    if (!next || next === frame) return;
    frame = next;
    frame.setAttribute("data-dsh-ios-shell", "");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "dsh-ios-sidebar-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("click", close);
      document.body.appendChild(backdrop);
    }
    new MutationObserver(update).observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "style"] });
    update();
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") muteNativeHints(record.target);
      else for (const node of record.addedNodes) muteNativeHints(node);
    }
    attach();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  narrow.addEventListener("change", update);
  document.addEventListener("keydown", event => { if (narrow.matches && event.key === "Escape") close(); });
  muteNativeHints(document.documentElement);
  attach();
})();
