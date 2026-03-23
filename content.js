(function () {
  "use strict";

  const CONFIG = {
    maxDistanceMeters: 1000,
    lunchStartHour: 12,
    lunchEndHour: 14,
    debugLog: true,
  };

  let filterEnabled = false;
  let isApplying = false; // guard against re-entrant calls

  function log(...args) {
    if (CONFIG.debugLog) {
      console.log("[TBF-LunchFilter]", ...args);
    }
  }

  log("Plugin loaded on", window.location.href);

  // ── Extract restaurant data from __NEXT_DATA__ ────────────────────
  function getRestaurantData() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return {};
      const nextData = JSON.parse(el.textContent);
      return nextData.props.appProps.preloadedState.discovery.restaurantList.restaurantData || {};
    } catch (e) {
      log("Failed to get restaurant data:", e);
      return {};
    }
  }

  // ── Will this restaurant be open during 12:00–14:00? ──────────────
  function isOpenDuringLunch(restaurant) {
    const delivery = restaurant.availability?.delivery;
    if (!delivery) return false;

    // Already open right now — good
    if (delivery.isOpen) return true;

    // Can preorder and opens before lunch ends (14:00) — good
    // e.g. "Opent om 11:30" → will be open during lunch
    if (delivery.canPreOrder && delivery.nextAvailability?.from) {
      const h = new Date(delivery.nextAvailability.from);
      if (h.getHours() + h.getMinutes() / 60 < CONFIG.lunchEndHour) return true;
    }

    // Fallback: check deliveryOpeningTimeLocal
    if (restaurant.deliveryOpeningTimeLocal) {
      const h = new Date(restaurant.deliveryOpeningTimeLocal);
      if (h.getHours() + h.getMinutes() / 60 < CONFIG.lunchEndHour) return true;
    }

    return false;
  }

  // ── Does the restaurant accept orders? ─────────────────────────────
  function acceptsOrders(restaurant) {
    const delivery = restaurant.availability?.delivery;
    if (!delivery) return false;
    if (delivery.isOpen) return true;
    if (delivery.canPreOrder) return true;
    return false;
  }

  // ── Build a slug→verdict map from JSON data ───────────────────────
  function buildFilterMap() {
    const data = getRestaurantData();
    const map = {};

    for (const restaurant of Object.values(data)) {
      const slug = restaurant.uniqueName;
      const distance = restaurant.driveDistanceMeters ?? Infinity;
      const withinDistance = distance <= CONFIG.maxDistanceMeters;
      const orderable = acceptsOrders(restaurant);
      const lunchOpen = isOpenDuringLunch(restaurant);
      const shouldShow = withinDistance && orderable && lunchOpen;

      map[slug] = shouldShow;

      if (!shouldShow && CONFIG.debugLog) {
        const reasons = [];
        if (!withinDistance) reasons.push(`distance=${distance}m`);
        if (!orderable) reasons.push("not orderable");
        if (!lunchOpen) reasons.push("not open 12-14");
        log(`HIDE: "${restaurant.name}" (${reasons.join(", ")})`);
      }
    }
    return map;
  }

  // ── Apply or remove filters ───────────────────────────────────────
  function applyFilters() {
    if (isApplying) return;
    isApplying = true;

    try {
      if (!filterEnabled) {
        // Undo everything: unhide, restore moved cards, restore availability text
        document.querySelectorAll(".tbf-hide").forEach((el) => el.classList.remove("tbf-hide"));
        document.querySelectorAll(".tbf-moved").forEach((el) => {
          // Move back to original parent
          if (el._tbfOriginalParent) {
            el._tbfOriginalParent.appendChild(el);
          }
          el.classList.remove("tbf-moved");
        });
        document.querySelectorAll(".tbf-availability-hidden").forEach((el) => {
          el.classList.remove("tbf-availability-hidden");
        });
        log("Filters removed, cards restored");
        return;
      }

      const filterMap = buildFilterMap();
      if (Object.keys(filterMap).length === 0) {
        log("No restaurant data yet");
        return;
      }

      // ── Merge lists: move preorder/offline cards into the main open list ──
      const openContent = document.querySelector('[data-qa="list-all-open-content"]');
      const secondaryLists = document.querySelectorAll(
        '[data-qa="list-all-preorder-content"], [data-qa="list-all-offline-content"]'
      );

      // Fallback: find by section header text
      const allListContents = document.querySelectorAll('.list-style_list-contents__ve02L');

      if (openContent) {
        // Move cards from preorder/offline sections into the open section
        secondaryLists.forEach((list) => {
          const cards = list.querySelectorAll(':scope > [data-qa="restaurant-card"], :scope > [data-qa="sentinel-wrapped"]');
          cards.forEach((card) => {
            if (!card.classList.contains("tbf-moved")) {
              card._tbfOriginalParent = card.parentElement;
              card.classList.add("tbf-moved");
              openContent.appendChild(card);
            }
          });
        });

        // Also try moving from any list-contents that is NOT the open list
        if (secondaryLists.length === 0 && allListContents.length > 1) {
          allListContents.forEach((list, i) => {
            if (i === 0) return; // skip the first (open) list
            const cards = list.querySelectorAll(':scope > [data-qa="restaurant-card"], :scope > [data-qa="sentinel-wrapped"], :scope > .restaurant-card-shell_card__IMerh');
            cards.forEach((card) => {
              if (!card.classList.contains("tbf-moved")) {
                card._tbfOriginalParent = card.parentElement;
                card.classList.add("tbf-moved");
                openContent.appendChild(card);
              }
            });
          });
        }
      }

      let shown = 0;
      let hidden = 0;

      // ── Filter all restaurant cards (now all in one list) ──
      document.querySelectorAll('[data-qa="restaurant-card"]').forEach((card) => {
        const link = card.querySelector('a[data-qa*="-link"]');
        if (!link) return;

        const qa = link.getAttribute("data-qa") || "";
        const m = qa.match(/(?:restaurant-card|carousel-card)-(.+)-link/);
        if (!m) return;

        const slug = m[1];
        const container = card.closest('[data-qa="sentinel-wrapped"]') || card;

        // Check DOM text for "neemt geen bestellingen aan"
        const text = (card.textContent || "").toLowerCase();
        const noOrders = text.includes("neemt geen bestellingen aan");

        const showByData = filterMap[slug] !== undefined ? filterMap[slug] : true;

        if (!showByData || noOrders) {
          container.classList.add("tbf-hide");
          hidden++;
        } else {
          container.classList.remove("tbf-hide");
          shown++;

          // Hide availability/preorder status on shown cards
          // e.g. "Opent om 11:30", "Gesloten voor bezorging", preorder badges
          hideAvailabilityInfo(card);
        }
      });

      // ── Filter re-order cards ──
      document.querySelectorAll('[data-qa="reorder-card"]').forEach((card) => {
        const link = card.querySelector('a[data-qa="link"]');
        if (!link) return;
        const href = link.getAttribute("href") || "";
        const m = href.match(/\/menu\/([^?]+)/);
        if (!m) return;

        if (filterMap[m[1]] === false) {
          card.classList.add("tbf-hide");
        } else {
          card.classList.remove("tbf-hide");
        }
      });

      // ── Hide section headers and empty preorder/offline sections ──
      document.querySelectorAll(".list-style_list-header__08H3v").forEach((header) => {
        const t = (header.textContent || "").toLowerCase();
        if (t.includes("binnenkort") || t.includes("gesloten") || t.includes("open later")) {
          header.classList.add("tbf-hide");
        }
      });

      // ── Hide carousels where all cards are hidden ──
      document.querySelectorAll('[data-qa="carousel"]').forEach((carousel) => {
        const visible = carousel.querySelectorAll(
          '[data-qa="restaurant-card"]:not(.tbf-hide), [data-qa="reorder-card"]:not(.tbf-hide)'
        );
        if (visible.length === 0) carousel.classList.add("tbf-hide");
        else carousel.classList.remove("tbf-hide");
      });

      // ── Update counter ──
      const listTitle = document.querySelector('[data-qa="list-all-open-title"]');
      if (listTitle) {
        listTitle.textContent = `Bestel bij ${shown} locaties (lunch filter)`;
      }

      log(`Done: ${shown} shown, ${hidden} hidden`);
    } finally {
      isApplying = false;
    }
  }

  // ── Hide the availability/preorder info on a restaurant card ──────
  function hideAvailabilityInfo(card) {
    // Hide "Opent om ..." / "Gesloten voor bezorging" / preorder time text
    // These appear in the card as status messages and ETA elements
    // that reference opening times rather than delivery durations
    const etaEl = card.querySelector('[data-qa="restaurant-eta"]');
    if (etaEl) {
      const text = (etaEl.textContent || "").toLowerCase();
      // If it shows an opening time (e.g. "Opent om 11:30") rather than
      // a delivery duration (e.g. "25-45 min"), hide it
      if (text.includes("opent") || text.includes("opens") || text.includes("vanaf")) {
        etaEl.classList.add("tbf-availability-hidden", "tbf-hide");
      }
    }

    // Hide preorder/offline status overlays or badges
    card.querySelectorAll('[class*="preorder"], [class*="Preorder"], [class*="offline"], [class*="Offline"]').forEach((el) => {
      el.classList.add("tbf-availability-hidden", "tbf-hide");
    });

    // Hide any "Gesloten" or "Opent om" text spans in the card
    card.querySelectorAll("span, div, p").forEach((el) => {
      if (el.children.length > 2) return; // skip container divs
      const t = (el.textContent || "").trim().toLowerCase();
      if (
        (t.startsWith("opent") || t.startsWith("opens") || t.startsWith("gesloten") || t.startsWith("closed") || t.startsWith("vanaf")) &&
        t.length < 40
      ) {
        el.classList.add("tbf-availability-hidden", "tbf-hide");
      }
    });
  }

  // ── Inject toggle into sidebar ────────────────────────────────────
  function injectToggle() {
    if (document.getElementById("tbf-lunch-toggle")) {
      // Already exists — just sync the checkbox state
      const cb = document.getElementById("tbf-lunch-checkbox");
      if (cb && cb.checked !== filterEnabled) cb.checked = filterEnabled;
      return true;
    }

    const filterList = document.querySelector('ul[data-qa="filter"]');
    if (!filterList) {
      log("Sidebar not found yet...");
      return false;
    }

    // Find "Nieuw" item, or fall back to second <li>
    const items = filterList.querySelectorAll(":scope > li");
    let insertAfter = null;
    items.forEach((li) => {
      if (li.querySelector('[data-qa="new-filter-label"]')) insertAfter = li;
    });
    if (!insertAfter && items.length >= 2) insertAfter = items[1];

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
      <div class="tbf-toggle-desc">&lt; 1 km · 12:00–14:00 · neemt bestellingen aan</div>
    `;

    if (insertAfter) insertAfter.after(li);
    else filterList.prepend(li);

    document.getElementById("tbf-lunch-checkbox").addEventListener("change", function () {
      filterEnabled = this.checked;
      log("Lunch filter", filterEnabled ? "ON" : "OFF");
      applyFilters();
    });

    log("Toggle injected");
    return true;
  }

  // ── Observe DOM changes (infinite scroll, re-renders) ─────────────
  function setupObserver() {
    // Only observe the restaurant list area, not the whole body
    const target = document.querySelector(".restaurant-list-page-layout_content__wiX_2") || document.body;

    const obs = new MutationObserver(() => {
      clearTimeout(obs._t);
      obs._t = setTimeout(() => {
        // Re-inject toggle if sidebar got re-rendered
        injectToggle();
        // Re-apply filter if enabled (new cards may have loaded)
        if (filterEnabled && !isApplying) applyFilters();
      }, 600);
    });

    obs.observe(target, { childList: true, subtree: true });
    log("Observer active on", target.className || "body");
  }

  // ── Boot ──────────────────────────────────────────────────────────
  function main() {
    log("Initialising...");

    let attempts = 0;
    const tryInit = () => {
      attempts++;
      const hasToggle = injectToggle();
      const hasData = Object.keys(getRestaurantData()).length > 0;

      if (hasToggle && hasData) {
        log("Ready! Toggle is in the sidebar.");
        setupObserver();
      } else if (attempts < 30) {
        setTimeout(tryInit, 1000);
      } else {
        log("WARNING: gave up waiting. toggle:", hasToggle, "data:", hasData);
        setupObserver();
      }
    };

    setTimeout(tryInit, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
