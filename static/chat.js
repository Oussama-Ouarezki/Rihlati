/*
 * The offer assistant — a small island of JavaScript, not a framework.
 *
 * The contract with the server is deliberately narrow:
 *   POST /api/chat/offers/<id>  { message, token }
 *   ->  { token, reply, related_offers: [...] }
 *
 * The browser holds the conversation token in memory only. It never sends the
 * transcript: history lives in `apps/chat/models.py` and is rebuilt server-side,
 * so a page cannot inject a fake assistant turn claiming a lower price.
 *
 * No CSRF token: this route has no cookie authority. The token is the only
 * credential, and it grants exactly one conversation about one offer.
 */
(() => {
  const root = document.querySelector("[data-chat]");
  if (!root) return;

  const url = root.dataset.chatUrl;
  const log = root.querySelector("[data-chat-log]");
  const form = root.querySelector("[data-chat-form]");
  const input = form.querySelector("textarea");
  const send = root.querySelector("[data-chat-send]");
  const errorBox = root.querySelector("[data-chat-error]");
  const templates = {
    user: root.querySelector("[data-chat-bubble-user]"),
    bot: root.querySelector("[data-chat-bubble-bot]"),
    card: root.querySelector("[data-chat-offer-card]"),
  };

  const messages = {
    generic: root.dataset.chatErrorGeneric,
    rate: root.dataset.chatErrorRate,
    network: root.dataset.chatErrorNetwork,
    expired: root.dataset.chatErrorExpired,
    done: root.dataset.chatErrorDone,
  };

  const money = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

  // The token follows the traveler from the offer-page widget to the dedicated
  // page. `sessionStorage`, not the URL: a token in a URL ends up in history,
  // in a referrer header, and in whatever the traveler pastes into a chat with
  // a friend. Keyed by offer so two tabs about two trips cannot swap identities.
  const storageKey = root.dataset.chatOfferId
    ? `rihlati-chat:${root.dataset.chatOfferId}`
    : null;

  function readToken() {
    if (!storageKey) return null;
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null; // private mode, storage disabled — the chat still works
    }
  }

  function rememberToken(value) {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, value);
    } catch {
      // Same as above: losing continuity is better than breaking the page.
    }
  }

  function forgetToken() {
    if (!storageKey) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Nothing to do.
    }
  }

  let token = readToken();
  let pending = false;

  function bubble(kind, text) {
    const node = templates[kind].content.firstElementChild.cloneNode(true);
    node.textContent = text;
    log.append(node);
    node.scrollIntoView({ block: "nearest" });
    return node;
  }

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
    form.setAttribute("aria-busy", value ? "true" : "false");
  }

  function addOfferCards(offers) {
    (offers || []).forEach((offer) => {
      const card = templates.card.content.firstElementChild.cloneNode(true);
      card.href = offer.url;
      card.querySelector("[data-card-title]").textContent = offer.title;
      card.querySelector("[data-card-price]").textContent =
        `${money.format(Math.round(offer.price_centimes / 100))} DZD`;
      log.append(card);
    });
  }

  async function ask(raw) {
    const text = raw.trim();
    if (!text || pending) return;

    clearError();
    bubble("user", text);
    const typing = bubble("bot", "…");
    input.value = "";
    setPending(true);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, token }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        typing.remove();
        if (response.status === 404) {
          // The token expired or belonged to another conversation. Drop it so
          // the next question starts cleanly instead of failing forever.
          token = null;
          forgetToken();
          showError(messages.expired);
        } else if (response.status === 409) {
          showError(messages.done);
        } else {
          showError(data.code === "RATE_LIMITED" ? messages.rate : messages.generic);
        }
        return;
      }

      token = data.token;
      rememberToken(token);
      typing.textContent = data.reply;
      addOfferCards(data.related_offers);
      typing.scrollIntoView({ block: "nearest" });
    } catch {
      typing.remove();
      showError(messages.network);
    } finally {
      setPending(false);
      input.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });

  // Enter sends, Shift+Enter is a new line. A textarea that swallows Enter is
  // the single most common complaint about chat widgets built in a hurry.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask(input.value);
    }
  });

  root.querySelectorAll("[data-chat-ask]").forEach((button) => {
    button.addEventListener("click", () => ask(button.dataset.chatAsk));
  });
})();
