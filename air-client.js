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

    // the relay: a listener whose network won't take a direct line gets the sound through the server instead,
    // as Opus packets over the same websocket. Low bitrate on purpose: the server's bandwidth is a monthly budget
    const RELAY_TYPE = 'audio/webm;codecs=opus';
    const RELAY_BITRATE = 48000;
    const RELAY_SLICE = 100;
    const RELAY_CHUNK = 4000;
    const RELAY_AFTER = 8000;
    const RELAY_LEAD = 0.7;
    const RELAY_BACKLOG = 256 * 1024;

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

    function line(onMessage, onDrop, onBinary) {
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
            sock.binaryType = 'arraybuffer';
            sock.onmessage = e => {
                heard = Date.now();
                if (typeof e.data !== 'string') {
                    if (onBinary) chain = chain.then(() => onBinary(e.data)).catch(() => {});
                    return;
                }
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

        // audio that can't leave in time is dropped, not queued: a radio goes on, it doesn't catch up
        function sendBinary(buf) {
            if (!ws || ws.readyState !== 1 || ws.bufferedAmount > RELAY_BACKLOG) return false;
            try { ws.send(buf); return true; } catch (e) { return false; }
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

        return { attach, send, sendBinary, drop, close, get open() { return !!ws && ws.readyState === 1; } };
    }

    addEventListener('offline', () => { for (const s of sessions) s.offline(); });
    addEventListener('online', () => { for (const s of sessions) s.online(); });

    // ---------- the relay on the wire: Opus packets out of MediaRecorder's WebM ----------

    // Only what MediaRecorder writes. Segment and Cluster have an unknown size while recording,
    // so containers are always entered, never skipped
    const WEBM_ENTER = new Set([0x18538067, 0x1F43B675, 0x1549A966, 0x1654AE6B, 0xAE, 0xE1, 0xA0]);

    function webmOpus(onConfig) {
        let buf = new Uint8Array(0);
        let scale = 1e6;
        let cluster = 0;
        let rate = 48000;
        let channels = 2;
        let told = false;

        function vint(p, isId) {
            if (p >= buf.length) return null;
            const first = buf[p];
            let len = 1;
            while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
            if (len > (isId ? 4 : 8)) return { bad: true };
            if (p + len > buf.length) return null;
            let v = isId ? first : first & (0xFF >> len);
            let ones = v === 0xFF >> len;
            for (let i = 1; i < len; i++) {
                v = v * 256 + buf[p + i];
                if (buf[p + i] !== 0xFF) ones = false;
            }
            return { v, len, unknown: !isId && ones };
        }

        const uint = b => b.reduce((n, x) => n * 256 + x, 0);

        function leaf(id, body, packets) {
            if (id === 0x2AD7B1) scale = uint(body);
            else if (id === 0x9F) channels = uint(body);
            else if (id === 0xB5) {
                const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
                rate = body.length === 8 ? dv.getFloat64(0) : dv.getFloat32(0);
            } else if (id === 0xE7) cluster = uint(body);
            else if (id === 0xA3 || id === 0xA1) {
                let q = 1;
                while (q <= 8 && !(body[0] & (0x80 >> (q - 1)))) q++;
                if (body.length < q + 3) return;
                // Opus from MediaRecorder is never laced; a laced block would need splitting, so it's left out
                if (body[q + 2] & 0x06) return;
                const rel = (body[q] << 24 >> 16) | body[q + 1];
                if (!told) {
                    told = true;
                    onConfig({ rate: Math.round(rate), channels });
                }
                packets.push([Math.max(0, Math.round((cluster + rel) * scale / 1e6)), body.slice(q + 3)]);
            }
        }

        function push(bytes) {
            const joined = new Uint8Array(buf.length + bytes.length);
            joined.set(buf);
            joined.set(bytes, buf.length);
            buf = joined;
            const packets = [];
            let p = 0;
            for (;;) {
                const id = vint(p, true);
                const size = id && !id.bad ? vint(p + id.len, false) : id;
                if (!id || !size) break;
                if (id.bad || size.bad) { p = buf.length; break; }
                const start = p + id.len + size.len;
                if (WEBM_ENTER.has(id.v)) { p = start; continue; }
                if (size.unknown) { p = buf.length; break; }
                if (start + size.v > buf.length) break;
                leaf(id.v, buf.subarray(start, start + size.v), packets);
                p = start + size.v;
            }
            buf = buf.slice(p);
            return packets;
        }

        return { push };
    }

    // [u32 ms][u16 length][packet] repeated, cut under the server's 4 KB per message
    function packRelay(packets) {
        const out = [];
        let i = 0;
        while (i < packets.length) {
            let size = 0;
            let j = i;
            while (j < packets.length && (j === i || size + 6 + packets[j][1].length <= RELAY_CHUNK)) size += 6 + packets[j++][1].length;
            const msg = new ArrayBuffer(size);
            const dv = new DataView(msg);
            const bytes = new Uint8Array(msg);
            let p = 0;
            for (; i < j; i++) {
                const [ms, data] = packets[i];
                dv.setUint32(p, ms >>> 0);
                dv.setUint16(p + 4, data.length);
                bytes.set(data, p + 6);
                p += 6 + data.length;
            }
            out.push(msg);
        }
        return out;
    }

    function unpackRelay(msg, each) {
        const dv = new DataView(msg);
        let p = 0;
        while (p + 6 <= msg.byteLength) {
            const ms = dv.getUint32(p);
            const len = dv.getUint16(p + 4);
            if (p + 6 + len > msg.byteLength) return;
            each(ms, new Uint8Array(msg, p + 6, len));
            p += 6 + len;
        }
    }

    const canRecordRelay = () => typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(RELAY_TYPE);

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
        const canRelay = canRecordRelay();
        let iceServers = STUN;
        let token = null;
        let ending = false;
        let retry = null;
        let dropAt = 0;
        let attempts = 0;
        let rec = null;
        let relayConfig = null;
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
                case 'relay':
                    if (m.on) relayStart();
                    else relayStop();
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
                    // a name kept for its owner (n0body), asked for without the owner's key
                    else if (m.code === 'reserved') { emit('error', { code: 'reserved' }); finish('reserved'); }
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

        // records only while somebody is relayed; the server says when
        function relayStart() {
            if (rec) {
                if (relayConfig) ln.send(relayConfig);
                return;
            }
            if (!canRelay) return;
            let mine;
            try {
                mine = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: RELAY_TYPE, audioBitsPerSecond: RELAY_BITRATE });
            } catch (e) {
                return;
            }
            rec = mine;
            const demux = webmOpus(cfg => {
                relayConfig = { t: 'relay-config', rate: cfg.rate, channels: cfg.channels };
                ln.send(relayConfig);
            });
            let order = Promise.resolve();
            mine.ondataavailable = e => {
                if (!e.data || !e.data.size) return;
                const blob = e.data;
                order = order
                    .then(() => blob.arrayBuffer())
                    .then(b => {
                        if (rec !== mine) return;
                        for (const msg of packRelay(demux.push(new Uint8Array(b)))) ln.sendBinary(msg);
                    })
                    .catch(() => {});
            };
            mine.onerror = () => { if (rec === mine) relayStop(); };
            try { mine.start(RELAY_SLICE); } catch (e) { rec = null; }
        }

        function relayStop() {
            const old = rec;
            rec = null;
            relayConfig = null;
            if (!old) return;
            old.ondataavailable = old.onerror = null;
            try { old.stop(); } catch (e) { /* already stopped */ }
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
                ln.send({ t: 'resume', id: air.id, token, relay: canRelay });
            } catch (e) {
                if (e.code === 'refused') { emit('error', { code: 'refused' }); finish('refused'); return; }
                later();
            }
        }

        function finish(reason) {
            if (final()) return;
            clearTimeout(retry);
            relayStop();
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
                const hello = { t: 'go-live', name: text(o.name, 40), from: text(o.from, 16), relay: canRelay };
                if (o.key) hello.key = text(o.key, 256);
                ln.send(hello);
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

    // opts.context: the page's AudioContext. Without it there is no relay, only the direct line
    function listen(id, opts) {
        const room = String(id || '');
        const me = { id: room, name: '', from: '', since: null, listeners: 0, state: 'connecting', stream: new MediaStream(), relayed: false };
        const emit = emitter(me);
        const ctx = opts && opts.context;
        const canRelay = !!ctx && typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function';
        let pc = null;
        let iceServers = STUN;
        let joined = false;
        let retry = null;
        let dropAt = 0;
        let attempts = 0;
        let reach = null;
        let relayAsked = false;
        let decoder = null;
        let relayOut = null;
        let relayDest = null;
        let relayBase = null;
        const relayPending = new Set();
        const FINAL = ['ended', 'not-found', 'cant-reach', 'full', 'unreachable', 'left'];
        const final = () => FINAL.includes(me.state);
        const setState = s => {
            if (me.state === s) return;
            me.state = s;
            emit('state', { state: s });
        };
        const ln = line(onMessage, onDrop, onBinary);
        const session = { offline: () => ln.drop(), online: () => { if (me.state === 'reconnecting') reconnect(); } };
        sessions.add(session);

        const waiting = () => !final() && me.state !== 'paused' && me.state !== 'reconnecting';

        function armReach() {
            clearTimeout(reach);
            if (me.relayed) return;
            reach = setTimeout(() => {
                if (!waiting() || (pc && pc.connectionState === 'connected')) return;
                if (canRelay && !relayAsked) askRelay();
                else end('cant-reach', 'cant-reach');
            }, canRelay && !relayAsked ? RELAY_AFTER : REACH_MS);
        }

        function askRelay() {
            relayAsked = true;
            ln.send({ t: 'relay' });
            clearTimeout(reach);
            reach = setTimeout(() => { if (waiting() && me.state !== 'live') end('cant-reach', 'cant-reach'); }, REACH_MS - RELAY_AFTER);
        }

        function startRelay() {
            if (me.relayed) return;
            me.relayed = true;
            closePeer();
            relayOut = ctx.createGain();
            relayDest = ctx.createMediaStreamDestination();
            relayOut.connect(relayDest);
            const track = relayDest.stream.getAudioTracks()[0];
            for (const t of me.stream.getTracks()) me.stream.removeTrack(t);
            me.stream.addTrack(track);
            emit('relay', {});
            emit('track', { track, stream: me.stream });
        }

        function configureRelay(m) {
            if (!me.relayed) return;
            if (decoder) try { decoder.close(); } catch (e) { /* already closed */ }
            decoder = null;
            // a new config means a new recording on the other side: its clock starts at zero again
            relayBase = null;
            flushRelay();
            const rate = Number(m.rate);
            const channels = Number(m.channels);
            try {
                const d = new AudioDecoder({ output: data => playRelay(d, data), error: () => {} });
                d.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels });
                decoder = d;
            } catch (e) {
                end('cant-reach', 'cant-reach');
            }
        }

        function onBinary(msg) {
            if (!me.relayed || final() || !decoder || decoder.state !== 'configured') return;
            // a decoder that fell behind skips ahead instead of growing a delay
            if (decoder.decodeQueueSize > 25) return;
            unpackRelay(msg, (ms, data) => {
                try { decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ms * 1000, data })); } catch (e) { /* a bad packet is a click, not an end */ }
            });
        }

        function plane(data, c, frames, chans) {
            const out = new Float32Array(frames);
            try {
                data.copyTo(out, { planeIndex: c, format: 'f32-planar' });
                return out;
            } catch (e) { /* this browser won't convert: read its own layout */ }
            try {
                if (data.format === 'f32-planar') {
                    data.copyTo(out, { planeIndex: c });
                } else if (data.format === 'f32') {
                    const all = new Float32Array(frames * chans);
                    data.copyTo(all, { planeIndex: 0 });
                    for (let i = 0; i < frames; i++) out[i] = all[i * chans + c];
                }
            } catch (e) { /* silence for this frame */ }
            return out;
        }

        function playRelay(d, data) {
            try {
                if (d !== decoder || !me.relayed || final()) return;
                const frames = data.numberOfFrames;
                const chans = data.numberOfChannels;
                const b = ctx.createBuffer(chans, frames, data.sampleRate);
                for (let c = 0; c < chans; c++) b.copyToChannel(plane(data, c, frames, chans), c);
                const at = data.timestamp / 1e6;
                const now = ctx.currentTime;
                let when = relayBase === null ? -1 : relayBase + at;
                // late (the network stalled) or far ahead (the two clocks drifted): set the cushion again,
                // and drop what was queued for the old one so the two never sound together
                if (when < now + 0.02 || when > now + RELAY_LEAD * 3) {
                    flushRelay();
                    relayBase = now + RELAY_LEAD - at;
                    when = now + RELAY_LEAD;
                }
                const src = ctx.createBufferSource();
                src.buffer = b;
                src.connect(relayOut);
                relayPending.add(src);
                src.onended = () => {
                    relayPending.delete(src);
                    src.disconnect();
                };
                src.start(when);
                if (me.state === 'tuning') {
                    clearTimeout(reach);
                    setState('live');
                    emit('connected', {});
                }
            } catch (e) {
                /* one frame lost */
            } finally {
                data.close();
            }
        }

        function flushRelay() {
            const old = [...relayPending];
            relayPending.clear();
            for (const src of old) try { src.stop(); } catch (e) { /* never started */ }
            setTimeout(() => { for (const src of old) src.disconnect(); }, 100);
        }

        function stopRelay() {
            flushRelay();
            if (decoder) try { decoder.close(); } catch (e) { /* already closed */ }
            decoder = null;
            if (relayOut) relayOut.disconnect();
            if (relayDest) for (const t of relayDest.stream.getTracks()) t.stop();
            relayOut = relayDest = null;
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
                    // back on the line after a drop: straight to the relay, the direct line already failed once
                    if (me.relayed) ln.send({ t: 'relay' });
                    else armReach();
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
                    setState(!me.relayed && pc && pc.connectionState === 'connected' ? 'live' : 'tuning');
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
                    // a server from before the relay doesn't know the message
                    else if (relayAsked && !me.relayed && m.code === 'bad-message') end('cant-reach', 'cant-reach');
                    else emit('error', { code: String(m.code) });
                    break;
                case 'relay':
                    if (m.ok === true) startRelay();
                    else if (m.ok === false) end('cant-reach', 'cant-reach');
                    break;
                case 'relay-config':
                    configureRelay(m);
                    break;
                case 'signal':
                    if (m.from !== room || !m.data || me.relayed) return;
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
                    else if (canRelay && !relayAsked) { closePeer(); setState('tuning'); askRelay(); }
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
            stopRelay();
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

    // whether a key is n0body's owner key: true, false, or a failure code ('unreachable', 'refused', 'busy')
    async function owner(key, opts) {
        const o = opts || {};
        const deadline = Date.now() + WAKE_MS;
        const waking = setTimeout(() => { if (o.onWaking) o.onWaking(); }, WAKING_AFTER);
        try {
            for (let attempt = 0; ; attempt++) {
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), Math.max(1500, Math.min(20000, deadline - Date.now())));
                try {
                    const res = await fetch(SERVER.url + '/air/owner', { method: 'POST', body: String(key || ''), cache: 'no-store', credentials: 'omit', signal: ctl.signal });
                    if (res.ok) return !!(await res.json()).ok;
                    if (res.status === 403) throw failure('refused');
                    if (res.status === 429) throw failure('busy');
                } catch (e) {
                    if (e.code === 'refused' || e.code === 'busy') throw e;
                } finally {
                    clearTimeout(t);
                }
                const left = deadline - Date.now();
                if (left <= 0) throw failure('unreachable');
                await sleep(Math.min(left, 4000, 500 * Math.pow(2, attempt)));
            }
        } finally {
            clearTimeout(waking);
        }
    }

    window.PGAir = Object.freeze({ server: SERVER.url, now, ice, mic, wake, goLive, listen, owner, link, withServer, isId: id => ID.test(id) });
})();
