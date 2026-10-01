"use strict";

(() => {
  const retryButton=document.getElementById("offlineRetry");
  const backLink=document.getElementById("offlineBack");
  const status=document.getElementById("offlineStatus");

  retryButton?.addEventListener("click",() => {
    retryButton.disabled=true;
    if(status)status.textContent="Trying this page again…";
    location.reload();
  });

  backLink?.addEventListener("click",(event) => {
    if(history.length<=1)return;
    event.preventDefault();
    history.back();
  });

  // A workout started online keeps a context on this device; offline, /workout.html opens the offline logger.
  const workoutLink=document.getElementById("offlineWorkout");
  try{
    if(workoutLink&&localStorage.getItem("strata_workout_offline_context_v1"))workoutLink.hidden=false;
  }catch{}

  window.addEventListener("online",() => {
    if(status)status.textContent="You’re back online. Try this page again to continue.";
  });
})();
