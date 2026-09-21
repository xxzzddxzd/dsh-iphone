(() => {
  const narrow = matchMedia("(max-width: 1023px)");
  let frame;
  let backdrop;
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
