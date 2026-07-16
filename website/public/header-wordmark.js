(() => {
  const root = document.documentElement;
  const title = document.querySelector(".site-title > span[translate='no']");

  if (!title || title.classList.contains("scroll-wordmark")) return;

  const fullText = title.textContent?.trim() || "Irminsul Docs";
  const fullLabel = document.createElement("span");
  const shortLabel = document.createElement("span");

  fullLabel.className = "wordmark-label wordmark-label--full";
  fullLabel.textContent = fullText;
  shortLabel.className = "wordmark-label wordmark-label--short";
  shortLabel.textContent = "ID";
  shortLabel.setAttribute("aria-hidden", "true");

  title.textContent = "";
  title.classList.add("scroll-wordmark");
  title.append(fullLabel, shortLabel);

  const measureLabels = () => {
    title.style.setProperty(
      "--wordmark-expanded-width",
      `${Math.ceil(fullLabel.getBoundingClientRect().width)}px`
    );
    title.style.setProperty(
      "--wordmark-collapsed-width",
      `${Math.ceil(shortLabel.getBoundingClientRect().width)}px`
    );
  };

  if (document.fonts?.ready) {
    document.fonts.ready.then(measureLabels);
  } else {
    measureLabels();
  }

  let previousY = Math.max(0, window.scrollY);
  let downwardTravel = 0;
  let upwardTravel = 0;
  let scheduled = false;

  const setCollapsed = (collapsed) => {
    root.toggleAttribute("data-wordmark-collapsed", collapsed);
  };

  const update = () => {
    scheduled = false;

    const currentY = Math.max(0, window.scrollY);
    const delta = currentY - previousY;

    if (currentY <= 24) {
      downwardTravel = 0;
      upwardTravel = 0;
      setCollapsed(false);
    } else if (delta > 0) {
      downwardTravel += delta;
      upwardTravel = 0;

      if (downwardTravel >= 12) setCollapsed(true);
    } else if (delta < 0) {
      upwardTravel += -delta;
      downwardTravel = 0;

      if (upwardTravel >= 8) setCollapsed(false);
    }

    previousY = currentY;
  };

  const onScroll = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(update);
  };

  setCollapsed(previousY > 48);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", measureLabels);
})();
