// ThuisBezorgd Lunch Filter — background service worker
//
// Owns UiPath sign-in (OAuth authorization code + PKCE via chrome.identity) and
// all calls to the LunchOrders API workflows. Content scripts talk to it with
// chrome.runtime.sendMessage, because they can't call cloud.uipath.com directly
// (CORS) and must never see tokens.

const UIPATH = {
  baseUrl: "https://cloud.uipath.com",
  org: "pmengineering",
  tenant: "Europe",
  // Orchestrator folder the LunchOrders solution is deployed to
  folderKey: "4bdde79f-a8da-4b09-952f-f50959f45753", // Shared/LunchOrders
  // Public (non-confidential) External App "Thuisbezorgd Lunch Filter"
  clientId: "3e32e131-a0b6-4b4f-914b-aa471112558c",
  scopes: "openid profile email offline_access OR.Jobs OR.Execution",
  getSlug: "lunch-orders",
  postSlug: "lunch-order",
};

const ORDERS_CACHE_MS = 30 * 1000;
let ordersCache = { at: 0, date: null, data: null };

const redirectUri = () => chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
const identityUrl = (p) => `${UIPATH.baseUrl}/identity_/connect/${p}`;
const triggerUrl = (slug) =>
  `${UIPATH.baseUrl}/${UIPATH.org}/${UIPATH.tenant}/orchestrator_/t/${UIPATH.folderKey}/${slug}`;

// ── PKCE helpers ────────────────────────────────────────────────────
function base64Url(bytes) {
  let s = "";
  new Uint8Array(bytes).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 64) {
  return base64Url(crypto.getRandomValues(new Uint8Array(len))).slice(0, len);
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

function decodeJwt(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(part)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Display name only (never used for authorization). UiPath's token response has
// no id_token, but the access token carries first_name/last_name/email; its
// `name` claim is usually the email address, so prefer the real name.
function personFromClaims(c) {
  const full =
    [c.first_name, c.last_name].filter(Boolean).join(" ") ||
    [c.given_name, c.family_name].filter(Boolean).join(" ");
  const name = c.name && !String(c.name).includes("@") ? c.name : "";
  return full || name || c.preferred_username || c.email || "Onbekend";
}

function claimsFrom(tokenResponse) {
  return {
    ...decodeJwt(tokenResponse.access_token || ""),
    ...(tokenResponse.id_token ? decodeJwt(tokenResponse.id_token) : {}),
  };
}

// ── Token storage ───────────────────────────────────────────────────
async function loadAuth() {
  const { tbfAuth } = await chrome.storage.local.get("tbfAuth");
  if (tbfAuth && (!tbfAuth.person || tbfAuth.person === "Onbekend") && tbfAuth.accessToken) {
    // Repair logins saved by an earlier version that only looked at id_token
    const claims = decodeJwt(tbfAuth.accessToken);
    tbfAuth.person = personFromClaims(claims);
    tbfAuth.email = tbfAuth.email || claims.email || null;
    await chrome.storage.local.set({ tbfAuth });
  }
  return tbfAuth || null;
}

async function saveAuth(tokenResponse, previous) {
  const claims = claimsFrom(tokenResponse);
  const person = personFromClaims(claims);
  const auth = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || previous?.refreshToken || null,
    expiresAt: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
    person: person !== "Onbekend" ? person : previous?.person || person,
    email: claims.email || previous?.email || null,
  };
  await chrome.storage.local.set({ tbfAuth: auth });
  return auth;
}

async function clearAuth() {
  await chrome.storage.local.remove("tbfAuth");
  ordersCache = { at: 0, date: null, data: null };
}

async function tokenRequest(params) {
  const res = await fetch(identityUrl("token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: UIPATH.clientId, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `token request failed (${res.status})`);
  return body;
}

// ── Sign-in flow ────────────────────────────────────────────────────
async function signIn(interactive) {
  const verifier = randomString(64);
  const challenge = base64Url(await sha256(verifier));
  const state = randomString(24);
  const url =
    identityUrl("authorize") +
    "?" +
    new URLSearchParams({
      response_type: "code",
      client_id: UIPATH.clientId,
      redirect_uri: redirectUri(),
      scope: UIPATH.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

  const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive });
  const params = new URL(redirect).searchParams;
  if (params.get("error")) throw new Error(params.get("error_description") || params.get("error"));
  if (params.get("state") !== state) throw new Error("state mismatch");

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: params.get("code"),
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  return saveAuth(tokens, null);
}

// Valid access token, refreshing silently when possible. Never opens a window.
async function getAuth() {
  const auth = await loadAuth();
  if (!auth) return null;
  if (auth.expiresAt - Date.now() > 60 * 1000) return auth;

  if (auth.refreshToken) {
    try {
      const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
      return await saveAuth(tokens, auth);
    } catch (e) {
      console.warn("[TBF] refresh failed", e);
    }
  }
  try {
    return await signIn(false); // silent, works while the UiPath session cookie is valid
  } catch {
    await clearAuth();
    return null;
  }
}

// ── API calls ───────────────────────────────────────────────────────
// LongPolling API triggers answer with the workflow output; be lenient about
// wrappers in case Orchestrator returns the job envelope instead.
function unwrap(body) {
  if (!body || typeof body !== "object") return body;
  if (typeof body.OutputArguments === "string") {
    try {
      return JSON.parse(body.OutputArguments);
    } catch {
      /* fall through */
    }
  }
  return body.output || body.Output || body;
}

async function callApi(method, slug, { query, body } = {}) {
  if (UIPATH.folderKey.startsWith("__")) throw new Error("API not configured yet (folderKey)");
  const auth = await getAuth();
  if (!auth) return { ok: false, needsSignIn: true };

  const url = triggerUrl(slug) + (query ? "?" + new URLSearchParams(query) : "");
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    await clearAuth();
    return { ok: false, needsSignIn: true };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) return { ok: false, status: res.status, error: (data && (data.message || data.Message)) || text };
  return { ok: true, data: unwrap(data), person: auth.person };
}

function todayAmsterdam() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function getOrders(force) {
  const date = todayAmsterdam();
  if (!force && ordersCache.data && ordersCache.date === date && Date.now() - ordersCache.at < ORDERS_CACHE_MS) {
    const auth = await loadAuth();
    return { ok: true, data: ordersCache.data, person: auth?.person, cached: true };
  }
  const r = await callApi("GET", UIPATH.getSlug, { query: { date } });
  if (r.ok) ordersCache = { at: Date.now(), date, data: r.data };
  return r;
}

async function postOrder(order) {
  const auth = await getAuth();
  if (!auth) return { ok: false, needsSignIn: true };
  const r = await callApi("POST", UIPATH.postSlug, {
    body: {
      person: auth.person,
      restaurantSlug: order.restaurantSlug,
      restaurantName: order.restaurantName || order.restaurantSlug,
      orderReference: order.orderReference || "",
      orderedAt: new Date().toISOString(),
      pickupAt: order.pickupAt || undefined,
    },
  });
  if (r.ok) ordersCache = { at: 0, date: null, data: null };
  return r;
}

// ── Message router ──────────────────────────────────────────────────
const handlers = {
  "auth:status": async () => {
    const auth = await loadAuth();
    return { signedIn: !!auth, person: auth?.person || null };
  },
  "auth:signIn": async () => {
    const auth = await signIn(true);
    return { signedIn: true, person: auth.person };
  },
  "auth:signOut": async () => {
    await clearAuth();
    return { signedIn: false };
  },
  "orders:get": (msg) => getOrders(!!msg.force),
  "orders:post": (msg) => postOrder(msg.order || {}),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});
