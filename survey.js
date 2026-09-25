/* Multi-part listening study (NotaGen Part I, human arm).
 * Static page: jsPsych 8 from a CDN, structure and items from manifest.json, responses POSTed to an Apps Script collector.
 * URL: index.html?r=<rater id>[&s=<session id>]
 *
 * manifest.parts[] = { id, title, intro_html, question, layout: "pair"|"single", choices: [labels],
 *                      leadsheet: bool, items: [...] }
 *   pair item:   { id, tune, A: {audio, video?}, B: {audio, video?}, leadsheet?: {image} }
 *   single item: { id, tune, clip: {audio, video?}, leadsheet?: {image} }
 * Pair items are shown as "Solo 1"/"Solo 2"; half of them per rater are shown swapped (recorded as slot1_side).
 * When a part's choices are exactly ["Solo 1","Solo 2"] the response also records chosen_side (A/B).
 */
(function () {
  "use strict";
  const CFG = window.SURVEY_CONFIG;
  const params = new URLSearchParams(location.search);
  const raterId = (params.get("r") || "").trim();
  const t0 = Date.now();

  // ---------- small utilities ----------
  function hash32(str) {
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
    row.uid = raterId + ":" + row.kind + ":" + (row.item_id || row.session || "") + ":" + (row.part || "") + ":" + (row.rev || "");
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
    const sessionId = params.get("s") || M.default_session || (M.sessions ? Object.keys(M.sessions)[0] : "all");
    const allowed = M.sessions && M.sessions[sessionId] ? new Set(M.sessions[sessionId]) : null;
    if (M.sessions && !allowed) { fatal("Unknown session '" + sessionId + "'."); return; }
    const rnd = mulberry32(hash32(M.experiment + "|" + sessionId + "|" + raterId));
    function navKey() { return "ls_nav_" + M.experiment + "_" + sessionId + "_" + raterId; }
    const saved = lsGet(navKey(), { step: 0, answers: {} });
    const done = new Set(Object.keys(saved.answers || {}));

    // per-rater plan: parts in manifest order, items shuffled within a part, pair sides flipped for half of them
    const plan = [];
    M.parts.forEach(function (part) {
      const items = part.items.filter(function (it) { return !allowed || allowed.has(it.id); });
      const order = shuffle(items, rnd);
      const flips = shuffle(order.map(function (_, i) { return i < Math.floor(order.length / 2); }), rnd);
      plan.push({ part: part, trials: order.map(function (it, i) { return { item: it, flipped: part.layout === "pair" && flips[i] }; }) });
    });
    const nTotal = plan.reduce(function (n, p) { return n + p.trials.length; }, 0);
    const nRemaining = plan.reduce(function (n, p) { return n + p.trials.filter(function (t) { return !done.has(t.item.id); }).length; }, 0);

    const media = { audio: [], video: [], images: [] };
    function addClip(m) { if (!m) return; if (m.video) media.video.push(m.video); else if (m.audio) media.audio.push(m.audio); if (m.score && !m.video) media.images.push(m.score); }
    plan.forEach(function (p) { p.trials.forEach(function (t) {
      addClip(t.item.A); addClip(t.item.B); addClip(t.item.clip);
      if (t.item.leadsheet && t.item.leadsheet.image) media.images.push(t.item.leadsheet.image);
    }); });
    if (M.sound_check && M.sound_check.audio) media.audio.push(M.sound_check.audio);

    const timeline = [];
    let pos = 0;

    // consent
    timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: '<div class="consent">' + (M.consent_html || defaultConsent(M)) + '</div>',
      choices: ["I agree, start"],
      on_finish: function () { send({ kind: "session_start", experiment: M.experiment, session: sessionId, manifest_version: M.built, n_items: nTotal, n_remaining: nRemaining, user_agent: navigator.userAgent, screen: screen.width + "x" + screen.height }); },
    });
    // background questionnaire (skipped on resume)
    if (nRemaining === nTotal) timeline.push({
      type: jsPsychSurveyHtmlForm,
      preamble: "<h2>About you</h2><p class='hint'>Two minutes. This is used only to describe the group of listeners.</p>",
      html: questionnaireHtml(),
      button_label: "Continue",
      on_load: function () {
        if (!CFG.questionnaireSkippable) return;
        const next = document.querySelector("#jspsych-survey-html-form-next");
        if (!next) return;
        const skip = document.createElement("button");
        skip.type = "button"; skip.className = "jspsych-btn"; skip.textContent = "Skip for now"; skip.style.marginLeft = "12px";
        skip.addEventListener("click", function () { jsPsych.finishTrial({ response: { skipped: true }, rt: null }); });
        next.parentNode.insertBefore(skip, next.nextSibling);
      },
      on_finish: function (d) { send({ kind: "questionnaire", experiment: M.experiment, session: sessionId, answers: JSON.stringify(d.response) }); },
    });
    // preload
    timeline.push({
      type: jsPsychPreload, audio: media.audio, video: media.video, images: media.images,
      show_progress_bar: true, message: "<p>Loading the music (this can take a minute)...</p>", continue_after_error: true, max_load_time: 300000,
      on_finish: function (d) { const f = [].concat(d.failed_audio || [], d.failed_video || [], d.failed_images || []); if (f.length) send({ kind: "preload_error", experiment: M.experiment, session: sessionId, failed: f.join(" ") }); },
    });
    if (M.sound_check && M.sound_check.audio) timeline.push({
      type: jsPsychHtmlButtonResponse,
      stimulus: '<div class="instructions"><h2>Sound check</h2><p>Please use headphones or good speakers in a quiet room. Play this clip and set a comfortable volume; keep it there for the whole study.</p><audio controls src="' + esc(M.sound_check.audio) + '"></audio></div>',
      choices: ["The sound is fine"],
    });
    if (M.instructions_html) timeline.push({
      type: jsPsychInstructions, pages: ['<div class="instructions">' + M.instructions_html + '</div>'],
      show_clickable_nav: true, button_label_next: "Begin", allow_backward: false,
    });

    // parts: a navigator with Back / Next (jsPsych timelines are forward-only), run as one async trial
    const steps = [];
    let nPos = 0;
    plan.forEach(function (p, pi) {
      steps.push({ type: "intro", part: p.part, index: pi });
      p.trials.forEach(function (t) { steps.push({ type: "trial", part: p.part, item: t.item, slots: t.flipped ? ["B", "A"] : ["A", "B"], pos: nPos++ }); });
    });
    const nav = lsGet(navKey(), { step: 0, answers: {} });
    if (nav.step >= steps.length) nav.step = 0;
    timeline.push({ type: jsPsychCallFunction, async: true, func: function (cb) { runNavigator(M, sessionId, steps, nav, navKey(), nTotal, plan.length, cb); } });

    // end
    timeline.push({
      type: jsPsychCallFunction, async: true,
      func: async function (cb) {
        send({ kind: "session_end", experiment: M.experiment, session: sessionId, n_done: Object.keys(lsGet(navKey(), { answers: {} }).answers).length, n_items: nTotal, duration_s: Math.round((Date.now() - t0) / 1000), send_failures: sendFailures });
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


  // ---------- navigator (Back / Next over intro pages and questions) ----------
  function runNavigator(M, sessionId, steps, nav, key, nTotal, nParts, cb) {
    const root = jsPsych.getDisplayElement();
    let shownAt = 0, stats = null;
    function save() { lsSet(key, nav); }
    function progress() { jsPsych.progressBar.progress = Object.keys(nav.answers).length / nTotal; }
    function go(i) {
      nav.step = Math.max(0, Math.min(i, steps.length)); save();
      if (nav.step >= steps.length) { root.innerHTML = ""; cb(); return; }
      render();
    }
    function record(st, i) {
      const prev = nav.answers[st.item.id];
      const rev = prev ? (prev.rev || 1) + 1 : 1;
      const s = stats ? stats() : {};
      nav.answers[st.item.id] = { choice_index: i, rev: rev }; save(); progress();
      const part = st.part, slots = st.slots;
      const isSideChoice = part.layout === "pair" && part.choices.length === 2 && /^solo 1$/i.test(part.choices[0]);
      const row = { kind: "trial", experiment: M.experiment, session: sessionId, part: part.id, item_id: st.item.id, tune: st.item.tune || "", layout: part.layout,
        trial_index: st.pos, choice_index: i, choice_label: part.choices[i], rev: rev, rt_ms: Math.round(performance.now() - shownAt),
        plays: JSON.stringify(s.plays || []), listened_all: !!s.listened_all, events: JSON.stringify(s.events || []) };
      if (part.layout === "pair") { row.slot1_side = slots[0]; row.slot2_side = slots[1]; row.chosen_side = isSideChoice ? slots[i] : ""; }
      send(row);
    }
    function render() {
      const st = steps[nav.step];
      const last = nav.step === steps.length - 1;
      let html = '<div class="nav-screen">', canNext, nextLabel;
      if (st.type === "intro") {
        html += '<div class="instructions"><p class="hint">Part ' + (st.index + 1) + ' of ' + nParts + '</p><h2>' + esc(st.part.title) + '</h2>' + (st.part.intro_html || "") + '<p class="hint">' + st.part.items.length + ' questions.</p></div>';
        canNext = true; nextLabel = "Start part";
      } else {
        const ans = nav.answers[st.item.id];
        html += trialHtml(st.part, st.item, st.slots, st.pos, nTotal);
        html += '<div class="choices">' + st.part.choices.map(function (c, i) { return '<button class="jspsych-btn choice' + (ans && ans.choice_index === i ? ' selected' : '') + '" data-i="' + i + '">' + esc(c) + '</button>'; }).join("") + '</div>';
        html += '<p class="hint">You may replay the music as often as you like. Choosing an answer moves on; you can come back and change it.</p>';
        canNext = !!ans; nextLabel = last ? "Finish" : "Next";
      }
      html += '<div class="navbar"><button class="jspsych-btn nav" id="nav-back"' + (nav.step === 0 ? ' disabled' : '') + '>&#8592; Back</button>' +
        '<button class="jspsych-btn nav" id="nav-next"' + (canNext ? '' : ' disabled') + '>' + nextLabel + ' &#8594;</button></div></div>';
      root.innerHTML = html;
      shownAt = performance.now();
      // media bookkeeping
      const els = Array.prototype.slice.call(root.querySelectorAll(".clip video, .clip audio"));
      const ended = els.map(function () { return false; }), plays = els.map(function () { return 0; }), events = [];
      function ev(name, i, el) { events.push([Math.round(performance.now() - shownAt), name, i, +el.currentTime.toFixed(2)]); }
      els.forEach(function (el, i) {
        el.addEventListener("play", function () { plays[i]++; ev("play", i, el); els.forEach(function (o, j) { if (j !== i && !o.paused) o.pause(); }); });
        el.addEventListener("pause", function () { ev("pause", i, el); });
        el.addEventListener("seeked", function () { ev("seek", i, el); });
        el.addEventListener("ended", function () { ended[i] = true; ev("ended", i, el); });
      });
      stats = function () { return { plays: plays.slice(), events: events, listened_all: ended.every(Boolean) }; };
      // buttons
      root.querySelectorAll("button.choice").forEach(function (b) { b.addEventListener("click", function () { record(st, +b.getAttribute("data-i")); go(nav.step + 1); }); });
      root.querySelector("#nav-back").addEventListener("click", function () { go(nav.step - 1); });
      root.querySelector("#nav-next").addEventListener("click", function () { go(nav.step + 1); });
      window.scrollTo(0, 0);
    }
    progress();
    render();
  }

  // ---------- HTML pieces ----------
  function player(m) {
    if (m.video) return '<video controls preload="auto" playsinline controlsList="nodownload noplaybackrate" disablePictureInPicture src="' + esc(m.video) + '"></video>';
    return (m.score ? '<img src="' + esc(m.score) + '" alt="score">' : "") + '<audio controls preload="auto" controlsList="nodownload noplaybackrate" src="' + esc(m.audio) + '"></audio>';
  }
  function clip(label, m) { return '<div class="clip"><h3>' + label + '</h3>' + player(m) + '<div class="status"></div></div>'; }
  function leadsheetHtml(it) {
    if (!it.leadsheet) return "";
    return '<div class="leadsheet"><h3>Lead sheet</h3>' + (it.leadsheet.image ? '<img src="' + esc(it.leadsheet.image) + '" alt="lead sheet">' : "") +
      (it.leadsheet.audio ? '<audio controls preload="auto" src="' + esc(it.leadsheet.audio) + '"></audio>' : "") + '</div>';
  }
  function trialHtml(part, it, slots, pos, nTotal) {
    let body;
    if (part.layout === "pair") body = '<div class="pair">' + clip("Solo 1", it[slots[0]]) + clip("Solo 2", it[slots[1]]) + '</div>';
    else body = '<div class="pair single">' + clip("Solo", it.clip) + '</div>';
    return '<div class="progress">' + (pos + 1) + ' of ' + nTotal + '</div>' + (part.leadsheet ? leadsheetHtml(it) : "") +
      '<p class="question">' + esc(part.question) + '</p>' + body;
  }

  function questionnaireHtml() {
    function opt(name, opts, req) { return '<select name="' + name + '"' + (req ? " required" : "") + '><option value="">choose...</option>' + opts.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join("") + '</select>'; }
    return '<div class="qform">' +
      '<label>How would you describe your relationship to jazz?</label>' + opt("jazz_role", ["Professional jazz musician", "Jazz student (conservatory / academy)", "Amateur jazz player", "Serious listener (I do not play)", "Casual listener"], true) +
      '<label>Main instrument (if you play)</label><input type="text" name="instrument" placeholder="e.g. tenor sax, piano, none">' +
      '<label>Years playing jazz</label><input type="number" name="years_playing" min="0" max="80" step="1" value="0">' +
      '<label>Hours per week you listen to jazz</label>' + opt("listening_hours", ["Less than 1", "1-3", "3-10", "More than 10"], true) +
      '<label>Formal training in jazz improvisation or jazz theory</label>' + opt("training", ["None", "Some lessons / self-taught", "Several years", "Degree-level"], true) +
      '<label>Age group</label>' + opt("age", ["18-24", "25-34", "35-44", "45-54", "55+"], false) +
      '<label>How are you listening?</label>' + opt("playback", ["Headphones", "External speakers", "Laptop / phone speakers"], true) +
      '</div>';
  }

  function defaultConsent(M) {
    return '<h2>' + esc(M.title || "Jazz listening study") + '</h2>' +
      '<p>You will hear short jazz solo excerpts (about 30 seconds each) played by the same synthesised instrument over a rhythm section, and answer one question about each. The study has several short parts; each part explains its question. One session takes about 30-40 minutes. Answer by ear.</p>' +
      '<p>We record your answers, your response times and how you used the players. We do not record your name. Your participant id is the code in your link. You may stop at any time by closing the tab; if you reopen the same link, the study continues where you left off.</p>' +
      '<p>Questions: ' + esc(CFG.contact) + '.</p>';
  }
})();
