// Deployment configuration. Edit here, then run human_evaluation/deploy.sh.
window.SURVEY_CONFIG = {
  // Apps Script web-app URL (Deploy > New deployment > Web app, access: Anyone). Empty = responses are
  // only kept in the browser and shown as JSON at the end (pilot mode).
  collectorUrl: "",
  // manifest.json written by build_items_*.py; describes the experiment, items and sessions.
  manifestUrl: "manifest.json",
  // Require both excerpts to be played to the end before the choice buttons are enabled.
  requireFullListen: false,
  // Show a "Skip for now" button on the About-you page (pilot only; set false for the real study).
  questionnaireSkippable: true,
  // Shuffle items within a part and swap pair sides for half of them, per rater. false = manifest order, A always Solo 1.
  randomize: false,
  // Ask for a confidence rating after each choice.
  askConfidence: false,
  // Contact shown on the consent page.
  contact: "almog.alg@gmail.com",
};
