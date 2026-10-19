// mk-air page: who's on, listening to one, going on air with the mic.
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const AIR = window.PGAir;
    const main = $('air');
    const out = $('out');
    const calm = matchMedia('(prefers-reduced-motion: reduce)');
    const rid = new URLSearchParams(location.search).get('r');

    let ctx = null;
    let meters = null;
    let broadcast = null;
    let listener = null;
    let micStream = null;
    let since = null;

    const listening = n => n + ' listening';
    const pad = n => (n < 10 ? '0' : '') + n;
    function airTime(from) {
        const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
    }

    // internal links keep a local test server across pages; in production this is a no-op
    for (const a of [$('leaveBtn'), $('afterNow'), $('afterGo')]) a.href = AIR.withServer(a.getAttribute('href'));

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
        if (returnFocus) knowHowBtn.focus();
    }
    knowHowBtn.addEventListener('click', () => (knowHowOpen() ? closeKnowHow(false) : openKnowHow()));
    document.addEventListener('pointerdown', e => {
        if (knowHowOpen() && !knowHowPanel.contains(e.target) && !knowHowBtn.contains(e.target)) closeKnowHow(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && knowHowOpen()) closeKnowHow(true);
    });

    // ---------- shared bits ----------

    function setLamp(el, state) {
        el.dataset.state = state;
        el.querySelector('.lamp-text').textContent = state === 'on' ? 'on air' : state === 'hold' ? 'on hold' : 'off air';
    }

    function show(view) {
        main.dataset.view = view;
        $('home').hidden = view !== 'home';
        $('booth').hidden = view === 'home';
    }

    // the page's one AudioContext, made on the gesture that starts the sound; it only meters, it never plays
    function ensureCtx() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) ctx = new AC();
        }
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
        return ctx;
    }

    function meterFrom(stream) {
        dropMeter();
        if (!ctx || !stream || !stream.getAudioTracks().length) return;
        const src = ctx.createMediaStreamSource(stream);
        // a mono mic lights both bars instead of only the left one
        const wide = ctx.createGain();
        wide.channelCount = 2;
        wide.channelCountMode = 'explicit';
        wide.channelInterpretation = 'speakers';
        const split = ctx.createChannelSplitter(2);
        const l = ctx.createAnalyser();
        const r = ctx.createAnalyser();
        const mix = ctx.createAnalyser();
        l.fftSize = r.fftSize = 1024;
        mix.fftSize = 2048;
        src.connect(wide);
        wide.connect(split);
        split.connect(l, 0);
        split.connect(r, 1);
        wide.connect(mix);
        meters = {
            nodes: [src, wide, split, l, r, mix], l, r, mix,
            bufL: new Float32Array(l.fftSize), bufR: new Float32Array(r.fftSize), bufM: new Float32Array(mix.fftSize),
            lvl: [0, 0], peak: [0, 0], peakAt: [0, 0]
        };
        loop();
    }

    function dropMeter() {
        if (!meters) return;
        for (const n of meters.nodes) n.disconnect();
        meters = null;
        loop();
    }

    // ---------- the wave and the vu ----------

    const wave = $('wave');
    const vu = $('vu');
    const ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent-air').trim() || '#ff5a4a';
    let raf = 0;

    function fit(canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        return dpr;
    }

    function drawWave(t) {
        const dpr = fit(wave);
        const g = wave.getContext('2d');
        const w = wave.width;
        const h = wave.height;
        const mid = h / 2;
        g.clearRect(0, 0, w, h);
        g.lineWidth = 2 * dpr;
        g.lineJoin = 'round';
        g.beginPath();
        if (meters) {
            meters.mix.getFloatTimeDomainData(meters.bufM);
            const buf = meters.bufM;
            let p = 0;
            for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
            // the drawing follows the level slowly so a quiet voice still moves the line; the sound is untouched
            meters.top = Math.max(p, (meters.top || 0) * 0.995, 0.02);
            const k = Math.min(8, 0.85 / meters.top) * mid;
            const step = buf.length / w;
            for (let x = 0; x < w; x++) {
                const y = mid - Math.max(-1, Math.min(1, buf[Math.floor(x * step)] * k / mid)) * mid;
                if (x) g.lineTo(x, y); else g.moveTo(x, y);
            }
            g.strokeStyle = ACCENT;
        } else {
            // dead air: flat, breathing very slowly
            const a = calm.matches ? 0 : (1 + Math.sin(t / 4200)) * 1.4 * dpr;
            for (let x = 0; x <= w; x += 4) {
                const y = mid + a * Math.sin(x / w * Math.PI * 3 + t / 2600);
                if (x) g.lineTo(x, y); else g.moveTo(x, y);
            }
            g.strokeStyle = '#444';
        }
        g.stroke();
    }

    function drawVu(t) {
        if (vu.hidden || !vu.clientWidth) return;
        const dpr = fit(vu);
        const g = vu.getContext('2d');
        const w = vu.width;
        const h = vu.height;
        const bar = Math.floor((h - 4 * dpr) / 2);
        g.clearRect(0, 0, w, h);
        for (let c = 0; c < 2; c++) {
            const y = c * (bar + 4 * dpr);
            g.fillStyle = '#1e1e1e';
            g.fillRect(0, y, w, bar);
            if (!meters) continue;
            const buf = c ? meters.bufR : meters.bufL;
            (c ? meters.r : meters.l).getFloatTimeDomainData(buf);
            let p = 0;
            for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
            // -48 dB to 0 dB across the bar; fast up, slow down like a needle
            const db = 20 * Math.log10(p + 1e-6);
            const target = Math.max(0, Math.min(1, (db + 48) / 48));
            const lvl = meters.lvl[c] = target > meters.lvl[c] ? target : meters.lvl[c] * 0.92 + target * 0.08;
            if (lvl >= meters.peak[c] || t - meters.peakAt[c] > 1200) { meters.peak[c] = lvl; meters.peakAt[c] = t; }
            g.fillStyle = ACCENT;
            g.fillRect(0, y, Math.round(w * lvl), bar);
            g.fillStyle = '#fff';
            g.fillRect(Math.max(0, Math.round(w * meters.peak[c]) - 2 * dpr), y, 2 * dpr, bar);
        }
    }

    function frame(t) {
        raf = 0;
        drawWave(t);
        drawVu(t);
        if (meters || !calm.matches) raf = requestAnimationFrame(frame);
    }

    function loop() {
        if (!raf) raf = requestAnimationFrame(frame);
    }

    calm.addEventListener('change', loop);
    window.addEventListener('resize', loop);
    loop();

    // ---------- the clock: a UI tick, no sound depends on it ----------

    setInterval(() => {
        if (since !== null) $('clockTime').textContent = airTime(since);
        for (const li of $('nowList').children) li.querySelector('.row-time').textContent = airTime(+li.dataset.since);
    }, 1000);

    function startClock(from) {
        since = from;
        $('clock').hidden = false;
        $('clockTime').textContent = airTime(since);
    }

    function stopClock(keep) {
        since = null;
        if (!keep) $('clock').hidden = true;
    }

    // ---------- home: on air now ----------

    const nowList = $('nowList');
    let nowTimer = 0;
    let nowBusy = false;

    function nowNote(msg, retry) {
        $('nowStatus').textContent = msg;
        $('nowRetry').hidden = !retry;
    }

    function renderRooms(rooms) {
        const keep = new Map([...nowList.children].map(li => [li.dataset.id, li]));
        rooms.sort((a, b) => a.since - b.since);
        rooms.forEach((r, i) => {
            let li = keep.get(r.id);
            keep.delete(r.id);
            if (!li) {
                li = document.createElement('li');
                li.dataset.id = r.id;
                const a = document.createElement('a');
                a.className = 'row';
                a.href = AIR.withServer('./?r=' + r.id);
                for (const c of ['row-dot', 'row-name', 'row-meta', 'row-time']) {
                    const s = document.createElement('span');
                    s.className = c;
                    a.appendChild(s);
                }
                a.firstChild.setAttribute('aria-hidden', 'true');
                li.appendChild(a);
            }
            li.dataset.since = r.since;
            li.querySelector('.row-name').textContent = r.name || 'someone';
            li.querySelector('.row-meta').textContent = (r.from ? 'from ' + r.from + ' · ' : '') + listening(r.listeners);
            li.querySelector('.row-time').textContent = airTime(r.since);
            if (nowList.children[i] !== li) nowList.insertBefore(li, nowList.children[i] || null);
        });
        for (const li of keep.values()) li.remove();
        $('nowEmpty').hidden = rooms.length > 0;
        $('nowCount').textContent = rooms.length ? rooms.length + ' on air' : '';
        setLamp($('homeLamp'), rooms.length ? 'on' : 'off');
    }

    async function refreshNow() {
        clearTimeout(nowTimer);
        if (document.hidden || main.dataset.view !== 'home' || nowBusy) return;
        nowBusy = true;
        try {
            const rooms = await AIR.now({ onWaking: () => nowNote('waking the radio… it can take up to a minute.') });
            nowNote('');
            renderRooms(rooms);
            nowTimer = setTimeout(refreshNow, 10000);
        } catch (e) {
            nowNote(e.code === 'refused' ? "this page can't reach the radio." : "the radio isn't answering. try again in a minute.", true);
        } finally {
            nowBusy = false;
        }
    }

    $('nowRetry').addEventListener('click', () => {
        nowNote('');
        refreshNow();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(nowTimer);
        else refreshNow();
    });

    // ---------- going on air ----------

    const goBtn = $('goBtn');
    const goStatus = msg => { $('goStatus').textContent = msg; };
    const offBtn = $('offBtn');
    let offArmed = 0;

    // once it ends the lamp alone says off air; the name stays, so the end reads as the end of that one
    const BROADCAST_ENDS = {
        end: "it's gone. nothing kept.",
        lost: 'the line was down too long. the room is gone.',
        replaced: 'it went on from another window.',
        server: 'the radio closed it.'
    };
    const CANT_GO = {
        full: 'the radio is full. try again later.',
        refused: "this page can't reach the radio.",
        unreachable: "the radio isn't answering. try again in a minute."
    };

    function stopMic() {
        if (micStream) for (const t of micStream.getTracks()) t.stop();
        micStream = null;
    }

    function broadcasterCount(n) {
        $('boothMeta').textContent = n ? listening(n) : 'nobody listening yet. share the link.';
    }

    async function goOnAir() {
        if (goBtn.getAttribute('aria-busy') === 'true' || (broadcast && broadcast.state !== 'ended')) return;
        goBtn.setAttribute('aria-busy', 'true');
        goStatus('asking for the mic…');
        ensureCtx();
        try {
            micStream = await AIR.mic();
        } catch (e) {
            goBtn.removeAttribute('aria-busy');
            const n = e && e.name;
            goStatus(n === 'NotAllowedError' || n === 'SecurityError' ? 'no mic. allow it in the browser and try again.'
                : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'no mic found.'
                : "that mic didn't answer.");
            return;
        }
        goStatus('going on air…');
        const name = $('airName').value.trim();
        const b = AIR.goLive({ stream: micStream, name, from: 'mic' });
        broadcast = b;
        b.on('waking', () => goStatus('waking the radio… it can take up to a minute.'));
        b.on('live', e => {
            goBtn.removeAttribute('aria-busy');
            goStatus('');
            show('onair');
            setLamp($('lamp'), 'on');
            startClock(e.since);
            $('boothName').textContent = name || 'your mic';
            broadcasterCount(0);
            $('boothStatus').textContent = '';
            $('shareUrl').textContent = e.link;
            $('share').hidden = false;
            $('listenActions').hidden = true;
            $('after').hidden = true;
            $('vu').hidden = false;
            meterFrom(micStream);
        });
        b.on('count', e => broadcasterCount(e.listeners));
        b.on('reconnecting', () => {
            setLamp($('lamp'), 'hold');
            $('boothStatus').textContent = 'the line dropped. reconnecting…';
        });
        b.on('resumed', () => {
            setLamp($('lamp'), 'on');
            $('boothStatus').textContent = '';
        });
        b.on('ended', e => {
            goBtn.removeAttribute('aria-busy');
            disarmOff();
            stopMic();
            dropMeter();
            if (!b.id) {
                goStatus(CANT_GO[e.reason] || CANT_GO.unreachable);
                return;
            }
            setLamp($('lamp'), 'off');
            stopClock(true);
            $('boothMeta').textContent = BROADCAST_ENDS[e.reason] || BROADCAST_ENDS.end;
            $('boothStatus').textContent = '';
            $('share').hidden = true;
            $('vu').hidden = true;
            $('after').hidden = false;
            $('afterRetry').hidden = true;
        });
    }

    goBtn.addEventListener('click', goOnAir);
    $('airName').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            goOnAir();
        }
    });

    function disarmOff() {
        clearTimeout(offArmed);
        offArmed = 0;
        offBtn.textContent = 'off air';
        offBtn.classList.remove('armed');
    }

    // two presses, no dialog: the first one only asks
    offBtn.addEventListener('click', () => {
        if (!broadcast || broadcast.state === 'ended') return;
        if (!offArmed) {
            offBtn.textContent = 'off air? press again';
            offBtn.classList.add('armed');
            offArmed = setTimeout(disarmOff, 3000);
            return;
        }
        disarmOff();
        broadcast.end();
    });

    let copied = 0;
    $('copyBtn').addEventListener('click', async () => {
        const btn = $('copyBtn');
        const url = $('shareUrl').textContent;
        try {
            await navigator.clipboard.writeText(url);
            btn.textContent = 'copied';
        } catch (e) {
            const range = document.createRange();
            range.selectNodeContents($('shareUrl'));
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            btn.textContent = 'selected';
        }
        clearTimeout(copied);
        copied = setTimeout(() => { btn.textContent = 'copy'; }, 2000);
    });

    // ---------- listening ----------

    const playBtn = $('playBtn');
    const LISTEN_ENDS = {
        'ended': [null, 'that was it. nothing kept.'],
        'not-found': ['nobody here.', 'whoever was on is gone, and so is the sound.'],
        'cant-reach': ["can't reach it.", "the sound can't get through this network. try again, or from another one."],
        'full': ['full.', 'fifty people are listening. try again in a while.'],
        'unreachable': ["the radio isn't answering.", 'try again in a minute.']
    };

    function fill(info) {
        $('boothName').textContent = info.name || 'someone';
        listenerMeta(info.from, info.listeners);
        if (info.since) startClock(info.since);
    }

    let lastFrom = '';
    function listenerMeta(from, n) {
        if (from !== undefined) lastFrom = from;
        $('boothMeta').textContent = (lastFrom ? 'from ' + lastFrom + ' · ' : '') + listening(n);
    }

    function listenEnd(kind) {
        const [title, line] = LISTEN_ENDS[kind] || LISTEN_ENDS.ended;
        const heard = kind === 'ended' && since !== null;
        setLamp($('lamp'), 'off');
        stopClock(heard);
        dropMeter();
        out.srcObject = null;
        if (title || !$('boothName').textContent) $('boothName').textContent = title || 'gone.';
        $('boothMeta').textContent = line;
        $('boothStatus').textContent = '';
        $('vu').hidden = true;
        $('listenActions').hidden = true;
        $('after').hidden = false;
        $('afterRetry').hidden = !['cant-reach', 'full', 'unreachable'].includes(kind);
    }

    function onListenState(state) {
        const status = $('boothStatus');
        if (state === 'waking') status.textContent = 'waking the radio… it can take up to a minute.';
        else if (state === 'tuning') { setLamp($('lamp'), 'on'); status.textContent = 'tuning in…'; }
        else if (state === 'live') { setLamp($('lamp'), 'on'); status.textContent = ''; }
        else if (state === 'paused') { setLamp($('lamp'), 'hold'); status.textContent = 'the line dropped. waiting for it…'; }
        else if (state === 'reconnecting') { setLamp($('lamp'), 'hold'); status.textContent = 'lost the line. tuning in again…'; }
        else if (LISTEN_ENDS[state]) listenEnd(state);
    }

    function startListening() {
        if (listener && !['ended', 'not-found', 'cant-reach', 'full', 'unreachable', 'left'].includes(listener.state)) return;
        ensureCtx();
        const l = AIR.listen(rid);
        listener = l;
        out.srcObject = l.stream;
        // played inside the gesture so the element may sound later, when the track arrives
        out.play().catch(() => {});
        playBtn.hidden = true;
        $('leaveBtn').hidden = false;
        $('listenActions').hidden = false;
        $('after').hidden = true;
        $('vu').hidden = false;
        $('boothStatus').textContent = 'tuning in…';
        l.on('joined', fill);
        l.on('count', e => listenerMeta(undefined, e.listeners));
        l.on('state', e => onListenState(e.state));
        l.on('track', e => {
            meterFrom(e.stream);
            out.play().catch(err => {
                // only a refusal asks for a tap; an abort just means the sound went away
                if (!err || err.name !== 'NotAllowedError' || listener !== l || l.state === 'left') return;
                playBtn.hidden = false;
                $('boothStatus').textContent = 'tap to listen.';
            });
        });
    }

    function openListen() {
        show('listen');
        setLamp($('lamp'), 'off');
        $('clock').hidden = true;
        $('listenActions').hidden = false;
        playBtn.hidden = false;
        $('leaveBtn').hidden = true;
        $('vu').hidden = true;
        if (!AIR.isId(rid || '')) { listenEnd('not-found'); return; }
        $('boothStatus').textContent = '';
        AIR.now({ onWaking: () => { if (!listener) $('boothStatus').textContent = 'waking the radio… it can take up to a minute.'; } })
            .then(rooms => {
                if (listener) return;
                const r = rooms.find(x => x.id === rid);
                if (!r) { listenEnd('not-found'); return; }
                fill(r);
                setLamp($('lamp'), 'on');
                $('boothStatus').textContent = '';
            })
            .catch(() => { if (!listener) listenEnd('unreachable'); });
    }

    playBtn.addEventListener('click', () => {
        if (listener && listener.state !== 'left' && out.srcObject) {
            // the element refused to sound before: this tap is the gesture it wanted
            out.play().then(() => { playBtn.hidden = true; $('boothStatus').textContent = ''; }).catch(() => {});
            return;
        }
        startListening();
    });

    $('leaveBtn').addEventListener('click', () => {
        if (listener) listener.leave();
    });

    $('afterRetry').addEventListener('click', () => {
        if (rid) {
            $('boothName').textContent = '';
            $('boothMeta').textContent = '';
            startListening();
        } else {
            location.reload();
        }
    });

    // ---------- arriving and leaving ----------

    function goHome(focusName) {
        if ((broadcast && broadcast.state !== 'ended') || (listener && !['ended', 'not-found', 'cant-reach', 'full', 'unreachable', 'left'].includes(listener.state))) return;
        show('home');
        refreshNow();
        if (focusName) $('airName').focus();
    }

    window.addEventListener('hashchange', () => {
        if (location.hash === '#go') goHome(true);
    });

    // already on this page with #go in the address: the link would not fire a hashchange
    $('afterGo').addEventListener('click', e => {
        if (rid !== null) return;
        e.preventDefault();
        goHome(true);
    });

    // closing the tab is going off air: nobody should hear a room that is about to vanish
    window.addEventListener('pagehide', () => {
        if (broadcast) broadcast.end();
        if (listener) listener.leave();
    });
    // back from the back/forward cache, everything on this page is stale
    window.addEventListener('pageshow', e => {
        if (e.persisted) location.reload();
    });

    if (rid !== null) {
        openListen();
    } else {
        show('home');
        refreshNow();
        if (location.hash === '#go') $('airName').focus();
    }
})();
