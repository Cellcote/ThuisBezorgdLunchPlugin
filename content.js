(function () {
  "use strict";

  // ThuisBezorgd Lunch Filter
  //
  // The restaurant list UI is lazy-loaded, split into chunks by ad banners and
  // ordered by "best match", so hiding native cards is fragile. Instead we read
  // the full restaurant dataset from __NEXT_DATA__, filter it ourselves and
  // render our own list (sorted by distance) in place of the native lists.

  const CONFIG = {
    maxDistanceMeters: 1500,
    lunchStartHour: 12,
    lunchEndHour: 14,
    debugLog: true,
  };

  const PANEL_ID = "tbf-lunch-panel";
  const HIDE = "tbf-hide";

  let filterEnabled = false;
  let dataCache = { url: null, restaurants: null, promise: null };
  let renderedKey = null;

  function log(...args) {
    if (CONFIG.debugLog) console.log("[TBF-LunchFilter]", ...args);
  }

  log("Plugin loaded on", location.href);

  // ── Data ──────────────────────────────────────────────────────────
  function extractRestaurants(nextData) {
    return (
      nextData?.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData || {}
    );
  }

  function readInlineData() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      return el ? extractRestaurants(JSON.parse(el.textContent)) : {};
    } catch (e) {
      log("Failed to parse inline __NEXT_DATA__:", e);
      return {};
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
    const inline = url === initialUrl ? readInlineData() : {};
    const p =
      Object.keys(inline).length > 0
        ? Promise.resolve(inline)
        : fetchData(url).catch((e) => {
            log("Fetch failed, falling back to inline data:", e);
            return readInlineData();
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

  function hourOf(iso) {
    const d = new Date(iso);
    return isNaN(d) ? null : { date: d, h: d.getHours() + d.getMinutes() / 60 };
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
      const t = hourOf(av.nextAvailability.from);
      if (t && isToday(t.date) && t.h < CONFIG.lunchEndHour) return true;
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

  // ── Rendering ─────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function formatDistance(m) {
    if (m == null) return "";
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  }

  function headerImage(r) {
    const tpl = r.partnerHeaderInfo?.headerImages?.[0]?.urlTemplate || r.bannerUrl;
    return tpl ? tpl.replace("{transformations}", "c_thumb,h_144,w_287/f_auto/q_auto:eco") : "";
  }

  function menuHref(r) {
    const shipping = new URLSearchParams(location.search).get("shipping");
    return `/menu/${encodeURIComponent(r.uniqueName)}${shipping ? `?shipping=${encodeURIComponent(shipping)}` : ""}`;
  }

  function cardHtml(r) {
    const img = headerImage(r);
    const rating = r.rating?.starRating
      ? `<span>★ ${String(r.rating.starRating).replace(".", ",")} (${r.rating.count ?? 0})</span>`
      : "";
    const cuisines = (r.cuisines || []).slice(0, 2).map((c) => c.name).join(", ");
    return `
      <a class="tbf-card" href="${esc(menuHref(r))}" data-tbf-slug="${esc(r.uniqueName)}">
        <div class="tbf-card-img" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>
          ${r.logoUrl ? `<img class="tbf-card-logo" src="${esc(r.logoUrl)}" alt="" loading="lazy">` : ""}
        </div>
        <div class="tbf-card-name">${esc(r.name)}</div>
        <div class="tbf-card-meta">
          ${rating}
          <span>${esc(formatDistance(r.driveDistanceMeters))}</span>
          ${cuisines ? `<span>${esc(cuisines)}</span>` : ""}
        </div>
      </a>`;
  }

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
    anchor.parentElement.insertBefore(panel, anchor);
    renderedKey = null;
    return panel;
  }

  function setHidden(el, hidden) {
    if (hidden && !el.classList.contains(HIDE)) el.classList.add(HIDE, "tbf-native");
    else if (!hidden && el.classList.contains("tbf-native")) el.classList.remove(HIDE, "tbf-native");
  }

  function hideNative(matchSlugs) {
    // Native restaurant list sections (headers + content chunks)
    nativeListElements().forEach((el) => setHidden(el, true));

    // (Promo/sponsored banners are always hidden via styles.css)

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

    if (renderedKey === url && panel.isConnected) return;
    const mode = isPickup() ? "afhalen" : "bezorgen";
    panel.innerHTML = `
      <div class="tbf-panel-header">
        <h2>Lunch: ${matches.length} locaties</h2>
        <span class="tbf-panel-sub">&lt; ${formatDistance(CONFIG.maxDistanceMeters)} · open ${CONFIG.lunchStartHour}:00–${CONFIG.lunchEndHour}:00 · ${mode} · op afstand gesorteerd</span>
      </div>
      ${
        matches.length
          ? `<div class="tbf-grid">${matches.map(cardHtml).join("")}</div>`
          : `<p class="tbf-empty">Geen restaurants gevonden die aan het lunch filter voldoen.</p>`
      }`;
    renderedKey = url;
    log(`Rendered ${matches.length} of ${Object.keys(restaurants).length} restaurants`);
  }

  // ── Sidebar toggle ────────────────────────────────────────────────
  function injectToggle() {
    const existing = document.getElementById("tbf-lunch-toggle");
    if (existing && existing.isConnected) {
      const cb = document.getElementById("tbf-lunch-checkbox");
      if (cb && cb.checked !== filterEnabled) cb.checked = filterEnabled;
      return true;
    }

    const filterList = document.querySelector('ul[data-qa="filter"]');
    if (!filterList) return false;

    const items = filterList.querySelectorAll(":scope > li");
    let insertAfter = null;
    items.forEach((li) => {
      if (li.querySelector('[data-qa^="new-"]')) insertAfter = li;
    });
    if (!insertAfter && items.length) insertAfter = items[items.length - 1];

    const li = document.createElement("li");
    li.id = "tbf-lunch-toggle";
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:var(--xds-color-content-default);font-size:14px;">Lunch Filter</span>
        <label class="tbf-switch">
          <input type="checkbox" id="tbf-lunch-checkbox" />
          <span class="tbf-slider"></span>
        </label>
      </div>
      <div class="tbf-toggle-desc">&lt; ${formatDistance(CONFIG.maxDistanceMeters)} · ${CONFIG.lunchStartHour}:00–${CONFIG.lunchEndHour}:00 · neemt bestellingen aan</div>
    `;

    if (insertAfter) insertAfter.after(li);
    else filterList.prepend(li);

    const cb = document.getElementById("tbf-lunch-checkbox");
    cb.checked = filterEnabled;
    cb.addEventListener("change", function () {
      filterEnabled = this.checked;
      log("Lunch filter", filterEnabled ? "ON" : "OFF");
      applyFilters();
    });

    log("Toggle injected");
    return true;
  }

  // ── Keep in sync with React re-renders and client-side navigation ─
  function setupObserver() {
    let timer = null;
    let lastUrl = location.href;

    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        injectToggle();
        if (!filterEnabled) return;
        const urlChanged = location.href !== lastUrl;
        lastUrl = location.href;
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

  function main() {
    let attempts = 0;
    const tryInit = () => {
      attempts++;
      if (injectToggle() || attempts >= 30) {
        log(attempts >= 30 ? "WARNING: sidebar not found" : "Ready! Toggle is in the sidebar.");
        setupObserver();
      } else {
        setTimeout(tryInit, 1000);
      }
    };
    tryInit();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
