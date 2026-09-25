/* Pairwise forced-choice listening study (NotaGen Part I, human arm).
 * Static page: jsPsych 8 from a CDN, items from manifest.json, responses POSTed to an Apps Script collector.
 * URL: index.html?r=<rater id>[&s=<session id>]
 */
(function () {
  "use strict";
  const CFG = window.SURVEY_CONFIG;
  const params = new URLSearchParams(location.search);
  const raterId = (params.get("r") || "").trim();
  const t0 = Date.now();

  // ---------- small utilities ----------
  function hash32(str) { // cyrb53-derived, 32-bit
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0) ^ (h1 >>> 0);
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function shuffle(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; } return a; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function lsGet(k, dflt) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  // ---------- collector ----------
  const queueKey = "ls_queue_" + raterId;
  let queue = lsGet(queueKey, []);
  let sendFailures = 0;
  async function postRow(row) {
    if (!CFG.collectorUrl) return true;
    try {
      const res = await fetch(CFG.collectorUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(row), redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json().catch(function () { return { ok: true }; });
      if (j && j.ok === false) throw new Error(j.error || "collector refused");
      return true;
    } catch (e) { sendFailures++; console.warn("send failed", e); return false; }
  }
  function send(row) {
    row.rater = raterId; row.client_time = new Date().toISOString();
    row.uid = raterId + ":" + row.kind + ":" + (row.item_id || row.session || "") + ":" + (row.trial_index === undefined ? "" : row.trial_index);
    queue.push(row); lsSet(queueKey, queue);
    flush();
  }
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      while (queue.length) {
        const ok = await postRow(queue[0]);
        if (!ok) break;
        queue.shift(); lsSet(queueKey, queue);
      }
    } finally { flushing = false; }
  }

  // ---------- boot ----------
  const jsPsych = initJsPsych({ show_progress_bar: true, auto_update_progress_bar: false, message_progress_bar: "Progress" });

  function fatal(msg) { document.body.innerHTML = '<div class="jspsych-content" style="padding:40px"><p class="error">' + esc(msg) + '</p></div>'; }

  if (!raterId) { fatal("This link is missing a participant id (...?r=ID). Please use the exact link you were sent."); return; }

  fetch(CFG.manifestUrl, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("manifest " + r.status); return r.json(); })
    .then(run)
    .catch(function (e) { fatal("Could not load the study: " + e.message); });

  function run(M) {
    const sessionId = params.get("s") || M.default_session || Object.keys(M.sessions)[0];
    const ids = M.sessions[sessionId];
    if (!ids) { fatal("Unknown session '" + sessionId + "'."); return; }
    const byId = {}; M.items.forEach(function (it) { byId[it.id] = it; });
    const rnd = mulberry32(hash32(M.experiment + "|" + sessionId + "|" + raterId));
    const doneKey = "ls_done_" + M.experiment + "_" + sessionId + "_" + raterId;
    const done = new Set(lsGet(doneKey, []));

    // per-rater order and side flips, balanced within the rater
    const order = shuffle(ids, rnd);
    const flips = shuffle(order.map(function (_, i) { return i < Math.floor(order.length / 2); }), rnd);
    const plan = order.map(function (id, i) { return { item: byId[id], flipped: flips[i], pos: i }; });
    const remaining = plan.filter(function (p) { return !done.has(p.item.id); });
    const nTotal = plan.length;

    const mediaFiles = { audio: [], video: [], images: [] };
    plan.forEach(function (p) { ["A", "B"].forEach(function (side) {
      const m = p.item[side];
      if (m.video) mediaFiles.video.push(m.video); else if (m.audio) mediaFiles.audio.push(m.audio);
      if (m.score && !m.video) mediaFiles.images.push(m.score);
    }); });
    if (M.sound_check && M.sound_check.audio) mediaFiles.audio.push(M.sound_check.audio);

    const timeline = [];

    // 1. consent
    timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: '<div class="consent">' + (M.consent_html || defaultConsent(M)) + '</div>',
      choices: ["I agree, start"],
      on_finish: function () { send({ kind: "session_start", experiment: M.experiment, session: sessionId, manifest_version: M.built, n_items: nTotal, n_remaining: remaining.length, user_agent: navigator.userAgent, screen: screen.width + "x" + screen.height }); },
    });

    // 2. background questionnaire (skipped on resume)
    if (remaining.length === nTotal) timeline.push({
      type: jsPsychSurveyHtmlForm,
      preamble: "<h2>About you</h2><p class='hint'>Two minutes. This is used only to describe the group of listeners.</p>",
      html: questionnaireHtml(),
      button_label: "Continue",
      on_finish: function (d) { send({ kind: "questionnaire", experiment: M.experiment, session: sessionId, answers: JSON.stringify(d.response) }); },
    });

    // 3. preload
    timeline.push({
      type: jsPsychPreload, audio: mediaFiles.audio, video: mediaFiles.video, images: mediaFiles.images,
      show_progress_bar: true, message: "<p>Loading the music (this can take a minute)...</p>", continue_after_error: true, max_load_time: 300000,
      on_finish: function (d) { const f = [].concat(d.failed_audio || [], d.failed_video || [], d.failed_images || []); if (f.length) send({ kind: "preload_error", experiment: M.experiment, session: sessionId, failed: f.join(" ") }); },
    });

    // 4. sound check
    if (M.sound_check && M.sound_check.audio) timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: '<div class="instructions"><h2>Sound check</h2><p>Please use headphones or good speakers in a quiet room. Play this clip and set a comfortable volume; keep it there for the whole study.</p><audio controls src="' + esc(M.sound_check.audio) + '"></audio></div>',
      choices: ["The sound is fine"],
    });

    // 5. instructions
    timeline.push({
      type: jsPsychInstructions, pages: ['<div class="instructions">' + (M.instructions_html || "") + '</div>'],
      show_clickable_nav: true, button_label_next: "Begin", allow_backward: false,
    });

    // 6. trials
    remaining.forEach(function (p, k) {
      const it = p.item;
      const slots = p.flipped ? ["B", "A"] : ["A", "B"]; // slot 0 = "Solo 1"
      const trialData = {};
      function finishItem() {
        send(trialData.row);
        done.add(it.id); lsSet(doneKey, Array.from(done));
        jsPsych.progressBar.progress = done.size / nTotal;
      }
      timeline.push({
        type: jsPsychHtmlButtonResponse,
        stimulus: pairHtml(it, slots, M, p.pos, nTotal),
        choices: ["Solo 1", "Solo 2"],
        prompt: '<p class="hint">' + (CFG.requireFullListen ? "Listen to both solos to the end, then choose. You may replay them." : "You may replay the solos.") + '</p>',
        on_load: function () {
          const media = Array.prototype.slice.call(document.querySelectorAll(".clip video, .clip audio"));
          const btns = Array.prototype.slice.call(document.querySelectorAll("#jspsych-html-button-response-btngroup button"));
          const ended = [false, false], plays = [0, 0], events = [];
          const tStart = performance.now();
          function ev(name, i, el) { events.push([Math.round(performance.now() - tStart), name, i, +el.currentTime.toFixed(2)]); }
          if (CFG.requireFullListen) btns.forEach(function (b) { b.disabled = true; });
          media.forEach(function (el, i) {
            el.addEventListener("play", function () { plays[i]++; ev("play", i, el); media.forEach(function (o, j) { if (j !== i && !o.paused) o.pause(); }); });
            el.addEventListener("pause", function () { ev("pause", i, el); });
            el.addEventListener("seeked", function () { ev("seek", i, el); });
            el.addEventListener("ended", function () {
              ended[i] = true; const c = el.closest(".clip"); c.classList.add("done"); c.querySelector(".status").textContent = "heard to the end";
              ev("ended", i, el);
              if (ended[0] && ended[1]) btns.forEach(function (b) { b.disabled = false; });
            });
          });
          trialData.getStats = function () { return { plays: plays.slice(), events: events, listened_both: ended[0] && ended[1] }; };
        },
        on_finish: function (d) {
          const st = trialData.getStats ? trialData.getStats() : {};
          d.item_id = it.id; d.chosen_slot = d.response; d.chosen_side = slots[d.response]; d.flipped = p.flipped;
          trialData.row = { kind: "trial", experiment: M.experiment, session: sessionId, item_id: it.id, tune: it.tune || "", trial_index: p.pos, presented_index: k,
            chosen_slot: d.response + 1, chosen_side: d.chosen_side, slot1_side: slots[0], slot2_side: slots[1], rt_ms: Math.round(d.rt),
            plays_slot1: st.plays ? st.plays[0] : null, plays_slot2: st.plays ? st.plays[1] : null, listened_both: !!st.listened_both, events: JSON.stringify(st.events || []) };
          if (!CFG.askConfidence) finishItem();
        },
      });
      if (CFG.askConfidence) timeline.push({
        type: jsPsychHtmlButtonResponse,
        stimulus: '<p class="question">How sure are you?</p>',
        choices: ["Just a guess", "Fairly sure", "Very sure"],
        on_finish: function (d) { trialData.row.confidence = d.response + 1; trialData.row.confidence_rt_ms = Math.round(d.rt); d.item_id = it.id; d.confidence = d.response + 1; finishItem(); },
      });
    });

    // 7. end
    timeline.push({
      type: jsPsychCallFunction, async: true,
      func: async function (cb) {
        send({ kind: "session_end", experiment: M.experiment, session: sessionId, n_done: done.size, n_items: nTotal, duration_s: Math.round((Date.now() - t0) / 1000), send_failures: sendFailures });
        for (let i = 0; i < 5 && queue.length; i++) { await flush(); if (queue.length) await new Promise(function (r) { setTimeout(r, 1500); }); }
        cb();
      },
    });
    function endChoices() { return queue.length ? ["Retry", "Download answers"] : (CFG.collectorUrl ? ["Close"] : ["Download answers"]); }
    timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: function () {
        const code = (hash32("done|" + M.experiment + "|" + sessionId + "|" + raterId) % 1000000).toString().padStart(6, "0");
        let s = '<div class="instructions"><h2>Thank you!</h2><p>You have completed this session.</p><p>Your completion code: <span class="code">' + code + '</span></p>';
        if (queue.length) s += '<p class="error">Some answers could not be sent (' + queue.length + '). Please click Retry in a moment, or download your answers and email them to ' + esc(CFG.contact) + '.</p>';
        else if (CFG.collectorUrl) s += '<p class="hint">All answers were saved.</p>';
        else s += '<p class="hint">Pilot mode: no collector configured. Download the answers below.</p>';
        return s + '</div>';
      },
      choices: endChoices,
      on_finish: function (d) {
        const labels = endChoices();
        if (labels[d.response] === "Download answers") jsPsych.data.get().localSave("json", "listening_" + M.experiment + "_" + raterId + ".json");
        if (labels[d.response] === "Retry") { flush(); location.reload(); }
      },
    });

    jsPsych.data.addProperties({ rater: raterId, experiment: M.experiment, session: sessionId });
    jsPsych.run(timeline);
  }

  // ---------- HTML pieces ----------
  function pairHtml(it, slots, M, pos, nTotal) {
    function clip(label, m) {
      let player;
      if (m.video) player = '<video controls preload="auto" playsinline controlsList="nodownload noplaybackrate" disablePictureInPicture src="' + esc(m.video) + '"></video>';
      else player = (m.score ? '<img src="' + esc(m.score) + '" alt="score">' : "") + '<audio controls preload="auto" controlsList="nodownload noplaybackrate" src="' + esc(m.audio) + '"></audio>';
      return '<div class="clip"><h3>' + label + '</h3>' + player + '<div class="status"></div></div>';
    }
    return '<div class="progress">Pair ' + (pos + 1) + ' of ' + nTotal + '</div>' +
      '<p class="question">' + esc(M.question) + '</p>' +
      '<div class="pair">' + clip("Solo 1", it[slots[0]]) + clip("Solo 2", it[slots[1]]) + '</div>';
  }

  function questionnaireHtml() {
    function opt(name, opts, req) { return '<select name="' + name + '"' + (req ? " required" : "") + '><option value="">choose...</option>' + opts.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join("") + '</select>'; }
    return '<form class="qform" id="qf">' +
      '<label>How would you describe your relationship to jazz?</label>' + opt("jazz_role", ["Professional jazz musician", "Jazz student (conservatory / academy)", "Amateur jazz player", "Serious listener (I do not play)", "Casual listener"], true) +
      '<label>Main instrument (if you play)</label><input type="text" name="instrument" placeholder="e.g. tenor sax, piano, none">' +
      '<label>Years playing jazz</label><input type="number" name="years_playing" min="0" max="80" step="1" value="0">' +
      '<label>Hours per week you listen to jazz</label>' + opt("listening_hours", ["Less than 1", "1-3", "3-10", "More than 10"], true) +
      '<label>Formal training in jazz improvisation or jazz theory</label>' + opt("training", ["None", "Some lessons / self-taught", "Several years", "Degree-level"], true) +
      '<label>Age group</label>' + opt("age", ["18-24", "25-34", "35-44", "45-54", "55+"], false) +
      '<label>How are you listening?</label>' + opt("playback", ["Headphones", "External speakers", "Laptop / phone speakers"], true) +
      '</form>';
  }

  function defaultConsent(M) {
    return '<h2>' + esc(M.title || "Jazz listening study") + '</h2>' +
      '<p>You will hear pairs of short jazz solo excerpts (about 30 seconds each) played by the same synthesised instrument over a rhythm section. After each pair you answer one question by clicking a button. One session takes about 30-40 minutes. Answer by ear; there are no consequences for you either way.</p>' +
      '<p>We record your answers, your response times and how you used the players. We do not record your name. Your participant id is the code in your link. You may stop at any time by closing the tab; if you reopen the same link, the study continues where you left off.</p>' +
      '<p>Questions: ' + esc(CFG.contact) + '.</p>';
  }
})();
