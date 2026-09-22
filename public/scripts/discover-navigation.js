/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverNavigation=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createToastController(element,{duration=2200,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    let timer=null;
    function hide(){
      if(timer!==null)clearTimer(timer);
      timer=null;element?.classList.remove("show");
    }
    function show(message){
      if(!element)return;
      element.textContent=String(message||"");element.classList.add("show");
      if(timer!==null)clearTimer(timer);
      timer=setTimer(hide,duration);
    }
    return{hide,show};
  }

  function createFeatureNavigation({config,defaultFeature,state,document,window,onActivate=()=>{},onDestinationChange=()=>{}}){
    let historyQueued=false;
    const element=(id)=>document.getElementById(id);
    function featureName(value){
      const raw=String(value||"").replace(/^#/,"");
      if(Object.hasOwn(config,raw))return raw;
      return Object.keys(config).find((name)=>config[name].panelId===raw)||null;
    }
    function featureFromLocation(){
      const raw=String(globalThis.location?.hash||"").replace(/^#/,"");
      try{return featureName(decodeURIComponent(raw));}catch{return featureName(raw);}
    }
    function featurePanel(name){const item=config[name];return item?element(item.panelId):null;}
    function featureHash(name){return `#${config[name].panelId}`;}
    function updateFeatureHistory(name,mode){
      if(mode!=="push"&&mode!=="replace")return;
      const hash=featureHash(name);
      if(String(globalThis.location?.hash||"")===hash)return;
      const method=mode==="push"?"pushState":"replaceState";
      globalThis.history?.[method]?.({feature:name},"",hash);
    }
    function revealDestination(link,{smooth=false}={}){
      const nav=link?.parentElement;
      if(!nav||Number(nav.scrollWidth)<=Number(nav.clientWidth))return;
      const current=Number(nav.scrollLeft)||0,start=Number(link.offsetLeft)||0,end=start+(Number(link.offsetWidth)||0),viewport=Number(nav.clientWidth)||0;
      const next=start<current?start:end>current+viewport?end-viewport:current;
      if(next===current)return;
      const reduceMotion=window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,options={left:Math.max(0,next),behavior:smooth&&!reduceMotion?"smooth":"auto"};
      if(typeof nav.scrollTo==="function")nav.scrollTo(options);else nav.scrollLeft=options.left;
    }
    function activate(value,{focus=false,scroll=false,smooth=false,announce=false,historyMode="none"}={}){
      const name=featureName(value)||defaultFeature,item=config[name],panel=featurePanel(name);
      if(!panel)return false;
      const changed=Boolean(state.activeFeature&&state.activeFeature!==name);
      if(changed)onDestinationChange(name,state.activeFeature);
      state.activeFeature=name;
      for(const candidate of Object.keys(config)){
        const candidatePanel=featurePanel(candidate);
        if(candidatePanel)candidatePanel.hidden=candidate!==name;
      }
      let activeDestination=null;
      for(const link of document.querySelectorAll("[data-feature-target]")){
        const target=featureName(link.dataset.featureTarget),active=target===name||(link.classList.contains("destination-link")&&target===item.parent);
        link.classList.toggle("active",active);
        link.setAttribute?.("aria-controls",config[target]?.panelId||"");
        link.setAttribute?.("aria-expanded",String(target===name));
        if(link.classList.contains("feature-block")||link.classList.contains("destination-link")){
          if(active)link.setAttribute?.("aria-current","location");else link.removeAttribute?.("aria-current");
        }
        if(active&&link.classList.contains("destination-link"))activeDestination=link;
      }
      const skip=element("activeWorkspaceSkip");if(skip){skip.setAttribute?.("href",`#${item.headingId}`);skip.textContent=`Skip to ${item.label}`;}
      document.body.dataset.activeFeature=name;updateFeatureHistory(name,historyMode);revealDestination(activeDestination,{smooth});
      if(announce&&element("featureStatus"))element("featureStatus").textContent=`${item.label} workspace opened.`;
      onActivate(name);
      if(scroll||focus){
        const move=()=>{
          const reduceMotion=window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
          if(scroll)panel.scrollIntoView?.({behavior:smooth&&!reduceMotion?"smooth":"instant",block:"start"});
          if(focus)element(item.headingId)?.focus?.({preventScroll:true});
        };
        if(typeof globalThis.requestAnimationFrame==="function")globalThis.requestAnimationFrame(move);else setTimeout(move,0);
      }
      return true;
    }
    function initialize(){
      const requested=featureFromLocation();
      activate(requested||defaultFeature,{scroll:Boolean(requested),historyMode:"none"});
    }
    function restore(){
      if(historyQueued)return;
      historyQueued=true;
      Promise.resolve().then(()=>{
        historyQueued=false;
        const rawHash=String(globalThis.location?.hash||"").replace(/^#/,"");
        if(rawHash==="featureHub")return;
        const requested=featureFromLocation();
        if(rawHash&&!requested)return;
        activate(requested||defaultFeature,{scroll:Boolean(requested)});
      });
    }
    function bindHistory(){window.addEventListener?.("popstate",restore);window.addEventListener?.("hashchange",restore);}
    return{activate,bindHistory,featureFromLocation,featureHash,featureName,featurePanel,initialize,restore,updateFeatureHistory};
  }

  return{createFeatureNavigation,createToastController};
});
