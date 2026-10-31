/* The Full Count data store: one API, three backends.
   - supabase: hosted database (see supabase/schema.sql). PINs are checked on the server.
   - claude:   the artifact database when the game runs on claude.ai.
   - local:    this browser only.
   Every method resolves to an object; problems come back as {error:'message'}, never thrown. */
(function () {
  const CFG = window.FC_CONFIG || {};
  const key = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const hex = s => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
  const validName = n => /^[A-Za-z0-9][A-Za-z0-9 .'-]{1,15}$/.test(String(n || '').trim());  /* new teams: 2-16 characters (older 17-18 character teams can still log in) */
  const validPin = p => /^\d{4}$/.test(String(p || ''));
  const NAME_ERR = 'Team names are 2–16 characters: letters, numbers, spaces, . \' or -.';
  const PIN_ERR = 'Your PIN is 4 digits.';
  async function sha(s) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const rand = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

  /* Public leaderboard row from a team record */
  function pub(t) {
    if (!t || !t.name) return null;
    const r = t.record || {}, s = t.stats || {};
    return { name: t.name, crest: t.crest || null, w: r.w || 0, l: r.l || 0, t: r.t || 0, ladder: t.ladderBest || 0, avg: s.ab ? s.h / s.ab : 0 };
  }

  /* claude.ai and local backends share this logic: a document per team, keyed by its lowercase name. */
  function docBackend(kind, get, set, list, log) {
    return {
      kind,
      async logGame(doc) { if (log) await log(doc); return { ok: true }; },
      async create(name, pin, team) {
        if (!validName(name)) return { error: NAME_ERR };
        if (!validPin(pin)) return { error: PIN_ERR };
        const k = key(name);
        if (await get(k)) return { error: 'That team name is taken.' };
        const salt = rand(), ph = await sha(salt + pin);
        await set(k, { name: name.trim(), salt, ph, team, updated: Date.now() });
        return { team, token: ph };
      },
      async login(name, pin) {
        const k = key(name), d = await get(k);
        if (!d) return { error: 'No team with that name.' };
        if (d.lockUntil && Date.now() < d.lockUntil) return { error: 'Too many wrong PINs. Try again in a few minutes.' };
        if (await sha(d.salt + pin) !== d.ph) {
          d.fails = (d.fails || 0) + 1;
          if (d.fails >= 5) { d.lockUntil = Date.now() + 10 * 60e3; d.fails = 0; }
          await set(k, d);
          return { error: 'Wrong PIN.' };
        }
        if (d.fails || d.lockUntil) { d.fails = 0; d.lockUntil = 0; await set(k, d); }
        return { team: d.team, token: d.ph };
      },
      async resume(name, token) {
        const d = await get(key(name));
        return d && d.ph === token ? { team: d.team, token } : { error: 'Please log in again.' };
      },
      async save(name, token, team) {
        const k = key(name), d = await get(k);
        if (!d && kind === 'local' && store.fellBack) { await set(k, { name: team.name, salt: '', ph: token, team, updated: Date.now() }); return { ok: true }; }
        if (!d || d.ph !== token) return { error: 'Not logged in.' };
        d.team = team; d.updated = Date.now();
        await set(k, d);
        return { ok: true };
      },
      async board() { return (await list()).map(d => pub(d.team)).filter(Boolean); }
    };
  }

  function localBackend() {
    const K = 'fc-teams';
    const all = () => { try { return JSON.parse(localStorage.getItem(K) || '{}'); } catch (e) { return {}; } };
    return docBackend('local',
      async k => all()[k] || null,
      async (k, v) => { const a = all(); a[k] = v; try { localStorage.setItem(K, JSON.stringify(a)); } catch (e) {} },
      async () => Object.values(all()),
      async doc => { try { const L = JSON.parse(localStorage.getItem('fc-gamelog') || '[]'); L.push(doc); localStorage.setItem('fc-gamelog', JSON.stringify(L.slice(-30))); } catch (e) {} });
  }

  function claudeBackend(db) {
    const col = db.collection('teams');
    return docBackend('claude',
      async k => { const s = await col.doc(hex(k)).get(); return s.exists ? s.data() : null; },
      async (k, v) => { await col.doc(hex(k)).set(JSON.parse(JSON.stringify(v))); },
      async () => { const s = await col.get(); return s.docs.filter(d => d.exists).map(d => d.data()); },
      async doc => { await db.collection('gamelog').doc(Date.now().toString(36) + rand().slice(0, 6)).set(JSON.parse(JSON.stringify(doc))); });
  }

  /* Accept whatever was copied from Supabase: the Project URL, a bare project ID,
     a postgres connection string, or a dashboard link, and turn it into https://<id>.supabase.co */
  function projectUrl(raw) {
    const t = String(raw || '').trim();
    let m = t.match(/(?:db\.|\/\/|\.)?([a-z0-9]{20})\.supabase\.(co|com)/i) || t.match(/project\/([a-z0-9]{20})/i) || t.match(/postgres\.([a-z0-9]{20})[:@]/i) || t.match(/^([a-z0-9]{20})$/i);
    return m ? 'https://' + m[1].toLowerCase() + '.supabase.co' : t.replace(/\/(rest|auth).*$/, '').replace(/\/$/, '');
  }
  function supabaseBackend(url, anon) {
    const base = projectUrl(url) + '/rest/v1/rpc/';
    async function rpc(fn, args) {
      const r = await fetch(base + fn, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', apikey: anon }, /^eyJ/.test(anon) ? { Authorization: 'Bearer ' + anon } : {}),  /* new sb_publishable_ keys go in apikey only; legacy anon JWTs also in Authorization */
        body: JSON.stringify(args)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return { error: (j && (j.message || j.hint)) || 'The server had a problem. Try again.' };
      return j || {};
    }
    return {
      kind: 'supabase',
      async create(name, pin, team) {
        if (!validName(name)) return { error: NAME_ERR };
        if (!validPin(pin)) return { error: PIN_ERR };
        const j = await rpc('fc_create_team', { p_name: name.trim(), p_pin: pin, p_data: team });
        return j.error ? j : { team: j.data, token: j.token };
      },
      async login(name, pin) {
        const j = await rpc('fc_login', { p_name: String(name).trim(), p_pin: String(pin) });
        return j.error ? j : { team: j.data, token: j.token };
      },
      async resume(name, token) {
        const j = await rpc('fc_resume', { p_name: name, p_token: token });
        return j.error ? j : { team: j.data, token };
      },
      async save(name, token, team) {
        const j = await rpc('fc_save', { p_name: name, p_token: token, p_data: team });
        return j && j.error ? j : { ok: true };
      },
      async logGame(doc) { return rpc('fc_log_game', { p_data: doc }); },
      async board() {
        const j = await rpc('fc_leaderboard', {});
        return Array.isArray(j) ? j.map(r => ({ name: r.name, crest: r.crest || null, w: r.wins, l: r.losses, t: r.ties, ladder: r.ladder_best, avg: +r.avg || 0 })) : [];
      }
    };
  }

  /* On claude.ai only the owner and invited Contributors/Editors may write the shared database.
     Anyone else (a Viewer, or someone outside the owner's plan) gets a refused write: fall back to
     saving in this browser instead of failing. */
  const guard = fn => async (...a) => {
    try { return await fn(...a); }
    catch (e) {
      if (store.backend.kind === 'claude') {
        store.backend = localBackend(); store.fellBack = true;
        try { return await fn(...a); } catch (e2) {}
      }
      return { error: 'Could not reach the team database (' + store.backend.kind + ': ' + String((e && (e.code || e.message)) || e).slice(0, 80) + '). Check your connection and try again.' };
    }
  };

  const store = {
    backend: localBackend(),
    get kind() { return this.backend.kind; },
    async init() {
      const want = CFG.backend || 'auto';
      if ((want === 'supabase' || want === 'auto') && CFG.supabaseUrl && CFG.supabaseAnonKey) {
        this.backend = supabaseBackend(CFG.supabaseUrl, CFG.supabaseAnonKey);
      } else if ((want === 'claude' || want === 'auto') && window.claude && window.claude.use) {
        try { const db = await window.claude.use('db'); if (db) this.backend = claudeBackend(db); } catch (e) {}
      }
      return this.backend.kind;
    }
  };
  ['create', 'login', 'resume', 'save'].forEach(m => { store[m] = guard((...a) => store.backend[m](...a)); });
  store.logGame = async doc => { try { return await store.backend.logGame(doc); } catch (e) { return { error: 'log failed' }; } };
  store.board = async () => { try { return await store.backend.board(); } catch (e) { return []; } };
  store.validName = validName;
  store.validPin = validPin;
  window.FCStore = store;
})();
