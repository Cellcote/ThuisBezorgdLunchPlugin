(function () {
  "use strict";

  // ThuisBezorgd Lunch Filter
  //
  // The restaurant list UI is lazy-loaded, split into chunks by ad banners and
  // ordered by "best match", so hiding native cards is fragile. Instead we read
  // the full restaurant dataset from __NEXT_DATA__, filter it ourselves and
  // render our own list (sorted by distance) in place of the native lists.
  //
  // v3: colleagues' orders of today (via the LunchOrders API workflows, called
  // by background.js) are shown per restaurant, and orders are shared from the
  // order-tracking page after checkout.

  const CONFIG = {
    maxDistanceMeters: 1500,
    lunchStartHour: 12,
    lunchEndHour: 14,
    ordersPollMs: 60 * 1000,
    autoShareWindowMs: 2 * 60 * 60 * 1000, // menu visit → order page within 2h
    debugLog: true,
  };

  const PANEL_ID = "tbf-lunch-panel";
  const BAR_ID = "tbf-colleagues-bar";
  const HIDE = "tbf-hide";

  // Both switches are persisted in chrome.storage.local (tbfLunchFilter,
  // tbfColleagues), so they survive reloads, restarts and the next day.
  let filterEnabled = false;
  let colleaguesEnabled = true;
  let dataCache = { url: null, restaurants: null, promise: null };
  let renderedKey = null;
  let authState = { signedIn: false, person: null };
  let ordersState = { bySlug: {}, restaurants: [], error: null, needsSignIn: false };
  let ordersTimer = null;

  function log(...args) {
    if (CONFIG.debugLog) console.log("[TBF-LunchFilter]", ...args);
  }

  log("Plugin loaded on", location.href);

  // ── Background messaging ──────────────────────────────────────────
  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) }); // extension reloaded: context invalidated
      }
    });
  }

  async function refreshAuth() {
    const r = await send("auth:status");
    authState = { signedIn: !!r.signedIn, person: r.person || null };
    updateAuthUi();
    return authState;
  }

  async function signIn() {
    const r = await send("auth:signIn");
    if (r.signedIn) {
      authState = { signedIn: true, person: r.person };
      updateAuthUi();
      await refreshOrders(true);
      return true;
    }
    toast(`Inloggen mislukt: ${r.error || "onbekende fout"}`);
    return false;
  }

  // ── Restaurant data ───────────────────────────────────────────────
  function extractRestaurants(nextData) {
    return nextData?.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData || {};
  }

  function readNextData() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      return el ? JSON.parse(el.textContent) : null;
    } catch (e) {
      log("Failed to parse inline __NEXT_DATA__:", e);
      return null;
    }
  }

  async function fetchData(url) {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`no __NEXT_DATA__ in response (status ${res.status})`);
    return extractRestaurants(JSON.parse(m[1]));
  }

  // The inline __NEXT_DATA__ is only valid for the URL the page was loaded on;
  // after client-side navigation (filters, pickup/delivery, address) re-fetch.
  const initialUrl = location.href;

  function getRestaurants() {
    const url = location.href;
    if (dataCache.url === url && dataCache.restaurants) return Promise.resolve(dataCache.restaurants);
    if (dataCache.url === url && dataCache.promise) return dataCache.promise;

    dataCache = { url, restaurants: null, promise: null };
    const inline = url === initialUrl ? extractRestaurants(readNextData()) : {};
    const p =
      Object.keys(inline).length > 0
        ? Promise.resolve(inline)
        : fetchData(url).catch((e) => {
            log("Fetch failed, falling back to inline data:", e);
            return extractRestaurants(readNextData());
          });

    dataCache.promise = p.then((r) => {
      if (dataCache.url === url) dataCache.restaurants = r;
      return r;
    });
    return dataCache.promise;
  }

  // ── Filter logic ──────────────────────────────────────────────────
  function isPickup() {
    return new URLSearchParams(location.search).get("shipping") === "pickup";
  }

  function availabilityFor(restaurant) {
    const a = restaurant.availability || {};
    return isPickup() ? a.collection : a.delivery;
  }

  function isToday(d) {
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  // Accepts orders now or via preorder, and isn't temporarily offline
  function acceptsOrders(av) {
    if (!av || av.isTemporarilyOffline) return false;
    return !!(av.isOpen || av.canPreOrder);
  }

  // Will this restaurant be open during lunch (12:00–14:00)?
  function isOpenDuringLunch(av) {
    if (!av) return false;
    if (av.isOpen) return true;
    if (av.canPreOrder && av.nextAvailability?.from) {
      const d = new Date(av.nextAvailability.from);
      if (!isNaN(d) && isToday(d) && d.getHours() + d.getMinutes() / 60 < CONFIG.lunchEndHour) return true;
    }
    return false;
  }

  function evaluate(restaurant) {
    const av = availabilityFor(restaurant);
    const distance = restaurant.driveDistanceMeters ?? Infinity;
    const reasons = [];
    if (distance > CONFIG.maxDistanceMeters) reasons.push(`distance=${distance}m`);
    if (!acceptsOrders(av)) reasons.push("not orderable");
    if (!isOpenDuringLunch(av)) reasons.push(`not open ${CONFIG.lunchStartHour}-${CONFIG.lunchEndHour}`);
    return { show: reasons.length === 0, reasons, distance };
  }

  function selectMatches(restaurants) {
    const matches = [];
    for (const r of Object.values(restaurants)) {
      if (!r?.uniqueName) continue;
      const v = evaluate(r);
      if (v.show) matches.push(r);
      else if (v.distance <= CONFIG.maxDistanceMeters) log(`HIDE: "${r.name}" (${v.reasons.join(", ")})`);
    }
    matches.sort((a, b) => (a.driveDistanceMeters ?? Infinity) - (b.driveDistanceMeters ?? Infinity));
    return matches;
  }

  // ── Rendering helpers ─────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function formatDistance(m) {
    if (m == null) return "";
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  }

  function headerImage(r) {
    const tpl = r.partnerHeaderInfo?.headerImages?.[0]?.urlTemplate || r.bannerUrl;
    return tpl ? tpl.replace("{transformations}", "c_thumb,h_144,w_287/f_auto/q_auto:eco") : "";
  }

  function menuHref(slug) {
    const shipping = new URLSearchParams(location.search).get("shipping");
    return `/menu/${encodeURIComponent(slug)}${shipping ? `?shipping=${encodeURIComponent(shipping)}` : ""}`;
  }

  function cardHtml(r) {
    const img = headerImage(r);
    const rating = r.rating?.starRating
      ? `<span>★ ${String(r.rating.starRating).replace(".", ",")} (${r.rating.count ?? 0})</span>`
      : "";
    const cuisines = (r.cuisines || []).slice(0, 2).map((c) => c.name).join(", ");
    return `
      <div class="tbf-card" data-tbf-slug="${esc(r.uniqueName)}" data-tbf-name="${esc(r.name)}">
        <a class="tbf-card-link" href="${esc(menuHref(r.uniqueName))}">
          <div class="tbf-card-img" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>
            ${r.logoUrl ? `<img class="tbf-card-logo" src="${esc(r.logoUrl)}" alt="" loading="lazy">` : ""}
          </div>
          <div class="tbf-card-name">${esc(r.name)}</div>
          <div class="tbf-card-meta">
            ${rating}
            <span>${esc(formatDistance(r.driveDistanceMeters))}</span>
            ${cuisines ? `<span>${esc(cuisines)}</span>` : ""}
          </div>
        </a>
        <span class="tbf-badge tbf-hide" tabindex="0"></span>
      </div>`;
  }

  // ── Colleague orders ──────────────────────────────────────────────
  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(d);
  }

  // One line per person with the planned pickup time ("Sanne de Vries @ 12:30"),
  // earliest pickup first
  function namesTooltip(group) {
    const first = {};
    (group.orders || []).forEach((o) => {
      const at = o.pickupAt || o.orderedAt;
      const t = Date.parse(at);
      if (!isNaN(t) && (!(o.person in first) || t < first[o.person])) first[o.person] = t;
    });
    return group.people
      .map((p) => ({ p, t: first[p] ?? Infinity }))
      .sort((a, b) => a.t - b.t)
      .map(({ p, t }) => (isFinite(t) ? `${p} @ ${formatTime(t)}` : p))
      .join("\n");
  }

  async function refreshOrders(force) {
    const r = await send("orders:get", { force: !!force });
    if (r.ok) {
      const list = Array.isArray(r.data?.restaurants) ? r.data.restaurants : [];
      const bySlug = {};
      list.forEach((g) => (bySlug[g.restaurantSlug] = g));
      ordersState = { bySlug, restaurants: list, error: null, needsSignIn: false };
      if (r.person && r.person !== authState.person) {
        authState = { signedIn: true, person: r.person };
        updateAuthUi();
      }
    } else {
      ordersState = { ...ordersState, error: r.needsSignIn ? null : r.error, needsSignIn: !!r.needsSignIn };
      if (r.needsSignIn && authState.signedIn) {
        authState = { signedIn: false, person: null };
        updateAuthUi();
      }
      if (r.error) log("Orders unavailable:", r.error);
    }
    updateOrderUi();
  }

  // Poll only while the "Collega's" switch is on
  function syncOrdersPolling() {
    if (!colleaguesEnabled) {
      clearInterval(ordersTimer);
      ordersTimer = null;
      return;
    }
    if (ordersTimer || !document.querySelector('[data-qa^="list-"]')) return;
    refreshOrders(false);
    ordersTimer = setInterval(() => {
      if (colleaguesEnabled && document.visibilityState === "visible") refreshOrders(false);
    }, CONFIG.ordersPollMs);
  }

  // Badge element: create once per host, only touch the DOM when something
  // changed (the MutationObserver re-runs this on every change).
  function setBadge(badge, group) {
    const show = colleaguesEnabled && group && group.people.length;
    if (!show) {
      if (!badge.classList.contains(HIDE)) badge.classList.add(HIDE);
      return;
    }
    const text = `👥 ${group.people.length}`;
    const names = namesTooltip(group);
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.dataset.tbfNames !== names) {
      badge.dataset.tbfNames = names;
      badge.setAttribute("aria-label", `Besteld door: ${names.replace(/\n/g, ", ")}`);
    }
    if (badge.classList.contains(HIDE)) badge.classList.remove(HIDE);
  }

  function colleaguesSummaryHtml() {
    if (ordersState.needsSignIn || !authState.signedIn) {
      return `<span>Zie waar collega's bestellen:</span> <button type="button" class="tbf-link-btn" data-tbf-action="signin">Inloggen bij UiPath</button>`;
    }
    if (ordersState.error) {
      return `<span>Collega-bestellingen niet beschikbaar (${esc(ordersState.error).slice(0, 80)})</span>`;
    }
    if (!ordersState.restaurants.length) return `<span>Nog geen collega's die vandaag besteld hebben.</span>`;
    return (
      `<span>Collega's vandaag:</span> ` +
      ordersState.restaurants
        .map(
          (g) =>
            `<a class="tbf-chip" href="${esc(menuHref(g.restaurantSlug))}" data-tbf-names="${esc(namesTooltip(g))}">${esc(g.restaurantName)} <b>${g.people.length}</b></a>`
        )
        .join("")
    );
  }

  function setSummary(el) {
    const html = colleaguesEnabled ? colleaguesSummaryHtml() : "";
    if (el._tbfHtml !== html) {
      el._tbfHtml = html;
      el.innerHTML = html;
    }
  }

  // Native Thuisbezorgd cards (Lunch Filter off): badge on the header image
  function nativeCardSlug(card) {
    const qa = card.querySelector('a[data-qa$="-link"]')?.getAttribute("data-qa") || "";
    const m = qa.match(/^(?:restaurant-card|carousel-card)-(.+)-link$/);
    return m ? m[1] : null;
  }

  function decorateNativeCards() {
    document.querySelectorAll('[data-qa="restaurant-card"]').forEach((card) => {
      if (card.closest("#" + PANEL_ID)) return;
      const host = card.querySelector('[data-qa="restaurant-header-image"]')?.parentElement;
      if (!host) return;
      let badge = host.querySelector(":scope > .tbf-badge");
      const group = ordersState.bySlug[nativeCardSlug(card)];
      if (!badge) {
        if (!colleaguesEnabled || !group) return;
        host.classList.add("tbf-badge-host");
        badge = document.createElement("span");
        badge.className = `tbf-badge ${HIDE}`;
        badge.tabIndex = 0;
        host.appendChild(badge);
      }
      setBadge(badge, group);
    });
  }

  // "Collega's vandaag" bar above the native list (Lunch Filter off)
  function syncColleaguesBar() {
    let bar = document.getElementById(BAR_ID);
    const want = colleaguesEnabled && !filterEnabled;
    if (!want) {
      bar?.remove();
      return;
    }
    // Right below the cuisine icons; fall back to just above the restaurant list
    const cuisine = document.querySelector('[data-qa="cuisine-filter"]');
    const list = document.querySelector('[data-qa^="list-"]');
    if (!cuisine && !list) return;
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.className = "tbf-colleagues";
      bar.addEventListener("click", onPanelClick);
      if (cuisine) cuisine.after(bar);
      else list.parentElement.insertBefore(bar, list);
    }
    setSummary(bar);
  }

  function updateOrderUi() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.querySelectorAll(".tbf-card").forEach((card) => {
        setBadge(card.querySelector(".tbf-badge"), ordersState.bySlug[card.dataset.tbfSlug]);
      });
      // Summary of where colleagues order today (also restaurants outside the filter)
      const summary = panel.querySelector(".tbf-colleagues");
      if (summary) setSummary(summary);
    }
    syncColleaguesBar();
    decorateNativeCards();
  }

  async function shareOrder(order, { quiet } = {}) {
    if (!authState.signedIn && !(await signIn())) return false;
    const r = await send("orders:post", { order });
    if (r.needsSignIn) {
      if (await signIn()) return shareOrder(order, { quiet });
      return false;
    }
    if (!r.ok) {
      toast(`Delen mislukt: ${r.error || r.status || "onbekende fout"}`);
      return false;
    }
    if (!quiet) {
      const at = order.pickupAt ? ` @ ${formatTime(order.pickupAt)}` : "";
      toast(`Gedeeld: je haalt op bij ${order.restaurantName || order.restaurantSlug}${at} ✓`);
    }
    await refreshOrders(true);
    return true;
  }

  // ── Panel ─────────────────────────────────────────────────────────
  function nativeListElements() {
    return document.querySelectorAll('[data-qa^="list-"]');
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.isConnected) return panel;

    const anchor = nativeListElements()[0];
    if (!anchor) return null;

    panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.addEventListener("click", onPanelClick);
    anchor.parentElement.insertBefore(panel, anchor);
    renderedKey = null;
    return panel;
  }

  function onPanelClick(e) {
    const signinBtn = e.target.closest('[data-tbf-action="signin"]');
    if (signinBtn) {
      e.preventDefault();
      signIn();
      return;
    }
  }

  // ── Pickup time ───────────────────────────────────────────────────
  function todayAt(hhmm) {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const d = new Date();
    d.setHours(+m[1], +m[2], 0, 0);
    return d;
  }

  // Order tracker: "Geschatte afhaaltijd: 42 minuten" or an explicit "12:30"
  function pickupFromTracker() {
    const el =
      document.querySelector('[data-qa="purchase-status-eta"]') ||
      document.querySelector('[data-qa="purchase-status-tracking-info"]');
    const text = (el?.textContent || "").toLowerCase();
    const clock = text.match(/\b(\d{1,2}):(\d{2})\b/);
    if (clock) return todayAt(`${clock[1]}:${clock[2]}`);
    const mins = text.match(/(\d+)\s*min/);
    if (mins) return new Date(Date.now() + +mins[1] * 60 * 1000);
    return null;
  }

  function setHidden(el, hidden) {
    if (hidden && !el.classList.contains(HIDE)) el.classList.add(HIDE, "tbf-native");
    else if (!hidden && el.classList.contains("tbf-native")) el.classList.remove(HIDE, "tbf-native");
  }

  function hideNative(matchSlugs) {
    // Native restaurant list sections (headers + content chunks).
    // Promo/sponsored banners are always hidden via styles.css.
    nativeListElements().forEach((el) => setHidden(el, true));

    // "Opnieuw bestellen" carousel: keep only restaurants that match
    document.querySelectorAll('[data-qa="reorder-card"]').forEach((card) => {
      const href = card.querySelector("a[href*='/menu/']")?.getAttribute("href") || "";
      const m = href.match(/\/menu\/([^?/]+)/);
      setHidden(card, !!m && !matchSlugs.has(m[1]));
    });
    document.querySelectorAll('[data-qa="carousel"]').forEach((carousel) => {
      const cards = carousel.querySelectorAll('[data-qa="reorder-card"]');
      if (cards.length === 0) {
        // Curated carousels ("Populaire merken", "De aanbiedingen van vandaag", …)
        setHidden(carousel, true);
        return;
      }
      const visible = Array.from(cards).some((c) => !c.classList.contains(HIDE));
      setHidden(carousel, !visible);
    });
  }

  function restoreNative() {
    document.querySelectorAll(".tbf-native").forEach((el) => el.classList.remove(HIDE, "tbf-native"));
    document.getElementById(PANEL_ID)?.remove();
    renderedKey = null;
  }

  async function applyFilters() {
    if (!filterEnabled) {
      restoreNative();
      updateOrderUi();
      log("Filter off, native list restored");
      return;
    }

    const panel = ensurePanel();
    if (!panel) {
      log("Native list not found yet");
      return;
    }

    const url = location.href;
    if (renderedKey !== url) {
      panel.innerHTML = `<div class="tbf-panel-header"><h2>Lunch filter</h2><span class="tbf-panel-sub">Laden…</span></div>`;
    }

    const restaurants = await getRestaurants();
    if (!filterEnabled || location.href !== url) return; // state changed while loading

    const matches = selectMatches(restaurants);
    hideNative(new Set(matches.map((r) => r.uniqueName)));

    if (renderedKey !== url || !panel.isConnected) {
      const mode = isPickup() ? "afhalen" : "bezorgen";
      panel.innerHTML = `
        <div class="tbf-panel-header">
          <h2>Lunch: ${matches.length} locaties</h2>
          <span class="tbf-panel-sub">&lt; ${formatDistance(CONFIG.maxDistanceMeters)} · open ${CONFIG.lunchStartHour}:00–${CONFIG.lunchEndHour}:00 · ${mode} · op afstand gesorteerd</span>
        </div>
        <div class="tbf-colleagues"></div>
        ${
          matches.length
            ? `<div class="tbf-grid">${matches.map(cardHtml).join("")}</div>`
            : `<p class="tbf-empty">Geen restaurants gevonden die aan het lunch filter voldoen.</p>`
        }`;
      renderedKey = url;
      log(`Rendered ${matches.length} of ${Object.keys(restaurants).length} restaurants`);
    }

    updateOrderUi();
  }

  // ── Sidebar toggle ────────────────────────────────────────────────
  function updateAuthUi() {
    const el = document.getElementById("tbf-auth-line");
    if (!el) return updateOrderUi();
    el.innerHTML = !colleaguesEnabled
      ? ""
      : authState.signedIn
      ? `Ingelogd als ${esc(authState.person)} · <button type="button" class="tbf-link-btn" data-tbf-action="signout">uitloggen</button>`
      : `<button type="button" class="tbf-link-btn" data-tbf-action="signin">Inloggen</button> om collega-bestellingen te zien`;
    updateOrderUi();
  }

  function switchHtml(id) {
    return `<label class="tbf-switch"><input type="checkbox" id="${id}" /><span class="tbf-slider"></span></label>`;
  }

  function injectToggle() {
    const existing = document.getElementById("tbf3-lunch-toggle");
    if (existing && existing.isConnected) {
      const cb = document.getElementById("tbf3-lunch-checkbox");
      if (cb && cb.checked !== filterEnabled) cb.checked = filterEnabled;
      const cc = document.getElementById("tbf3-colleagues-checkbox");
      if (cc && cc.checked !== colleaguesEnabled) cc.checked = colleaguesEnabled;
      return true;
    }
    document.getElementById("tbf3-colleagues-toggle")?.remove();

    const filterList = document.querySelector('ul[data-qa="filter"]');
    if (!filterList) return false;

    const items = filterList.querySelectorAll(":scope > li");
    let insertAfter = null;
    items.forEach((li) => {
      if (li.querySelector('[data-qa^="new-"]')) insertAfter = li;
    });
    if (!insertAfter && items.length) insertAfter = items[items.length - 1];

    const li = document.createElement("li");
    li.id = "tbf3-lunch-toggle";
    li.innerHTML = `
      <div class="tbf-toggle-row">
        <span class="tbf-toggle-label">Lunch Filter</span>
        ${switchHtml("tbf3-lunch-checkbox")}
      </div>
      <div class="tbf-toggle-desc">&lt; ${formatDistance(CONFIG.maxDistanceMeters)} · ${CONFIG.lunchStartHour}:00–${CONFIG.lunchEndHour}:00 · neemt bestellingen aan</div>
    `;

    const li2 = document.createElement("li");
    li2.id = "tbf3-colleagues-toggle";
    li2.innerHTML = `
      <div class="tbf-toggle-row">
        <span class="tbf-toggle-label">👥 Collega's</span>
        ${switchHtml("tbf3-colleagues-checkbox")}
      </div>
      <div class="tbf-toggle-desc">Zie waar collega's vandaag bestellen</div>
      <div class="tbf-toggle-desc" id="tbf-auth-line"></div>
    `;

    if (insertAfter) insertAfter.after(li);
    else filterList.prepend(li);
    li.after(li2);

    const cb = document.getElementById("tbf3-lunch-checkbox");
    cb.checked = filterEnabled;
    cb.addEventListener("change", function () {
      filterEnabled = this.checked;
      storageSet({ tbfLunchFilter: filterEnabled });
      log("Lunch filter", filterEnabled ? "ON" : "OFF");
      applyFilters();
    });

    const cc = document.getElementById("tbf3-colleagues-checkbox");
    cc.checked = colleaguesEnabled;
    cc.addEventListener("change", function () {
      colleaguesEnabled = this.checked;
      storageSet({ tbfColleagues: colleaguesEnabled });
      log("Colleagues", colleaguesEnabled ? "ON" : "OFF");
      syncOrdersPolling();
      updateAuthUi();
    });

    li2.addEventListener("click", async (e) => {
      const action = e.target.closest("[data-tbf-action]")?.dataset.tbfAction;
      if (action === "signin") signIn();
      if (action === "signout") {
        await send("auth:signOut");
        authState = { signedIn: false, person: null };
        ordersState = { bySlug: {}, restaurants: [], error: null, needsSignIn: true };
        updateAuthUi();
      }
    });

    updateAuthUi();
    log("Toggle injected");
    return true;
  }

  // ── Toast ─────────────────────────────────────────────────────────
  function toast(message, actions = []) {
    document.getElementById("tbf-toast")?.remove();
    const el = document.createElement("div");
    el.id = "tbf-toast";
    el.innerHTML = `<span>${esc(message)}</span>`;
    actions.forEach(({ label, onClick, primary }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = primary ? "tbf-toast-btn tbf-toast-primary" : "tbf-toast-btn";
      b.addEventListener("click", () => {
        el.remove();
        onClick?.();
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
    if (!actions.length) setTimeout(() => el.remove(), 5000);
  }

  // ── Order pages: remember menu visits, share from the order tracker ─
  async function storageGet(key, fallback) {
    try {
      const r = await chrome.storage.local.get(key);
      return r[key] ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function storageSet(obj) {
    try {
      await chrome.storage.local.set(obj);
    } catch {
      /* extension context gone */
    }
  }

  function trackMenuVisit() {
    const m = location.pathname.match(/^\/menu\/([^/?#]+)/);
    if (m) storageSet({ tbfLastMenu: { slug: decodeURIComponent(m[1]).toLowerCase(), at: Date.now() } });
  }

  function findRestaurantInfo(nextData) {
    let found = null;
    const walk = (o, depth) => {
      if (found || !o || typeof o !== "object" || depth > 14) return;
      if (o.restaurantInfo?.seoName) {
        found = o.restaurantInfo;
        return;
      }
      for (const k in o) walk(o[k], depth + 1);
    };
    walk(nextData, 0);
    return found;
  }

  function waitFor(selector, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  // Checkout → order tracker is usually a client-side navigation, so this runs
  // both on a full load and whenever the URL changes to a /foodtracker/ page.
  let trackerHandledPath = null;
  async function handleOrderTracker() {
    if (!location.pathname.startsWith("/foodtracker/") || trackerHandledPath === location.pathname) return;
    trackerHandledPath = location.pathname;

    const refEl = await waitFor('[data-qa="restaurant-info-order-reference-text"]');
    const nameEl = document.querySelector('[data-qa="restaurant-info-name"]');
    if (!refEl) {
      trackerHandledPath = null;
      return;
    }

    const orderReference = refEl.textContent.replace(/[#\s]/g, "");
    // After client-side navigation __NEXT_DATA__ still belongs to the first page
    // (e.g. a menu), so only trust it when it was rendered for the tracker.
    const nextData = readNextData();
    const info = String(nextData?.page || "").includes("foodtracker") ? findRestaurantInfo(nextData) : null;
    const lastMenu = await storageGet("tbfLastMenu", null);
    const restaurantSlug = (info?.seoName || lastMenu?.slug || "").toLowerCase();
    const restaurantName = info?.name || nameEl?.textContent.trim() || restaurantSlug;
    if (!orderReference || !restaurantSlug) return;

    const handled = await storageGet("tbfHandledOrders", {});
    if (handled[orderReference]) return;
    const markHandled = (state) =>
      storageSet({ tbfHandledOrders: { ...handled, [orderReference]: { state, at: Date.now() } } });

    const pickup = pickupFromTracker();
    const order = { restaurantSlug, restaurantName, orderReference, pickupAt: pickup ? pickup.toISOString() : undefined };
    const at = pickup ? ` (ophalen @ ${formatTime(pickup.toISOString())})` : "";
    await refreshAuth();

    // Fresh order: the menu of this restaurant was opened shortly before
    const fresh =
      lastMenu && lastMenu.slug === restaurantSlug && Date.now() - lastMenu.at < CONFIG.autoShareWindowMs;

    if (fresh && authState.signedIn) {
      if (await shareOrder(order, { quiet: true })) {
        markHandled("shared");
        toast(`Lunch filter: je bestelling bij ${restaurantName}${at} is gedeeld met collega's ✓`);
      }
      return;
    }

    toast(`Lunch filter: deze bestelling bij ${restaurantName}${at} delen met collega's?`, [
      {
        label: authState.signedIn ? "Delen" : "Inloggen en delen",
        primary: true,
        onClick: async () => {
          if (await shareOrder(order)) markHandled("shared");
        },
      },
      { label: "Nee", onClick: () => markHandled("dismissed") },
    ]);
  }

  // ── Keep in sync with React re-renders and client-side navigation ─
  function setupObserver() {
    let timer = null;
    let lastUrl = location.href;

    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        injectToggle();
        const urlChanged = location.href !== lastUrl;
        lastUrl = location.href;
        if (urlChanged) {
          trackMenuVisit();
          handleOrderTracker();
        }
        if (colleaguesEnabled) {
          syncOrdersPolling();
          if (urlChanged) refreshOrders(false);
          syncColleaguesBar();
          decorateNativeCards();
        }
        if (!filterEnabled) return;
        const panelMissing = !document.getElementById(PANEL_ID);
        const nativeVisible = Array.from(
          document.querySelectorAll('[data-qa^="list-"], [data-qa="carousel"]:not(:has([data-qa="reorder-card"]))')
        ).some((el) => !el.classList.contains(HIDE));
        if (urlChanged || panelMissing || nativeVisible) applyFilters();
      }, 400);
    });

    obs.observe(document.body, { childList: true, subtree: true });
    log("Observer active");
  }

  async function main() {
    trackMenuVisit();
    filterEnabled = (await storageGet("tbfLunchFilter", false)) === true;
    colleaguesEnabled = (await storageGet("tbfColleagues", true)) !== false;
    log("Settings:", { lunchFilter: filterEnabled, colleagues: colleaguesEnabled });
    refreshAuth();
    handleOrderTracker();
    setupObserver(); // right away: menu/checkout pages have no sidebar but still navigate client-side

    let attempts = 0;
    const tryInit = () => {
      attempts++;
      if (injectToggle() || attempts >= 30) {
        log(attempts >= 30 ? "Sidebar not found (not a list page?)" : "Ready! Toggle is in the sidebar.");
        // Restore the saved state right away instead of waiting for a DOM change
        if (filterEnabled) applyFilters();
        else updateOrderUi();
        syncOrdersPolling();
      } else {
        setTimeout(tryInit, 1000);
      }
    };
    tryInit();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
