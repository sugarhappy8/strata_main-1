/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverState=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const GROUP_LABELS=Object.freeze({chest:"Chest",back:"Back",shoulders:"Shoulders",arms:"Arms",legs:"Legs",glutes:"Glutes",calves:"Calves",core:"Core"});
  const PREFERENCE_OPTIONS=Object.freeze({stable:"Stable setup","long-range":"Long-range friendly","simple-setup":"Simple setup",compound:"Compound lifts",isolation:"Isolation work"});
  const LIMITATION_OPTIONS=Object.freeze({"no-overhead":"Avoid overhead positions","no-deep-knee":"Avoid deep knee flexion","no-unsupported-hinge":"Avoid unsupported hinges","no-floor":"Avoid floor exercises","no-unilateral":"Avoid unilateral work"});
  const FEATURE_DEFAULT="today";
  const FEATURE_CONFIG=Object.freeze({
    today:Object.freeze({panelId:"todayWorkspace",headingId:"todayTitle",label:"Overview"}),
    plan:Object.freeze({panelId:"planWorkspace",headingId:"planWorkspaceTitle",label:"Plan"}),
    progress:Object.freeze({panelId:"progressWorkspace",headingId:"progressWorkspaceTitle",label:"Progress"}),
    explore:Object.freeze({panelId:"exploreWorkspace",headingId:"exploreWorkspaceTitle",label:"Exercises"}),
    nutrition:Object.freeze({panelId:"nutritionWorkspace",headingId:"nutritionWorkspaceTitle",label:"Nutrition"}),
    coaching:Object.freeze({panelId:"coachingWorkspace",headingId:"coachingWorkspaceTitle",label:"Personal setup",parent:"nutrition"}),
    recommendations:Object.freeze({panelId:"recommendations",headingId:"recommendationTitle",label:"Best exercises for you",parent:"explore"}),
    library:Object.freeze({panelId:"exerciseExplorer",headingId:"explorerTitle",label:"Exercise library",parent:"explore"}),
    battle:Object.freeze({panelId:"battle",headingId:"battleTitle",label:"Compare exercises",parent:"explore"}),
    profile:Object.freeze({panelId:"profile",headingId:"profileTitle",label:"Personalize recommendations",parent:"explore"}),
    community:Object.freeze({panelId:"communityPlans",headingId:"communityPlansTitle",label:"Browse community plans",parent:"plan"}),
    monthly:Object.freeze({panelId:"monthlyPlan",headingId:"monthlyPlanTitle",label:"Build a 31-day plan",parent:"plan"}),
    session:Object.freeze({panelId:"sessionBuilder",headingId:"sessionBuilderTitle",label:"Build a session",parent:"plan"})
  });
  const LIMITS=Object.freeze({
    explorerDesktopPageSize:24,
    explorerMobilePageSize:12,
    searchDebounceMs:180,
    ratingsRefreshMinIntervalMs:15_000,
    communityPageSize:12,
    movementBoard:4
  });
  const MOVEMENT_BOARD_STORAGE_PREFIX="strata_plus_movement_board_v1";

  function createState(){
    return{
      exercises:[],methodology:null,sources:[],limited:new Set(),preferences:null,user:null,csrfToken:"",
      aggregate:new Map(),userRatings:new Map(),ratingsRefreshedAt:0,ratingsRefreshPromise:null,ratingSaving:new Set(),
      compare:[],shortlist:[],collection:"all",query:"",group:"all",equipment:"all",pattern:"all",level:"all",sort:"personal",
      recommendations:[],activeExercise:null,activeFeature:null,explorerLimit:LIMITS.explorerDesktopPageSize,explorerSearchTimer:null,
      weeklyPlan:null,weeklyPlanUpdatedAt:0,workouts:[],workoutHistoryAvailable:false,workoutHistoryHasMore:false,
      workoutHistoryStatus:"loading",workoutHistoryError:"",
      trainingBlock:null,trainingBlockRevision:0,trainingBlockAction:null,progressionSuggestion:null,
      session:null,sessionSaving:false,sessionDayInitialized:false,
      monthlyPlan:null,monthlyPlanUpdatedAt:0,monthlySchedule:null,monthlySource:"muscle-schedule",
      communityPlans:[],communityLoaded:false,communityLoading:false,communityError:"",communityNextOffset:0,communityQuery:"",
      communityPendingId:null,communityAppliedId:null,communityAppliedUpdatedAt:0
    };
  }

  return{FEATURE_CONFIG,FEATURE_DEFAULT,GROUP_LABELS,LIMITATION_OPTIONS,LIMITS,MOVEMENT_BOARD_STORAGE_PREFIX,PREFERENCE_OPTIONS,createState};
});
