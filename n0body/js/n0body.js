// n0body's page: mk-1 in a frame with only its console, n0body's mind loaded into it, the set and the radio up here.
// The mind lives in the n0body repo and is served next to play·ground, on the same origin, so it can reach MK1.
// Playing and going on air are separate: whoever is at the page decides when n0body's set goes out.
// The room is its owner's. Without the owner key in this browser the page is a door: no mk-1, no mind
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const BRAIN = '/n0body/dist/n0body.js';
    const KEY = 'n0body-llm-key';
    const OWNER = 'n0body-owner-key';

    const frame = $('stage');
    const playBtn = $('playBtn');
    const setState = $('setState');
    const mindTag = $('mindTag');
    const air = $('air');
    const airBtn = $('airBtn');
    const airClock = $('airClock');
    const airStatus = $('airStatus');
    const airLink = $('airLink');
    const airUrl = $('airUrl');
    const airCopy = $('airCopy');

    let ownerKey = '';
    let opened = false;
    let mk1 = null;
    let n0 = null;
    let llm = null;
    let playing = false;
    let airSince = 0;
    let airNote = '';
    let airNoteUntil = 0;
    let airArmed = 0;
    let lastAir = 'off';
    let note = '';
    let noteUntil = 0;
    let copiedUntil = 0;

    const pad = n => (n < 10 ? '0' : '') + n;
    function clock(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
    }

    // ---------- the door ----------

    const store = (name, value) => {
        try {
            if (value) localStorage.setItem(name, value);
            else localStorage.removeItem(name);
        } catch (e) { /* storage blocked: the key lasts this visit */ }
    };
    const stored = name => {
        try { return localStorage.getItem(name) || ''; } catch (e) { return ''; }
    };

    function showDoor(text) {
        $('door').hidden = false;
        $('doorNote').textContent = text || '';
        setState.textContent = '';
    }

    // the owner's link, …/n0body/#key=…, opens the room on a device once; a fragment never reaches a server, and it
    // leaves the address bar right away
    function keyFromLink() {
        const m = location.hash.match(/^#key=(.+)$/);
        if (!m) return '';
        history.replaceState(null, '', location.pathname + location.search);
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }

    function openRoom(key) {
        ownerKey = key;
        if (opened) return;
        opened = true;
        $('door').hidden = true;
        frame.hidden = false;
        playBtn.hidden = false;
        airBtn.hidden = false;
        document.querySelectorAll('.owner-only').forEach(el => { el.hidden = false; });
        document.querySelectorAll('.visitor-only').forEach(el => { el.hidden = true; });
        setState.textContent = 'waking mk-1…';
        // ?air= (a local signaling server while testing) goes on to mk-1, the one that goes on air
        const testAir = new URLSearchParams(location.search).get('air');
        frame.src = '../mk-1.html?embed' + (testAir ? '&air=' + encodeURIComponent(testAir) : '');
    }

    // the radio holds the key (N0BODY_KEY on its server); this browser only remembers it
    function verify(key, fromLink) {
        if (!window.PGAir) {
            if (fromLink) showDoor("the radio didn't load. reload the page.");
            return;
        }
        PGAir.owner(key, { onWaking: () => { if (fromLink) showDoor('waking the radio… up to a minute'); } })
            .then(ok => {
                if (ok) {
                    store(OWNER, key);
                    openRoom(key);
                    return;
                }
                store(OWNER, '');
                if (opened) location.reload();
                else showDoor(fromLink ? "that key doesn't open it." : '');
            })
            .catch(err => {
                if (fromLink) showDoor(err && err.code === 'busy' ? 'too many tries. wait a minute.' : "the radio isn't answering. try again in a minute.");
            });
    }

    const linkKey = keyFromLink();
    const keptKey = stored(OWNER);
    if (linkKey) {
        showDoor('checking the key…');
        verify(linkKey, true);
    } else if (keptKey) {
        // a key this browser already proved opens at once; the radio confirms it in the background
        openRoom(keptKey);
        verify(keptKey, false);
    } else {
        showDoor('');
    }

    // ---------- mk-1 and the mind ----------

    function fail(text) {
        setState.textContent = text;
        playBtn.disabled = true;
        airBtn.disabled = true;
    }

    frame.addEventListener('load', () => {
        if (!opened) return;
        let win;
        try { win = frame.contentWindow; } catch (e) { win = null; }
        if (!win || !win.MK1) { fail("mk-1 didn't load. reload the page."); return; }
        mk1 = win;
        setState.textContent = 'waking n0body…';
        const script = win.document.createElement('script');
        script.src = BRAIN;
        script.onload = () => {
            if (!win.n0body) { fail("n0body didn't load. reload the page."); return; }
            ready(win);
        };
        script.onerror = () => fail("n0body didn't load. reload the page.");
        win.document.body.appendChild(script);
    });

    function ready(win) {
        n0 = win.n0body;
        llm = win.n0bodyLLM;
        // the mind tells its own window when it wakes or stops; that window is mk-1's
        win.addEventListener('n0body-llm-status', e => {
            mindTag.hidden = !(e.detail && e.detail.status === 'active');
        });
        const saved = readKey();
        if (saved && llm) llm.activate(saved);
        showMind();
        playBtn.disabled = false;
        airBtn.disabled = false;
        update();
        setInterval(update, 500);
    }

    // ---------- the set ----------

    function memory() {
        const k = n0 && n0.knowledge;
        if (!k) return { sets: 0, grooves: 0, phrases: 0 };
        const count = map => Object.values(map || {}).reduce((n, list) => n + (list ? list.length : 0), 0);
        return { sets: k.sessionsPlayed || 0, grooves: count(k.grooveMemory), phrases: count(k.phraseMemory) };
    }

    function idleLine() {
        const m = memory();
        return m.sets ? m.sets + (m.sets === 1 ? ' set' : ' sets') + ' so far' : 'no sets yet';
    }

    function showMemory() {
        const m = memory();
        const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
        $('memory').textContent = m.sets
            ? plural(m.sets, 'set', 'sets') + ', ' + plural(m.grooves, 'groove', 'grooves') + ' and ' + plural(m.phrases, 'phrase', 'phrases') + ' it liked'
            : 'nothing yet';
    }

    function toggle() {
        if (!n0) return;
        const s = n0.getStatus();
        if (s.isPlaying) {
            if (!s.isEnding) n0.stop();
        } else {
            n0.start();
        }
        update();
    }

    playBtn.addEventListener('click', toggle);

    function update() {
        if (!n0) return;
        const s = n0.getStatus();
        if (playing && !s.isPlaying) {
            note = 'set over';
            noteUntil = Date.now() + 4000;
        }
        playing = s.isPlaying;

        playBtn.textContent = !s.isPlaying ? 'play' : s.isEnding ? 'ending…' : 'stop';
        playBtn.disabled = s.isEnding;
        playBtn.setAttribute('aria-pressed', s.isPlaying ? 'true' : 'false');

        let line;
        if (s.isPlaying) {
            line = [s.currentState, s.mood, s.elapsedFormatted, s.bpm ? s.bpm + ' bpm' : ''].filter(Boolean).join(' · ');
        } else if (note && Date.now() < noteUntil) {
            line = note;
        } else {
            line = idleLine();
        }
        if (setState.textContent !== line) setState.textContent = line;

        showAir(airState());
        showMemory();
    }

    // ---------- on air: its own button, never tied to play ----------

    const airState = () => (mk1 && mk1.MK1.air ? mk1.MK1.air.status() : { state: 'off' });

    const AIR_FAILS = {
        unreachable: "the radio isn't answering. try again in a minute.",
        refused: "this page can't reach the radio.",
        full: 'the radio is full. try again later.',
        lost: 'the line was down too long. off air.',
        replaced: 'it went on from another window.',
        server: 'the radio closed it.',
        reserved: "the radio didn't take the key."
    };

    function setAirNote(text, ms) {
        airNote = text;
        airNoteUntil = ms ? Date.now() + ms : Infinity;
        update();
    }

    function disarmAir() {
        clearTimeout(airArmed);
        airArmed = 0;
        airBtn.classList.remove('armed');
    }

    airBtn.addEventListener('click', () => {
        if (!mk1 || !mk1.MK1.air) return;
        const state = airState().state;
        if (state === 'off') {
            setAirNote('', 0);
            mk1.MK1.air.start({ name: 'n0body', key: ownerKey }).catch(err => {
                const why = err && err.code;
                if (why === 'end') setAirNote('off air.', 4000);
                else setAirNote(AIR_FAILS[why] || AIR_FAILS.unreachable);
            });
            update();
            return;
        }
        // before the room is live there is nothing to cut
        if (state !== 'live' && state !== 'reconnecting') {
            mk1.MK1.air.stop();
            update();
            return;
        }
        // two presses, no dialog: a stray click shouldn't cut a set off the radio
        if (!airArmed) {
            airBtn.classList.add('armed');
            airArmed = setTimeout(() => { disarmAir(); update(); }, 3000);
            update();
            return;
        }
        disarmAir();
        mk1.MK1.air.stop();
        setAirNote('off air · nothing kept', 4000);
    });

    // mk-air's signaling sleeps on Render's free tier; a hover wakes it before the click lands
    airBtn.addEventListener('pointerenter', () => {
        if (mk1 && mk1.PGAir && airState().state === 'off') mk1.PGAir.wake();
    }, { once: true });

    function showAir(st) {
        const state = st.state;
        // the radio dropped it without anyone pressing end: say so instead of going quiet
        if (state === 'off' && (lastAir === 'live' || lastAir === 'reconnecting') && !(airNote && Date.now() < airNoteUntil)) {
            airNote = 'off air.';
            airNoteUntil = Date.now() + 4000;
        }
        lastAir = state;
        const live = state === 'live';
        const held = state === 'reconnecting';
        airBtn.dataset.state = live ? 'on' : held ? 'hold' : state === 'off' ? 'off' : 'busy';
        airBtn.setAttribute('aria-pressed', state === 'off' ? 'false' : 'true');
        airBtn.textContent = airArmed ? 'end? press again' : 'on air';
        if (state === 'off') {
            if (airArmed) disarmAir();
            airSince = 0;
            const showNote = airNote && Date.now() < airNoteUntil;
            air.hidden = !showNote;
            airClock.textContent = '';
            airStatus.textContent = showNote ? airNote : '';
            airLink.hidden = true;
            return;
        }
        air.hidden = false;
        if (live && !airSince) airSince = Date.now();
        airClock.textContent = live || held ? clock(Date.now() - airSince) : '';
        airStatus.textContent = live ? (st.listeners ? st.listeners + ' listening' : 'nobody listening yet')
            : held ? 'the line dropped. reconnecting…'
            : state === 'waking' ? 'waking the radio… up to a minute' : 'going on air…';
        airLink.hidden = !(live || held) || !st.link;
        if (st.link) {
            airUrl.textContent = 'mk-air/?r=' + st.id;
            airLink.dataset.link = st.link;
            if (Date.now() > copiedUntil) airCopy.textContent = 'copy';
        }
    }

    airLink.addEventListener('click', async () => {
        const link = airLink.dataset.link;
        if (!link) return;
        let copied = false;
        try {
            await navigator.clipboard.writeText(link);
            copied = true;
        } catch (e) { /* no clipboard here: select the link instead */ }
        if (!copied) {
            const range = document.createRange();
            range.selectNodeContents(airUrl);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        }
        airCopy.textContent = copied ? 'copied' : 'selected';
        copiedUntil = Date.now() + 2000;
    });

    // ---------- the mind ----------

    function readKey() {
        try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
    }

    function showMind() {
        const has = !!readKey();
        $('mindForget').hidden = !has;
        $('mindKey').placeholder = has ? 'saved · paste another to change it' : 'gsk_…';
        $('mindState').textContent = has ? 'the mind is on. it plans with groq between parts of the set.' : 'no key: it plays from habit.';
        mindTag.hidden = !(llm && llm.isActive && llm.isActive());
    }

    $('mindForm').addEventListener('submit', e => {
        e.preventDefault();
        const input = $('mindKey');
        const key = input.value.trim();
        if (!key) return;
        try { localStorage.setItem(KEY, key); } catch (err) { /* private mode: the key lasts this visit */ }
        if (llm) llm.activate(key);
        input.value = '';
        showMind();
    });

    $('mindForget').addEventListener('click', () => {
        try { localStorage.removeItem(KEY); } catch (e) { /* nothing stored */ }
        if (llm) llm.deactivate();
        showMind();
    });

    // two presses, no dialog: the first only asks
    const forgetAll = $('forgetAll');
    let forgetArmed = 0;
    function disarmForget() {
        clearTimeout(forgetArmed);
        forgetArmed = 0;
        forgetAll.textContent = 'forget what it learned';
        forgetAll.classList.remove('armed');
    }
    forgetAll.addEventListener('click', () => {
        if (!n0) return;
        if (!forgetArmed) {
            forgetAll.textContent = 'forget all of it? press again';
            forgetAll.classList.add('armed');
            forgetArmed = setTimeout(disarmForget, 3000);
            return;
        }
        disarmForget();
        n0.resetLearning();
        if (llm && llm.resetSessionMemory) llm.resetSessionMemory();
        update();
    });

    // ---------- know how ----------

    const knowHowBtn = $('knowHow');
    const knowHowPanel = $('knowHowPanel');
    const knowHowOpen = () => !knowHowPanel.hidden;
    function openKnowHow() {
        knowHowPanel.hidden = false;
        knowHowBtn.setAttribute('aria-expanded', 'true');
        knowHowPanel.focus({ preventScroll: true });
    }
    function closeKnowHow(returnFocus) {
        if (!knowHowOpen()) return;
        knowHowPanel.hidden = true;
        knowHowBtn.setAttribute('aria-expanded', 'false');
        disarmForget();
        if (returnFocus) knowHowBtn.focus();
    }
    knowHowBtn.addEventListener('click', () => (knowHowOpen() ? closeKnowHow(false) : openKnowHow()));
    document.addEventListener('pointerdown', e => {
        if (knowHowOpen() && !knowHowPanel.contains(e.target) && !knowHowBtn.contains(e.target)) closeKnowHow(false);
    });
    // a click on mk-1 lands in its own document; leaving this one for the frame closes the panel too
    window.addEventListener('blur', () => { if (document.activeElement === frame) closeKnowHow(false); });

    document.addEventListener('keydown', e => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Escape' && knowHowOpen()) { closeKnowHow(true); return; }
        const t = e.target;
        if (t && t.closest && t.closest('input, textarea, select')) return;
        if (e.key === '?') { e.preventDefault(); knowHowOpen() ? closeKnowHow(true) : openKnowHow(); return; }
        // space is play / stop wherever the focus is, as in mk-1; it doesn't also press the focused button
        if (e.key === ' ' && !knowHowOpen()) { e.preventDefault(); toggle(); }
    });

    // closing the tab takes n0body off air: nobody should be left listening to a room about to vanish
    window.addEventListener('pagehide', () => { if (mk1 && mk1.MK1.air) mk1.MK1.air.stop(); });
})();
