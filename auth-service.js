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
    return Object.freeze({
      userId: user.id,
      ...(typeof user.email === "string" && user.email ? { email: user.email } : {})
    });
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
      try {
        const result = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo }
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

  async function createConfiguredAuthService(config, options = {}) {
    if (!hasPublicAuthConfig(config)) return null;
    const library = await loadSupabaseLibrary(options.documentRef);
    const client = library.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return createAuthService(client, options);
  }

  global.AIMLAuth = Object.freeze({
    AUTH_STATES,
    identityFromSession,
    createAuthService,
    createConfiguredAuthService,
    hasPublicAuthConfig
  });
})(window);
