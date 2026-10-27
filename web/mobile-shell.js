(() => {
  const narrow = matchMedia("(max-width: 1023px)");
  const landscape = matchMedia("(orientation: landscape)");
  const touch = matchMedia("(hover: none) and (pointer: coarse)");
  const composerSelector = "[data-composer-input]";
  const editableSelector = 'input, textarea, select, [contenteditable="true"]';
  // MenuSurface marks every portaled menu. A menu that owns a text field
  // focuses it while opening, which is not a tap on that field.
  const menuSurfaceSelector = "[data-menu-material]";
  const menuSeatSelector = '[role="menuitemradio"]:not([disabled]), [role="menuitem"]:not([disabled])';
  // Chat marks its transcript scrollport and whether it still follows the tail.
  const transcriptSelector = "[data-conversation-scroll]";
  const tailSelector = "[data-chat-following-tail]";
  // iOS 16 rotates a web app to the device orientation only after showing it in
  // the orientation of the app it came from; cover that transient frame. The
  // cover is a safety valve as well, so it cannot strand a landscape interface.
  const settlingMs = 6_000;
  const tapWindowMs = 1_000;
  let frame;
  let backdrop;
  let inputFocus;
  let inputObserver;
  let pendingSend;
  let restoreFocus;
  let composing = false;
  let composingUntil = 0;
  let settlingTimer;
  let settlingFollow = false;
  let pointerTarget;
  let pointerAt = 0;

  const settlingCover = document.createElement("div");
  settlingCover.className = "dsh-ios-settling-cover";
  settlingCover.setAttribute("aria-hidden", "true");
  settlingCover.hidden = true;
  document.body.appendChild(settlingCover);

  function transcriptFollowing() {
    return document.querySelector(tailSelector) !== null;
  }
  function pinTranscript() {
    const scroller = document.querySelector(transcriptSelector);
    if (scroller === null) return;
    scroller.scrollTop = scroller.scrollHeight;
  }
  function coverSettling() {
    if (!touch.matches || settlingTimer !== undefined || !landscape.matches) return;
    settlingFollow = transcriptFollowing();
    settlingCover.hidden = false;
    settlingTimer = setTimeout(revealSettling, settlingMs);
  }
  function revealSettling() {
    if (settlingTimer !== undefined) clearTimeout(settlingTimer);
    settlingTimer = undefined;
    settlingCover.hidden = true;
    if (!settlingFollow) return;
    settlingFollow = false;
    // The covered frame may have re-anchored the transcript to an older
    // message; iOS reports several intermediate viewport sizes while rotating.
    pinTranscript();
    setTimeout(pinTranscript, 250);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") coverSettling();
    else revealSettling();
  });
  landscape.addEventListener("change", () => {
    // Covering from this listener runs before the landscape frame paints, so
    // the interface DSH was launched into is never drawn.
    if (landscape.matches) {
      coverSettling();
      // A rotation re-anchors the transcript the same way a launch transient
      // does; iOS reports several intermediate viewport sizes before settling.
      if (transcriptFollowing()) {
        setTimeout(pinTranscript, 350);
        setTimeout(pinTranscript, 900);
      }
      return;
    }
    revealSettling();
  });

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
  // iOS raises the keyboard for any focus that follows a tap, so the search
  // field a menu focuses while opening would cover the list it just opened.
  // Move that indirect focus onto a seat inside the same menu; tapping the
  // field itself still types.
  document.addEventListener("pointerdown", event => {
    pointerTarget = event.target instanceof Element ? event.target : undefined;
    pointerAt = Date.now();
  }, true);
  document.addEventListener("focusin", event => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) return;
    if (!touch.matches) return;
    const surface = field.closest(menuSurfaceSelector);
    if (surface === null) return;
    const tappedField = pointerTarget !== undefined && Date.now() - pointerAt < tapWindowMs
      && (pointerTarget === field || field.contains(pointerTarget));
    if (tappedField) return;
    // The value in use is where the menu's own keyboard navigation starts.
    const seat = surface.querySelector('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ?? surface.querySelector(menuSeatSelector);
    if (seat !== null) {
      seat.focus({ preventScroll: true });
      return;
    }
    surface.setAttribute("tabindex", "-1");
    surface.focus({ preventScroll: true });
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
    // The boot card is a neutral loading surface; only the application that
    // replaces it is covered, so a cold launch keeps its loading progress.
    coverSettling();
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
