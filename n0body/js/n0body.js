// n0body's page: mk-1 in a frame with only its console, n0body's mind loaded into it, the set and the lamp up here.
// The mind lives in the n0body repo and is served next to play·ground, on the same origin, so it can reach MK1
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const BRAIN = '/n0body/dist/n0body.js';
    const KEY = 'n0body-llm-key';

    const frame = $('stage');
    const playBtn = $('playBtn');
    const setState = $('setState');
    const mindTag = $('mindTag');
    const air = $('air');
    const lamp = $('lamp');
    const airClock = $('airClock');
    const airCount = $('airCount');
    const airLink = $('airLink');
    const airUrl = $('airUrl');
    const airCopy = $('airCopy');

    let mk1 = null;
    let n0 = null;
    let llm = null;
    let playing = false;
    let onAir = false;
    let airSince = 0;
    let airFailed = '';
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

    // ---------- mk-1 and the mind ----------

    // ?air= (a local signaling server while testing) goes on to mk-1, the one that goes on air
    const testAir = new URLSearchParams(location.search).get('air');
    frame.src = '../mk-1.html?embed' + (testAir ? '&air=' + encodeURIComponent(testAir) : '');

    function fail(text) {
        setState.textContent = text;
        playBtn.disabled = true;
    }

    frame.addEventListener('load', () => {
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

    // a set is on air from its first hit to the end of its outro
    function goOnAir() {
        if (!mk1 || !mk1.MK1.air) return;
        onAir = true;
        airFailed = '';
        mk1.MK1.air.start({ name: 'n0body' }).catch(err => {
            onAir = false;
            const why = err && err.code;
            airFailed = why === 'unreachable' ? "the radio isn't answering" : why === 'full' ? 'the radio is full' : why === 'end' ? '' : "couldn't go on air";
        });
    }

    function goOffAir() {
        if (!onAir) return;
        onAir = false;
        if (mk1 && mk1.MK1.air) mk1.MK1.air.stop();
    }

    function toggle() {
        if (!n0) return;
        const s = n0.getStatus();
        if (s.isPlaying) {
            if (!s.isEnding) n0.stop();
        } else {
            n0.start();
            goOnAir();
        }
        update();
    }

    playBtn.addEventListener('click', toggle);

    function update() {
        if (!n0) return;
        const s = n0.getStatus();
        if (playing && !s.isPlaying) {
            goOffAir();
            note = 'off air · nothing kept';
            noteUntil = Date.now() + 4000;
        }
        playing = s.isPlaying;

        playBtn.textContent = !s.isPlaying ? 'play' : s.isEnding ? 'ending…' : 'stop';
        playBtn.disabled = s.isEnding;
        playBtn.setAttribute('aria-pressed', s.isPlaying ? 'true' : 'false');

        let line;
        if (s.isPlaying) {
            line = [s.currentState, s.mood, s.elapsedFormatted, s.bpm ? s.bpm + ' bpm' : ''].filter(Boolean).join(' · ');
            if (airFailed) line += ' · ' + airFailed;
        } else if (note && Date.now() < noteUntil) {
            line = note;
        } else {
            line = idleLine();
        }
        if (setState.textContent !== line) setState.textContent = line;

        showAir(mk1 && mk1.MK1.air ? mk1.MK1.air.status() : { state: 'off' });
        showMemory();
    }

    function showAir(st) {
        const state = st.state;
        if (state === 'off') {
            air.hidden = true;
            airSince = 0;
            return;
        }
        air.hidden = false;
        const live = state === 'live';
        lamp.dataset.state = live ? 'on' : 'hold';
        lamp.textContent = live ? 'on air' : state === 'reconnecting' ? 'on hold' : 'going on air';
        if (live && !airSince) airSince = Date.now();
        airClock.textContent = live ? clock(Date.now() - airSince) : '';
        airCount.textContent = live ? (st.listeners ? st.listeners + ' listening' : 'nobody listening yet') : state === 'waking' ? 'waking the radio…' : '';
        airLink.hidden = !live || !st.link;
        if (live && st.link) {
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

    // closing the tab ends the set: nobody should be left listening to a room about to vanish
    window.addEventListener('pagehide', goOffAir);
})();
