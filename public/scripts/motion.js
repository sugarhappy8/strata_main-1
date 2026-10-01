/* Optional progressive enhancement: no content depends on animation. The iOS app has no scroll reveals or scroll
   progress bar; its screens arrive through view transitions instead (app-mode.css). */
(() => {
  "use strict";
  if (window.StrataApp || !window.matchMedia || !("IntersectionObserver" in window)) return;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const selector = [
    "[data-reveal]",
    ".home-page .section-heading",
    ".method-intro",
    ".score-model",
    ".editorial-grid",
    ".source-grid",
    ".week-toolbar",
    ".plus-studio .feature-grid",
    ".account-intro",
    ".account-access",
    ".info-hero-grid",
    ".pricing-grid",
    ".contact-grid",
    ".policy-card-grid",
    ".policy-founder",
    ".device-grid",
    ".help-grid",
    ".offline-shell",
    ".workout-page .start-panel",
    ".workout-page .history-section",
    ".admin-hero",
    ".admin-section"
  ].join(",");
  const root = document.documentElement;
  let targets=[];
  let observer;
  let progress;
  let progressFrame=0;
  function updateProgress() {
    progressFrame=0;
    if(!progress)return;
    const range=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
    const amount=range>0?Math.min(1,Math.max(0,window.scrollY/range)):0;
    progress.style.transform=`scaleX(${amount})`;
    progress.dataset.active=range>120?"true":"false";
  }
  function requestProgressUpdate() {
    if(progressFrame)return;
    progressFrame=requestAnimationFrame(updateProgress);
  }
  function initializeProgress() {
    progress=document.createElement("div");
    progress.className="strata-scroll-progress";
    progress.setAttribute("aria-hidden","true");
    document.body.append(progress);
    window.addEventListener("scroll",requestProgressUpdate,{passive:true});
    window.addEventListener("resize",requestProgressUpdate,{passive:true});
    updateProgress();
  }
  if (!preference.matches) root.classList.add("motion-ready");
  function syncMotion() {
    observer?.disconnect();
    if (preference.matches) {
      root.classList.remove("motion-ready");
      return;
    }
    root.classList.add("motion-ready");
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("motion-enter");
        observer.unobserve(entry.target);
      });
    }, {threshold: .08, rootMargin: "0px 0px -6%"});
    targets.forEach((target) => {
      if (!target.classList.contains("motion-enter")) observer.observe(target);
    });
  }
  function initialize() {
    targets=[...document.querySelectorAll(selector)];
    initializeProgress();
    syncMotion();
  }
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",initialize,{once:true});
  else initialize();
  preference.addEventListener?.("change", syncMotion);
  window.addEventListener("pagehide", () => {
    observer?.disconnect();
    if(progressFrame)cancelAnimationFrame(progressFrame);
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) { syncMotion(); updateProgress(); } });
})();
