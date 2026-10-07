# The AI/ML Interview Deck

A self-contained Progressive Web App (PWA) of flip-card flashcards for highly technical
AI/ML interviews — ML foundations, probability, deep learning, Transformers & LLMs, and RL.
Equations render with native MathML and there is no build step. Optional
authentication loads a pinned Supabase browser client only when configured.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the current state model, persistence
boundaries, known risks, and the recommended next iteration.

## Files

```
index.html          The full app (deck + styles + logic)
auth-service.js     Provider-neutral identity boundary and Supabase adapter
auth-config.js      Browser-safe public authentication configuration
ARCHITECTURE.md      Current architecture, boundaries, and migration plan
manifest.json       PWA metadata (name, icons, colors)
sw.js               Service worker — caches the app for offline use
icons/
  icon-192.png      App icon (192×192)
  icon-512.png      App icon (512×512)
  maskable-512.png  Maskable icon for Android adaptive icons
```

## Deploy to GitHub Pages

1. **Create a repo** on GitHub, e.g. `aiml-interview-deck`.

2. **Push these files** to the repo root (everything in this folder):

   ```bash
   cd aiml-interview-deck
   git init
   git add .
   git commit -m "AI/ML interview flashcard PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/aiml-interview-deck.git
   git push -u origin main
   ```

3. **Enable Pages**: repo → **Settings** → **Pages** → under *Build and deployment*,
   set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.

4. Wait ~1 minute. Your deck is live at:

   ```
   https://<your-username>.github.io/aiml-interview-deck/
   ```

   The service worker and manifest only work over HTTPS — GitHub Pages provides that automatically.

## Install it as an app

- **Desktop (Chrome/Edge):** open the URL → click the **install icon** in the address bar.
- **Android (Chrome):** menu → **Add to Home screen / Install app**.
- **iOS (Safari):** Share → **Add to Home Screen**.

Once installed it opens in its own window and works offline (the service worker caches everything).

## Editing the deck

All flashcards live in the `CARDS` array inside `index.html`. Each entry is:

```js
{
  id:  "q_0001",              // immutable question identity
  topicId: "transformers_llms", // immutable topic relationship
  cat: "Transformers & LLMs",   // category (drives the filter chip + color)
  q:   "Question text",
  body: `<p class="answer">...</p> <div class="eq"><math>...</math></div>`,
  src: "Source name",
  url: "https://link-to-source"
}
```

Keep an existing card's `id` unchanged when editing its question, answer, or
category. After changing `index.html` or any asset, bump `CACHE_VERSION` in `sw.js`
(e.g. `aiml-deck-v1` → `v2`) so installed clients fetch the new version instead of the cached one.

## Test locally

### Automated regression tests

Run the dependency-free core regression suite from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
```

The runner starts a temporary loopback-only static server and uses the installed
Microsoft Edge JavaScript runtime. It does not install packages or access the
internet. The 82 tests cover the 205 immutable question IDs, stable topic IDs,
canonical assessment semantics, reveal and duplicate guards, Quick and Full
session selection, result calculation, multi-session assessment history, derived
status and counters, reload persistence, legacy ID and storage-schema migration,
migration idempotency, unknown IDs, and malformed or corrupted browser storage.
They also cover history-derived Weak Areas, recovery and regression, session-size
limits, empty state, active-session stability, and stable topic filtering.
Overall and topic progress tests cover unique practiced questions, current-status
changes, percentage rounding, invalid history, and session-result separation.
Authentication tests use a fake provider to cover loading, anonymous,
authenticated, error, restoration, sign-out, stable identity, and preservation of
local learning data without network access.
The test page loads the real `index.html`, so these checks execute the production
functions and production card data.

To inspect individual results visually, serve the repository and open
`http://localhost:8000/tests/`.

### Browser smoke test

A service worker won't register from a `file://` path — serve over HTTP:

```bash
python -m http.server 8000
# then open http://localhost:8000/
```

## Optional authentication setup

The deck continues to work without authentication. To enable Google and
passwordless email magic-link sign-in, create a Supabase project and place its browser-safe project
URL and publishable key (or legacy anon key) in `auth-config.js`. Never place a
service-role key, database password, or Google client secret in frontend files.

In Supabase Authentication:

1. Set **Site URL** to the deployed Netlify origin.
2. Add the exact production application URL and the local URL used for testing,
   such as `http://localhost:8000/`, to **Redirect URLs**.
3. Enable the Google provider. In Google Cloud, create an OAuth web client and
   use the Supabase callback shown in the provider settings (normally
   `https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect
   URI, then enter the Google client ID and secret only in Supabase.
4. Keep email auth and new-user signups enabled. The application explicitly allows
   `signInWithOtp` to create first-time users. Configure production SMTP before
   public use; Supabase's default sender is only for limited team-member testing.

Magic links use the current page URL as their return location. First-time and
returning email users use the same passwordless form. Authentication creates an
account identity only; learning history is
still stored solely in the current browser and is not yet synchronized.
Netlify needs no special callback function or rewrite while the application stays
at the site root; its exact HTTPS site URL must simply be in Supabase's redirect
allow list.
