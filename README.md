# The Full Count

A pitcher-vs-batter guessing duel. The pitcher hides the pitch, effort and location; the batter reads all three. Build a team, earn coins, level up your players and climb the walk-off ladder.

**Play:** open the GitHub Pages link for this repository.

## What's here

| File | What it is |
| --- | --- |
| `index.html` | The whole game: rules, screens and styles |
| `config.js` | The Supabase address and public (publishable) key |
| `store.js` | Login and saving: team name + 4-digit PIN, saved in Supabase |
| `art/` | Card and cover illustrations |
| `supabase/schema.sql` | Database setup, for reference or for a fresh Supabase project |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## Hosting on GitHub Pages

1. Upload these files to the root of a public repository (the `index.html` file sits at the top level, not inside a folder).
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. After a minute or two the page shows your link, like `https://<your-username>.github.io/<repo-name>/`.

To update the game later, upload the changed files over the old ones; the site refreshes on its own.

## Saving

Teams, records and the game log live in Supabase. Row-level security is on and the browser can only call the functions in `supabase/schema.sql`. PINs are stored as bcrypt hashes and five wrong PINs lock a team for 10 minutes.
