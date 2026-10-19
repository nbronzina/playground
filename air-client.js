// play·ground ↔ mk-air. The server only introduces the two sides; the sound goes browser to browser.
// One global, window.PGAir, for classic <script> pages: mk-air/, and mk-1 / mk-2 with their own master.
(function () {
    'use strict';

    const DEFAULT_SERVER = 'https://mk-air.onrender.com';
    const ID = /^[a-z0-9]{6}$/;
    const MAX_PEERS = 50;
    const MAX_BITRATE = 128000;
    const OPUS = [['stereo', '1'], ['sprop-stereo', '1'], ['maxaveragebitrate', '128000'], ['usedtx', '0']];
    const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const MIC = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } };

    const WAKING_AFTER = 2500;
    const PING_EVERY = 10000;
    const PONG_WAIT = 8000;
    const TICK = 2500;
    // the server keeps a dropped room 20 s; past that a resume can only hear not-found
    const LOST_AFTER = 30000;
    const REACH_MS = 20000;

    const script = document.currentScript;
    const ROOT = new URL('./', script && script.src ? script.src : location.href);

    // ?air= swaps the server for a local one while testing. Only a local one: a shared link must never
    // point this page at somebody else's signaling.
    const SERVER = (() => {
        let q = null;
        try { q = new URLSearchParams(location.search).get('air'); } catch (e) { q = null; }
        if (q) {
            try {
                const u = new URL(q);
                if (/^https?:$/.test(u.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
                    return { url: u.origin, local: true, override: u.origin };
                }
            } catch (e) { /* not a url: keep the real server */ }
        }
        return { url: DEFAULT_SERVER, local: false, override: null };
    })();
    const WS_URL = SERVER.url.replace(/^http/, 'ws') + '/air';
    // Render's free tier sleeps and takes up to a minute to answer the first request; a local server doesn't
    const WAKE_MS = SERVER.local ? 12000 : 75000;

    const sessions = new Set();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const failure = code => Object.assign(new Error(code), { code });
    const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);

    function withServer(href) {
        const u = new URL(href, location.href);
        if (SERVER.override) u.searchParams.set('air', SERVER.override);
        return u.href;
    }

    function link(id) {
        return withServer(new URL('mk-air/?r=' + encodeURIComponent(id), ROOT).href);
    }

    function emitter(target) {
        const map = new Map();
        target.on = (type, fn) => {
            if (!map.has(type)) map.set(type, new Set());
            map.get(type).add(fn);
            return target;
        };
        target.off = (type, fn) => {
            const s = map.get(type);
            if (s) s.delete(fn);
            return target;
        };
        return (type, detail) => {
            const s = map.get(type);
            if (!s) return;
            for (const fn of [...s]) {
                // one broken handler must not stop the others or the session
                try { fn(detail || {}); } catch (e) { setTimeout(() => { throw e; }); }
            }
        };
    }

    // ---------- http, with the cold start in mind ----------

    async function getJSON(path, opts) {
        const o = opts || {};
        const deadline = Date.now() + WAKE_MS;
        const waking = setTimeout(() => { if (o.onWaking) o.onWaking(); }, WAKING_AFTER);
        try {
            for (let attempt = 0; ; attempt++) {
                if (o.signal && o.signal.aborted) throw failure('aborted');
                const ctl = new AbortController();
                const stop = () => ctl.abort();
                const t = setTimeout(stop, Math.max(1500, Math.min(20000, deadline - Date.now())));
                if (o.signal) o.signal.addEventListener('abort', stop, { once: true });
                try {
                    const res = await fetch(SERVER.url + path, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
                    if (res.ok) return await res.json();
                    if (res.status === 403) throw failure('refused');
                } catch (e) {
                    if (e.code === 'refused') throw e;
                    if (o.signal && o.signal.aborted) throw failure('aborted');
                } finally {
                    clearTimeout(t);
                    if (o.signal) o.signal.removeEventListener('abort', stop);
                }
                const left = deadline - Date.now();
                if (left <= 0) throw failure('unreachable');
                await sleep(Math.min(left, 4000, 500 * Math.pow(2, attempt)));
            }
        } finally {
            clearTimeout(waking);
        }
    }

    function wake() {
        fetch(SERVER.url + '/air/now', { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).catch(() => {});
    }

    async function now(opts) {
        const data = await getJSON('/air/now', opts);
        const rooms = data && Array.isArray(data.rooms) ? data.rooms : [];
        return rooms
            .filter(r => r && typeof r.id === 'string' && ID.test(r.id))
            .map(r => ({
                id: r.id,
                name: text(r.name, 40),
                from: text(r.from, 16),
                listeners: Math.max(0, Number(r.listeners) || 0),
                since: Number(r.since) || Date.now(),
                link: link(r.id)
            }));
    }

    async function ice(opts) {
        const data = await getJSON('/air/ice', opts);
        return data && Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : STUN;
    }

    function mic() {
        return navigator.mediaDevices.getUserMedia(MIC);
    }

    // ---------- sdp: music, not a phone call ----------

    // Opus defaults to mono around 32 kbps tuned for voice. Both sides write stereo at 128 kbps into the
    // fmtp line, and the receiver's copy is what makes the sender encode stereo.
    function musicSdp(sdp) {
        if (typeof sdp !== 'string') return sdp;
        const rtp = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
        if (!rtp) return sdp;
        const pt = rtp[1];
        const line = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
        const build = params => 'a=fmtp:' + pt + ' ' + [...params].map(([k, v]) => (v === '' ? k : k + '=' + v)).join(';');
        if (!line.test(sdp)) return sdp.replace(rtp[0], () => rtp[0] + '\r\na=fmtp:' + pt + ' ' + OPUS.map(p => p.join('=')).join(';'));
        return sdp.replace(line, (all, params) => {
            const kv = new Map();
            params.split(';').map(s => s.trim()).filter(Boolean).forEach(p => {
                const i = p.indexOf('=');
                kv.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1));
            });
            for (const [k, v] of OPUS) kv.set(k, v);
            return build(kv);
        });
    }

    async function setLocal(pc, desc) {
        try {
            await pc.setLocalDescription({ type: desc.type, sdp: musicSdp(desc.sdp) });
        } catch (e) {
            // a browser that refuses an edited local sdp still gets stereo: the other side reads what we send
            await pc.setLocalDescription(desc);
        }
    }

    async function capBitrate(pc) {
        for (const s of pc.getSenders()) {
            if (!s.track || s.track.kind !== 'audio') continue;
            const p = s.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = MAX_BITRATE;
            try { await s.setParameters(p); } catch (e) { /* the fmtp line already asks for 128 kbps */ }
        }
    }

    // ---------- the line: one websocket, messages in order, a dead one noticed ----------

    function openSocket() {
        return new Promise((resolve, reject) => {
            let ws;
            try { ws = new WebSocket(WS_URL); } catch (e) { reject(failure('unreachable')); return; }
            const done = () => { clearTimeout(t); ws.onopen = ws.onclose = ws.onerror = null; };
            const t = setTimeout(() => {
                done();
                // closing a socket that is still connecting makes the browser log a warning; let it finish and go
                ws.onopen = () => { try { ws.close(); } catch (e) { /* already gone */ } };
                ws.onerror = () => {};
                reject(failure('unreachable'));
            }, 10000);
            ws.onerror = () => {};
            ws.onopen = () => { done(); resolve(ws); };
            ws.onclose = e => { done(); reject(failure(e.code === 1008 ? 'refused' : e.code === 1013 ? 'full' : 'unreachable')); };
        });
    }

    async function openWithin(deadline, isOver) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await openSocket();
            } catch (e) {
                if (e.code === 'refused' || e.code === 'full' || isOver()) throw e;
                const left = deadline - Date.now();
                if (left <= 0) throw e;
                await sleep(Math.min(left, 4000, 500 * Math.pow(2, attempt)));
            }
        }
    }

    function line(onMessage, onDrop) {
        let ws = null;
        let chain = Promise.resolve();
        let heard = 0;
        let pingAt = 0;
        let ping = null;

        function detach() {
            clearInterval(ping);
            const old = ws;
            ws = null;
            if (old) old.onmessage = old.onclose = old.onerror = null;
            return old;
        }

        function attach(sock) {
            detach();
            ws = sock;
            heard = Date.now();
            pingAt = 0;
            sock.onerror = () => {};
            sock.onmessage = e => {
                heard = Date.now();
                let m;
                try { m = JSON.parse(e.data); } catch (err) { return; }
                if (!m || typeof m !== 'object' || typeof m.t !== 'string' || m.t === 'pong') return;
                // a candidate must never overtake the description it belongs to
                chain = chain.then(() => onMessage(m)).catch(() => {});
            };
            sock.onclose = e => {
                if (ws !== sock) return;
                detach();
                onDrop(e.code);
            };
            // after a network change the socket can look open for a long time; an unanswered ping is the only tell.
            // Only a ping that went out counts: a hidden tab may run this timer once a minute
            ping = setInterval(() => {
                const now = Date.now();
                if (pingAt && heard < pingAt) {
                    if (now - pingAt > PONG_WAIT) drop();
                    return;
                }
                if (now - Math.max(pingAt, heard) >= PING_EVERY) {
                    pingAt = now;
                    send({ t: 'ping' });
                }
            }, TICK);
        }

        function send(msg) {
            if (!ws || ws.readyState !== 1) return false;
            try { ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
        }

        function drop() {
            const old = detach();
            if (!old) return;
            try { old.close(); } catch (e) { /* already closed */ }
            onDrop(1006);
        }

        function close() {
            const old = detach();
            if (old) try { old.close(1000); } catch (e) { /* already closed */ }
        }

        return { attach, send, drop, close, get open() { return !!ws && ws.readyState === 1; } };
    }

    addEventListener('offline', () => { for (const s of sessions) s.offline(); });
    addEventListener('online', () => { for (const s of sessions) s.online(); });

    // ---------- going on air ----------

    function goLive(opts) {
        const o = opts || {};
        const stream = o.stream;
        if (!stream || typeof stream.getAudioTracks !== 'function' || !stream.getAudioTracks().length) {
            throw new TypeError('PGAir.goLive needs { stream } with an audio track');
        }
        const air = { id: null, link: null, since: null, listeners: 0, state: 'connecting', stream };
        const emit = emitter(air);
        const peers = new Map();
        let iceServers = STUN;
        let token = null;
        let ending = false;
        let retry = null;
        let dropAt = 0;
        let attempts = 0;
        const final = () => air.state === 'ended';
        const setState = s => {
            if (air.state === s) return;
            air.state = s;
            emit('state', { state: s });
        };
        const ln = line(onMessage, onDrop);
        const session = { offline: () => ln.drop(), online: () => { if (air.state === 'reconnecting') reconnect(); } };
        sessions.add(session);

        async function onMessage(m) {
            if (final()) return;
            switch (m.t) {
                case 'live': {
                    if (typeof m.id !== 'string' || !ID.test(m.id)) return;
                    const again = !!air.id;
                    air.id = m.id;
                    token = typeof m.token === 'string' ? m.token : token;
                    dropAt = 0;
                    attempts = 0;
                    setState('live');
                    if (again) {
                        emit('resumed', { id: air.id });
                    } else {
                        air.since = Date.now();
                        air.link = link(air.id);
                        emit('live', { id: air.id, link: air.link, since: air.since });
                    }
                    break;
                }
                case 'count':
                    air.listeners = Math.max(0, Number(m.listeners) || 0);
                    emit('count', { listeners: air.listeners });
                    break;
                case 'listener':
                    await addPeer(m.lid);
                    break;
                case 'listener-left':
                    removePeer(m.lid);
                    break;
                case 'signal':
                    await onSignal(m.from, m.data);
                    break;
                case 'not-found':
                    finish('lost');
                    break;
                case 'ended':
                    finish(ending ? 'end' : 'server');
                    break;
                case 'error':
                    if (m.code === 'replaced') finish('replaced');
                    else if (m.code === 'full') { emit('error', { code: 'full' }); finish('full'); }
                    else emit('error', { code: String(m.code) });
                    break;
            }
        }

        async function addPeer(lid) {
            if (typeof lid !== 'string' || !lid || peers.has(lid) || peers.size >= MAX_PEERS) return;
            const pc = new RTCPeerConnection({ iceServers });
            peers.set(lid, pc);
            for (const t of stream.getAudioTracks()) pc.addTrack(t, stream);
            pc.onicecandidate = e => {
                ln.send({ t: 'signal', to: lid, data: { type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null } });
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed' && peers.get(lid) === pc) removePeer(lid);
            };
            try {
                const offer = await pc.createOffer();
                if (peers.get(lid) !== pc) return;
                await setLocal(pc, offer);
                ln.send({ t: 'signal', to: lid, data: { type: 'offer', sdp: musicSdp(pc.localDescription.sdp) } });
                await capBitrate(pc);
            } catch (e) {
                removePeer(lid);
            }
        }

        function removePeer(lid) {
            const pc = peers.get(lid);
            if (!pc) return;
            peers.delete(lid);
            pc.onicecandidate = pc.onconnectionstatechange = null;
            pc.close();
        }

        async function onSignal(from, data) {
            const pc = peers.get(from);
            if (!pc || !data) return;
            try {
                if (data.type === 'answer' && typeof data.sdp === 'string') {
                    if (pc.signalingState !== 'have-local-offer') return;
                    await pc.setRemoteDescription({ type: 'answer', sdp: musicSdp(data.sdp) });
                } else if (data.type === 'ice' && data.candidate) {
                    await pc.addIceCandidate(data.candidate);
                }
            } catch (e) {
                /* a late candidate for a closed peer: nothing to do */
            }
        }

        function onDrop(code) {
            if (final()) return;
            if (code === 1008) { emit('error', { code: 'refused' }); finish('refused'); return; }
            if (code === 4000) { finish('replaced'); return; }
            if (!air.id) { emit('error', { code: 'unreachable' }); finish('unreachable'); return; }
            if (!dropAt) dropAt = Date.now();
            if (air.state !== 'reconnecting') {
                setState('reconnecting');
                emit('reconnecting', {});
            }
            later();
        }

        function later() {
            clearTimeout(retry);
            if (final()) return;
            if (Date.now() - dropAt > LOST_AFTER) { finish('lost'); return; }
            retry = setTimeout(reconnect, Math.min(4000, 500 * Math.pow(2, attempts++)));
        }

        async function reconnect() {
            clearTimeout(retry);
            if (final() || ln.open) return;
            // offline: the online event brings us back right away
            if (navigator.onLine === false) { later(); return; }
            try {
                const ws = await openSocket();
                if (final() || ln.open) { ws.close(); return; }
                ln.attach(ws);
                ln.send({ t: 'resume', id: air.id, token });
            } catch (e) {
                if (e.code === 'refused') { emit('error', { code: 'refused' }); finish('refused'); return; }
                later();
            }
        }

        function finish(reason) {
            if (final()) return;
            clearTimeout(retry);
            ln.close();
            for (const lid of [...peers.keys()]) removePeer(lid);
            sessions.delete(session);
            air.listeners = 0;
            setState('ended');
            emit('ended', { reason });
        }

        air.end = () => {
            if (final()) return;
            ending = true;
            ln.send({ t: 'end' });
            finish('end');
        };

        (async () => {
            try {
                const onWaking = () => {
                    if (air.state !== 'connecting') return;
                    setState('waking');
                    emit('waking', {});
                };
                iceServers = await ice({ onWaking });
                if (final()) return;
                const ws = await openWithin(Date.now() + WAKE_MS, final);
                if (final()) { ws.close(); return; }
                ln.attach(ws);
                ln.send({ t: 'go-live', name: text(o.name, 40), from: text(o.from, 16) });
                setTimeout(() => {
                    if (!air.id && !final()) { emit('error', { code: 'unreachable' }); finish('unreachable'); }
                }, 10000);
            } catch (e) {
                if (final()) return;
                emit('error', { code: e.code || 'unreachable' });
                finish(e.code || 'unreachable');
            }
        })();

        return air;
    }

    // ---------- listening ----------

    function listen(id) {
        const room = String(id || '');
        const me = { id: room, name: '', from: '', since: null, listeners: 0, state: 'connecting', stream: new MediaStream() };
        const emit = emitter(me);
        let pc = null;
        let iceServers = STUN;
        let joined = false;
        let retry = null;
        let dropAt = 0;
        let attempts = 0;
        let reach = null;
        const FINAL = ['ended', 'not-found', 'cant-reach', 'full', 'unreachable', 'left'];
        const final = () => FINAL.includes(me.state);
        const setState = s => {
            if (me.state === s) return;
            me.state = s;
            emit('state', { state: s });
        };
        const ln = line(onMessage, onDrop);
        const session = { offline: () => ln.drop(), online: () => { if (me.state === 'reconnecting') reconnect(); } };
        sessions.add(session);

        function armReach() {
            clearTimeout(reach);
            reach = setTimeout(() => {
                if (!final() && me.state !== 'paused' && me.state !== 'reconnecting' && (!pc || pc.connectionState !== 'connected')) end('cant-reach', 'cant-reach');
            }, REACH_MS);
        }

        async function onMessage(m) {
            if (final()) return;
            switch (m.t) {
                case 'joined':
                    me.name = text(m.name, 40);
                    me.from = text(m.from, 16);
                    me.since = Number(m.since) || me.since || Date.now();
                    me.listeners = Math.max(0, Number(m.listeners) || 0);
                    dropAt = 0;
                    attempts = 0;
                    setState('tuning');
                    if (!joined) emit('joined', { id: room, name: me.name, from: me.from, since: me.since, listeners: me.listeners });
                    joined = true;
                    armReach();
                    break;
                case 'not-found':
                    if (joined) end('ended', 'ended');
                    else end('not-found', 'not-found');
                    break;
                case 'paused':
                    clearTimeout(reach);
                    setState('paused');
                    emit('paused', {});
                    break;
                case 'resumed':
                    setState(pc && pc.connectionState === 'connected' ? 'live' : 'tuning');
                    emit('resumed', {});
                    if (me.state !== 'live') armReach();
                    break;
                case 'count':
                    me.listeners = Math.max(0, Number(m.listeners) || 0);
                    emit('count', { listeners: me.listeners });
                    break;
                case 'ended':
                    end('ended', 'ended');
                    break;
                case 'error':
                    if (m.code === 'room-full') { emit('error', { code: 'full' }); end('full'); }
                    else emit('error', { code: String(m.code) });
                    break;
                case 'signal':
                    if (m.from !== room || !m.data) return;
                    if (m.data.type === 'offer' && typeof m.data.sdp === 'string') await answer(m.data.sdp);
                    else if (m.data.type === 'ice' && m.data.candidate && pc) {
                        try { await pc.addIceCandidate(m.data.candidate); } catch (e) { /* stale candidate */ }
                    }
                    break;
            }
        }

        function closePeer() {
            if (!pc) return;
            pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
            pc.close();
            pc = null;
        }

        async function answer(sdp) {
            closePeer();
            const mine = new RTCPeerConnection({ iceServers });
            pc = mine;
            mine.ontrack = e => {
                if (pc !== mine) return;
                for (const t of me.stream.getTracks()) if (t !== e.track) me.stream.removeTrack(t);
                if (!me.stream.getTracks().includes(e.track)) me.stream.addTrack(e.track);
                emit('track', { track: e.track, stream: me.stream });
            };
            mine.onicecandidate = e => {
                ln.send({ t: 'signal', to: room, data: { type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null } });
            };
            mine.onconnectionstatechange = () => {
                if (pc !== mine || final()) return;
                const s = mine.connectionState;
                if (s === 'connected') {
                    clearTimeout(reach);
                    if (me.state !== 'paused' && me.state !== 'reconnecting') setState('live');
                    emit('connected', {});
                } else if (s === 'failed') {
                    // while the line is down a new peer comes with the next offer; only a failed peer on a good line is final
                    if (me.state === 'reconnecting') closePeer();
                    else end('cant-reach', 'cant-reach');
                } else if (s === 'disconnected') {
                    // ice often finds its way back within a few seconds; give it the same time as a first try
                    armReach();
                }
            };
            try {
                await mine.setRemoteDescription({ type: 'offer', sdp: musicSdp(sdp) });
                const desc = await mine.createAnswer();
                if (pc !== mine) return;
                await setLocal(mine, desc);
                ln.send({ t: 'signal', to: room, data: { type: 'answer', sdp: musicSdp(mine.localDescription.sdp) } });
            } catch (e) {
                if (pc === mine) end('cant-reach', 'cant-reach');
            }
        }

        function onDrop(code) {
            if (final()) return;
            if (code === 1008) { emit('error', { code: 'refused' }); end('unreachable'); return; }
            if (!joined) { emit('error', { code: 'unreachable' }); end('unreachable'); return; }
            // the peer may still be playing: keep it until the new offer replaces it, or the broadcaster lets it go
            clearTimeout(reach);
            if (!dropAt) dropAt = Date.now();
            if (me.state !== 'reconnecting') {
                setState('reconnecting');
                emit('reconnecting', {});
            }
            later();
        }

        function later() {
            clearTimeout(retry);
            if (final()) return;
            if (Date.now() - dropAt > LOST_AFTER) { end('unreachable'); return; }
            retry = setTimeout(reconnect, Math.min(4000, 500 * Math.pow(2, attempts++)));
        }

        async function reconnect() {
            clearTimeout(retry);
            if (final() || ln.open) return;
            if (navigator.onLine === false) { later(); return; }
            try {
                const ws = await openSocket();
                if (final() || ln.open) { ws.close(); return; }
                ln.attach(ws);
                ln.send({ t: 'listen', id: room });
            } catch (e) {
                later();
            }
        }

        function end(state, event) {
            if (final()) return;
            clearTimeout(retry);
            clearTimeout(reach);
            ln.close();
            closePeer();
            sessions.delete(session);
            setState(state);
            if (event) emit(event, {});
        }

        me.leave = () => end('left');

        (async () => {
            if (!ID.test(room)) {
                await sleep(0);
                end('not-found', 'not-found');
                return;
            }
            try {
                const onWaking = () => {
                    if (me.state !== 'connecting') return;
                    setState('waking');
                    emit('waking', {});
                };
                iceServers = await ice({ onWaking });
                if (final()) return;
                const ws = await openWithin(Date.now() + WAKE_MS, final);
                if (final()) { ws.close(); return; }
                ln.attach(ws);
                ln.send({ t: 'listen', id: room });
            } catch (e) {
                if (final()) return;
                emit('error', { code: e.code || 'unreachable' });
                end('unreachable');
            }
        })();

        return me;
    }

    window.PGAir = Object.freeze({ server: SERVER.url, now, ice, mic, wake, goLive, listen, link, withServer, isId: id => ID.test(id) });
})();
