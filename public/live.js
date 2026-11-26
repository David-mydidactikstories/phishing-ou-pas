/* Appel vocal en direct : micro -> serveur -> Gemini Live -> haut-parleur.
   API : Live.start(scenarioId, { onReady, onHangup, onError }) / Live.stop()  */
(function () {
  var ws = null, inCtx = null, outCtx = null, stream = null, proc = null, nextT = 0, sources = [], stopped = true, handlers = {};

  function pcm16Base64(float32, srcRate) {
    var ratio = srcRate / 16000, n = Math.max(1, Math.floor(float32.length / ratio)), buf = new ArrayBuffer(n * 2), view = new DataView(buf);
    for (var i = 0; i < n; i++) {
      var pos = i * ratio, idx = Math.floor(pos), frac = pos - idx;
      var a = float32[idx] || 0, b = float32[Math.min(idx + 1, float32.length - 1)] || a;
      var s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
    var bytes = new Uint8Array(buf), bin = "";
    for (var j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
    return btoa(bin);
  }

  /* Effet « téléphone » : bande passante étroite (≈ 350–3300 Hz), léger grain et compression.
     Désactivable avec ?clean=1 dans l'adresse. */
  var phone = null;
  function bus() {
    if (/[?&]clean=1/.test(location.search)) return outCtx.destination;
    if (phone) return phone;
    var hp = outCtx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 350; hp.Q.value = 0.8;
    var lp = outCtx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3300; lp.Q.value = 0.9;
    var mid = outCtx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1700; mid.gain.value = 5; mid.Q.value = 0.8;
    var sh = outCtx.createWaveShaper(), curve = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) { var x = i / 512 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    sh.curve = curve;
    var comp = outCtx.createDynamicsCompressor(); comp.threshold.value = -26; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.12;
    var out = outCtx.createGain(); out.gain.value = 1.15;
    hp.connect(lp); lp.connect(mid); mid.connect(sh); sh.connect(comp); comp.connect(out); out.connect(outCtx.destination);
    phone = hp; return phone;
  }

  function play(b64) {
    if (!outCtx) return;
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    var count = Math.floor(len / 2), view = new DataView(bytes.buffer);
    var buf = outCtx.createBuffer(1, Math.max(1, count), 24000), ch = buf.getChannelData(0);
    for (var k = 0; k < count; k++) ch[k] = view.getInt16(k * 2, true) / 32768;
    var src = outCtx.createBufferSource();
    src.buffer = buf; src.connect(bus());
    var t = Math.max(outCtx.currentTime + 0.015, nextT);
    nextT = t + buf.duration;
    sources.push(src);
    src.onended = function () { sources = sources.filter(function (s) { return s !== src; }); };
    src.start(t);
  }

  function flush() {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    sources = []; nextT = 0;
  }

  function teardown() {
    stopped = true;
    flush();
    if (proc) { proc.onaudioprocess = null; try { proc.disconnect(); } catch (e) {} proc = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (inCtx) { inCtx.close().catch(function () {}); inCtx = null; }
    if (outCtx) { outCtx.close().catch(function () {}); outCtx = null; }
    if (ws) {
      var w = ws; ws = null;
      w.onmessage = w.onerror = w.onclose = null;
      try { if (w.readyState === 1) w.send(JSON.stringify({ type: "hangup" })); w.close(1000); } catch (e) {}
    }
  }

  function fail(msg) { var h = handlers; teardown(); if (h.onError) h.onError(msg); }

  function micMessage(e) {
    if (e && e.name === "NotAllowedError") return "Le micro est bloqué. Autorise-le dans la barre d'adresse du navigateur, puis relance l'appel.";
    if (e && e.name === "NotFoundError") return "Aucun micro détecté sur cet appareil.";
    return "Le micro n'est pas disponible (" + (e && e.name ? e.name : "erreur") + ").";
  }

  window.Live = {
    start: function (scenarioId, h) {
      teardown();
      handlers = h || {}; stopped = false;
      var AC = window.AudioContext || window.webkitAudioContext;
      outCtx = new AC({ sampleRate: 24000 }); phone = null;
      outCtx.resume().catch(function () {});

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return fail("Le micro n'est pas accessible ici (il faut une page en https).");
      }
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (s) {
        if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        var proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(proto + "//" + location.host + ((location.pathname.replace(/[^\/]*$/, "")) || "/") + "api/live?scenario=" + scenarioId + "&prenom=" + encodeURIComponent(handlers.prenom || "") + "&prenom_dit=" + encodeURIComponent(handlers.prenomDit || "") + "&manager=" + encodeURIComponent(handlers.manager || ""));
        var ready = false;

        ws.onopen = function () {
          inCtx = new AC({ sampleRate: 16000 });
          inCtx.resume().catch(function () {});
          var src = inCtx.createMediaStreamSource(stream);
          proc = inCtx.createScriptProcessor(2048, 1, 1);
          var mute = inCtx.createGain(); mute.gain.value = 0;
          src.connect(proc); proc.connect(mute); mute.connect(inCtx.destination);
          proc.onaudioprocess = function (ev) {
            if (!ready || !ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: "audio", data: pcm16Base64(ev.inputBuffer.getChannelData(0), inCtx.sampleRate) }));
          };
        };

        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.type === "ready") { ready = true; if (handlers.onReady) handlers.onReady(); }
          else if (m.type === "audio") play(m.data);
          else if (m.type === "interrupted") flush();
          else if (m.type === "callerHangup") {
            var wait = outCtx ? Math.max(0, (nextT - outCtx.currentTime) * 1000) : 0;
            var h2 = handlers, why = m.reason || "";
            setTimeout(function () { if (!stopped) { teardown(); if (h2.onHangup) h2.onHangup(why); } }, wait + 600);
          }
          else if (m.type === "error") fail(m.message || "Erreur de connexion avec le service vocal.");
          else if (m.type === "sessionClosed" && !ready) fail(m.reason || "La session vocale s'est fermée avant de démarrer.");
        };
        ws.onerror = function () { if (!stopped) fail("Impossible de joindre le serveur vocal."); };
        ws.onclose = function (ev) { if (!stopped && !ready) fail("La connexion vocale a été fermée (" + ev.code + ")."); };
      }).catch(function (e) { fail(micMessage(e)); });
    },
    warn: function () { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "timeoutWarning" })); },
    stop: function () { teardown(); }
  };
})();
