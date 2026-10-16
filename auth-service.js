(function (global) {
  "use strict";

  const AUTH_STATES = Object.freeze({
    loading: "loading",
    anonymous: "anonymous",
    authenticated: "authenticated",
    error: "error"
  });

  function identityFromSession(session) {
    const user = session && session.user;
    if (!user || typeof user.id !== "string" || !user.id) return null;
    const metadata = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
    const displayName = [metadata.given_name, metadata.full_name, metadata.name]
      .find(value => typeof value === "string" && value.trim());
    return Object.freeze({
      userId: user.id,
      ...(typeof user.email === "string" && user.email ? { email: user.email } : {}),
      ...(displayName ? { displayName: displayName.trim() } : {})
    });
  }

  function isValidEmailAddress(email) {
    return typeof email === "string"
      && email.length <= 254
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function describeEmailSignInError(error) {
    const providerCode = typeof error?.code === "string" ? error.code.toLowerCase() : "";
    const rawStatus = error?.status;
    const status = rawStatus !== null && rawStatus !== "" && Number.isFinite(Number(rawStatus))
      ? Number(rawStatus)
      : null;
    const name = typeof error?.name === "string" ? error.name.toLowerCase() : "";
    const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
    const detail = (category, diagnosticCode, userMessage) => Object.freeze({
      category,
      diagnosticCode,
      userMessage
    });

    if (status === 429 || ["over_email_send_rate_limit", "over_request_rate_limit"].includes(providerCode)) {
      return detail(
        "rate_limited",
        "EMAIL_RATE_LIMIT",
        "Too many sign-in links were requested. Wait a few minutes before trying again."
      );
    }
    if (providerCode === "email_address_not_authorized") {
      return detail(
        "email_delivery",
        "EMAIL_DELIVERY_RESTRICTED",
        "This address cannot receive email from the current sign-in service. Try Google or contact support."
      );
    }
    if (providerCode === "email_address_invalid") {
      return detail(
        "invalid_email",
        "EMAIL_ADDRESS_REJECTED",
        "This email address cannot be used for sign-in. Try a different address."
      );
    }
    if (["otp_disabled", "email_provider_disabled", "provider_disabled"].includes(providerCode)) {
      return detail(
        "invalid_configuration",
        "EMAIL_SIGN_IN_UNAVAILABLE",
        "Email sign-in is not available right now. Continue with Google or try again later."
      );
    }
    if (providerCode === "request_timeout" || (status !== null && status >= 500)) {
      return detail(
        "email_service",
        "EMAIL_SERVICE_UNAVAILABLE",
        "The email service is temporarily unavailable. Try again later."
      );
    }
    if (status === 0 || name === "typeerror" || /network|failed to fetch|load failed|offline/.test(message)) {
      return detail(
        "network",
        "EMAIL_NETWORK_ERROR",
        "We could not reach the sign-in service. Check your connection and try again."
      );
    }
    if (message === "enter a valid email address.") {
      return detail("invalid_email", "EMAIL_INVALID", "Enter a valid email address.");
    }
    return detail(
      "other",
      "EMAIL_AUTH_ERROR",
      "We could not send the sign-in link. Try again later or continue with Google."
    );
  }

  function createAuthService(client, options = {}) {
    if (!client || !client.auth) throw new Error("An authentication client is required.");
    let state = Object.freeze({ status: AUTH_STATES.loading, identity: null, error: null });
    let subscription = null;
    const listeners = new Set();
    if (typeof options.onChange === "function") listeners.add(options.onChange);

    function publish(status, session = null, error = null) {
      state = Object.freeze({ status, identity: identityFromSession(session), error: error || null });
      listeners.forEach(listener => listener(state));
      return state;
    }

    function publishError(error) {
      state = Object.freeze({ status: AUTH_STATES.error, identity: state.identity, error });
      listeners.forEach(listener => listener(state));
      return state;
    }

    function stateFromSession(session) {
      return identityFromSession(session)
        ? publish(AUTH_STATES.authenticated, session)
        : publish(AUTH_STATES.anonymous);
    }

    async function initialize() {
      publish(AUTH_STATES.loading);
      try {
        const result = await client.auth.getSession();
        if (result && result.error) throw result.error;
        stateFromSession(result && result.data ? result.data.session : null);
        if (!subscription && typeof client.auth.onAuthStateChange === "function") {
          const registered = client.auth.onAuthStateChange((_event, session) => stateFromSession(session));
          subscription = registered && registered.data ? registered.data.subscription : null;
        }
      } catch (error) {
        publishError(error);
      }
      return state;
    }

    async function signInWithGoogle(redirectTo) {
      try {
        const result = await client.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo }
        });
        if (result && result.error) throw result.error;
        return result;
      } catch (error) {
        publishError(error);
        throw error;
      }
    }

    async function signInWithEmail(email, redirectTo) {
      const normalizedEmail = typeof email === "string" ? email.trim() : "";
      if (!isValidEmailAddress(normalizedEmail)) {
        const error = new Error("Enter a valid email address.");
        publishError(error);
        throw error;
      }
      try {
        const result = await client.auth.signInWithOtp({
          email: normalizedEmail,
          options: { emailRedirectTo: redirectTo, shouldCreateUser: true }
        });
        if (result && result.error) throw result.error;
        return result;
      } catch (error) {
        publishError(error);
        throw error;
      }
    }

    async function signOut() {
      try {
        const result = await client.auth.signOut({ scope: "local" });
        if (result && result.error) throw result.error;
        return publish(AUTH_STATES.anonymous);
      } catch (error) {
        publishError(error);
        throw error;
      }
    }

    return Object.freeze({
      initialize,
      signInWithGoogle,
      signInWithEmail,
      signOut,
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
      },
      destroy() {
        if (subscription && typeof subscription.unsubscribe === "function") subscription.unsubscribe();
        subscription = null;
        listeners.clear();
      }
    });
  }

  function hasPublicAuthConfig(config) {
    if (!config || typeof config.supabaseUrl !== "string" || typeof config.supabasePublishableKey !== "string") return false;
    try {
      return new URL(config.supabaseUrl).protocol === "https:" && Boolean(config.supabasePublishableKey.trim());
    } catch (_error) {
      return false;
    }
  }

  function loadSupabaseLibrary(documentRef = global.document) {
    if (global.supabase && typeof global.supabase.createClient === "function") return Promise.resolve(global.supabase);
    return new Promise((resolve, reject) => {
      const existing = documentRef.querySelector('script[data-supabase-client]');
      if (existing) {
        existing.addEventListener("load", () => resolve(global.supabase), { once: true });
        existing.addEventListener("error", () => reject(new Error("Authentication service is unavailable.")), { once: true });
        return;
      }
      const script = documentRef.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/dist/umd/supabase.min.js";
      script.crossOrigin = "anonymous";
      script.dataset.supabaseClient = "";
      script.onload = () => resolve(global.supabase);
      script.onerror = () => reject(new Error("Authentication service is unavailable."));
      documentRef.head.appendChild(script);
    });
  }

  async function createConfiguredAuthContext(config, options = {}) {
    if (!hasPublicAuthConfig(config)) return null;
    const library = await loadSupabaseLibrary(options.documentRef);
    const client = library.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return Object.freeze({ client, authService: createAuthService(client, options) });
  }

  async function createConfiguredAuthService(config, options = {}) {
    const context = await createConfiguredAuthContext(config, options);
    return context ? context.authService : null;
  }

  global.AIMLAuth = Object.freeze({
    AUTH_STATES,
    identityFromSession,
    isValidEmailAddress,
    describeEmailSignInError,
    createAuthService,
    createConfiguredAuthContext,
    createConfiguredAuthService,
    hasPublicAuthConfig
  });
})(window);
