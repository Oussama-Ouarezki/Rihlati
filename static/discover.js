/*
 * The discovery chat — a small island of JavaScript, like static/chat.js.
 *
 * The server owns the search: the browser sends a sentence, and gets back a
 * reply plus cards whose prices came from the database. Nothing here ranks,
 * filters or invents an offer. The session cookie carries the parsed intent
 * between messages so "cheaper" refines the previous search.
 */
(() => {
  const root = document.querySelector("[data-discover]");
  if (!root) return;

  const url = root.dataset.discoverUrl;
  const form = root.querySelector("[data-discover-form]");
  const input = root.querySelector("[data-discover-input]");
  const send = root.querySelector("[data-discover-send]");
  const log = root.querySelector("[data-discover-log]");
  const chat = root.querySelector("[data-discover-chat]");
  const intro = root.querySelector("[data-discover-intro]");
  const empty = root.querySelector("[data-discover-empty]");
  const errorBox = root.querySelector("[data-discover-error]");
  const status = root.querySelector("[data-discover-status]");
  const summary = root.querySelector("[data-discover-summary]");
  const resetButton = root.querySelector("[data-discover-reset]");
  const suggestionBox = root.querySelector("[data-discover-suggestions]");
  const templates = {
    user: root.querySelector("[data-discover-bubble-user]"),
    bot: root.querySelector("[data-discover-bubble-bot]"),
    card: root.querySelector("[data-discover-card]"),
    chip: root.querySelector("[data-discover-chip]"),
  };

  const starterSuggestions = Array.from(
    suggestionBox.querySelectorAll("[data-discover-suggestion]"),
    (chip) => chip.dataset.discoverSuggestion,
  );
  const money = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  let pending = false;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  function setPending(value) {
    pending = value;
    input.disabled = value;
    send.disabled = value;
    resetButton.disabled = value;
    send.textContent = value ? "…" : "Ask";
  }

  function setState(state) {
    root.dataset.state = state;
    const inChat = state === "chat";
    intro.classList.toggle("hidden", inChat);
    empty.classList.toggle("hidden", inChat);
    chat.classList.toggle("hidden", !inChat);
  }

  function scrollLog() {
    log.scrollTop = log.scrollHeight;
  }

  function bubble(kind, text) {
    const node = templates[kind].content.firstElementChild.cloneNode(true);
    if (kind === "user") {
      node.textContent = text;
    } else {
      node.querySelector("[data-bot-text]").textContent = text;
    }
    log.append(node);
    scrollLog();
    return node;
  }

  function card(offer) {
    const node = templates.card.content.firstElementChild.cloneNode(true);
    node.href = offer.url;
    node.querySelector("[data-card-kind]").textContent = offer.kind;
    node.querySelector("[data-card-title]").textContent = offer.title;
    const meta = [offer.destination, date.format(new Date(offer.departure_date))]
      .filter(Boolean)
      .join(" · ");
    node.querySelector("[data-card-meta]").textContent = meta;
    node.querySelector("[data-card-price]").textContent =
      `${money.format(offer.price_dzd)} DZD`;
    node.querySelector("[data-card-agency]").textContent = offer.agency;

    const image = node.querySelector("[data-card-image]");
    if (offer.cover_image_url) {
      image.addEventListener("error", () => {
        image.hidden = true;
      });
      image.src = offer.cover_image_url;
      image.alt = offer.title;
      image.hidden = false;
    }
    return node;
  }

  function renderOffers(container, offers) {
    if (!offers || offers.length === 0) {
      container.remove();
      return;
    }
    offers.slice(0, 4).forEach((offer) => container.append(card(offer)));
  }

  function renderMore(container, data) {
    const more = container.querySelector("[data-bot-more]");
    const total = Number(data.total || 0);
    if (total <= 4 || !data.search_url) {
      more.remove();
      return;
    }
    more.href = data.search_url;
    more.textContent = `See all ${total} trips →`;
    more.classList.remove("hidden");
  }

  function renderSuggestions(suggestions) {
    if (!suggestions || suggestions.length === 0) return;
    suggestionBox.replaceChildren();
    suggestions.forEach((text) => {
      const chip = templates.chip.content.firstElementChild.cloneNode(true);
      chip.textContent = text;
      chip.dataset.discoverSuggestion = text;
      chip.addEventListener("click", () => ask(text));
      suggestionBox.append(chip);
    });
  }

  function resetConversation() {
    log.replaceChildren();
    summary.textContent = "";
    status.textContent = "";
    root.dataset.state = "empty";
    intro.classList.remove("hidden");
    empty.classList.remove("hidden");
    chat.classList.add("hidden");
    input.value = "";
    clearError();
    renderSuggestions(starterSuggestions);
    input.focus();
  }

  async function reset() {
    if (pending) return;
    resetConversation();
    setPending(true);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "new search", reset: true }),
      });
    } catch {
      // The local state is already clear. If the session reset failed, the
      // next message still starts from an empty intent server-side once the
      // page is reloaded, and no stale result is shown here.
    } finally {
      setPending(false);
      input.focus();
    }
  }

  async function ask(raw) {
    const text = raw.trim();
    if (!text || pending) return;

    clearError();
    setState("chat");
    input.value = "";
    status.textContent = "Searching…";
    bubble("user", text);
    const typing = bubble("bot", "…");
    setPending(true);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, reset: false }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        typing.remove();
        status.textContent = "";
        showError(
          data.code === "RATE_LIMITED"
            ? "Too many questions. Try again in a little while."
            : "The search is unavailable right now. Try again.",
        );
        return;
      }

      typing.querySelector("[data-bot-text]").textContent = data.reply;
      summary.textContent = data.summary || "";
      renderOffers(typing.querySelector("[data-bot-offers]"), data.offers);
      renderMore(typing, data);
      renderSuggestions(data.suggestions);
      status.textContent = data.reply;
      scrollLog();
    } catch {
      typing.remove();
      status.textContent = "";
      showError("Connection failed. Check your network and try again.");
    } finally {
      setPending(false);
      input.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });

  resetButton.addEventListener("click", reset);

  root.querySelectorAll("[data-discover-suggestion]").forEach((chip) => {
    chip.addEventListener("click", () => ask(chip.dataset.discoverSuggestion));
  });

  if (root.dataset.initialQuery) {
    ask(root.dataset.initialQuery);
  }
})();
