// Applied before first paint so the saved theme does not flash.
try {
  var saved = localStorage.getItem("aidlc-tracker:theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  else if (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "light";
} catch (e) { /* storage blocked: keep the default */ }
