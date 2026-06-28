# The AI/ML Interview Deck

A self-contained Progressive Web App (PWA) of flip-card flashcards for highly technical
AI/ML interviews — ML foundations, probability, deep learning, Transformers & LLMs, and RL.
Equations render with native MathML; no build step, no dependencies.

## Files

```
index.html          The full app (deck + styles + logic)
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
  cat: "Transformers & LLMs",   // category (drives the filter chip + color)
  q:   "Question text",
  body: `<p class="answer">...</p> <div class="eq"><math>...</math></div>`,
  src: "Source name",
  url: "https://link-to-source"
}
```

**Important:** after changing `index.html` or any asset, bump `CACHE_VERSION` in `sw.js`
(e.g. `aiml-deck-v1` → `v2`) so installed clients fetch the new version instead of the cached one.

## Test locally

A service worker won't register from a `file://` path — serve over HTTP:

```bash
python -m http.server 8000
# then open http://localhost:8000/
```
