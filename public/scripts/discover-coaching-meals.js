/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverCoachingMeals=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const escape=(value)=>String(value??"").replace(/[&<>'"]/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[character]));
  const title=(value)=>String(value||"").replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase());

  function createController({document,element,api,state,ui,assertAccountResponse,onAccountError}){
    const el=element,data={profile:null,week:null,logs:[],date:"",request:0,bound:false};
    const surfaces=()=>["coachingFood"].map((prefix)=>({prefix,status:el(`${prefix}Status`),remaining:el(`${prefix}Remaining`),options:el(`${prefix}Options`),refresh:el(`${prefix}Refresh`)}));
    const selected=(name)=>[...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input)=>input.value);
    function preferenceNode(field){return {allergyStatus:el("mealAllergyNone"),allergens:document.querySelector('input[name="mealAllergen"]'),otherAllergies:el("mealOtherAllergies"),dietaryPattern:el("mealDietaryPattern"),dietaryRequirements:el("mealDietGlutenFree"),favoriteFoods:document.querySelector('input[name="mealFavorite"]'),mealsPerDay:el("mealMealsPerDay"),dailyBudgetUsd:el("mealDailyBudget")}[field]||null;}
    function updateAllergyFields(){
      const status=document.querySelector('input[name="mealAllergyStatus"]:checked')?.value||"",listed=status==="listed",other=status==="other_or_unsure";
      document.querySelectorAll('input[name="mealAllergen"]').forEach((input)=>{input.disabled=!listed&&!other;if(status==="none_known")input.checked=false;});
      el("mealOtherAllergies").disabled=!other;if(!other)el("mealOtherAllergies").value="";
    }
    function fillPreferences(profile){
      const preferences=profile?.mealPreferences||null;el("mealDietaryPattern").value=preferences?.dietaryPattern||"omnivore";el("mealMealsPerDay").value=String(preferences?.mealsPerDay||3);el("mealDailyBudget").value=preferences?.dailyBudgetCents==null?"":(preferences.dailyBudgetCents/100).toFixed(2);
      for(const id of ["mealAllergyNone","mealAllergyListed","mealAllergyOther"])el(id).checked=el(id).value===(preferences?.allergyStatus||"");
      const requirements=new Set(preferences?.dietaryRequirements||[]),allergens=new Set(preferences?.allergens||[]),favorites=new Set(preferences?.favoriteFoods||[]);el("mealDietGlutenFree").checked=requirements.has("gluten_free");el("mealDietDairyFree").checked=requirements.has("dairy_free");
      document.querySelectorAll('input[name="mealAllergen"]').forEach((input)=>{input.checked=allergens.has(input.value);});document.querySelectorAll('input[name="mealFavorite"]').forEach((input)=>{input.checked=favorites.has(input.value);});el("mealOtherAllergies").value=preferences?.otherAllergies||"";updateAllergyFields();
    }
    function profileInput(){
      const status=document.querySelector('input[name="mealAllergyStatus"]:checked')?.value||"",result=ui.normalizeMealPreferencesDraft({allergyStatus:status,allergens:selected("mealAllergen"),otherAllergies:el("mealOtherAllergies").value,dietaryPattern:el("mealDietaryPattern").value,dietaryRequirements:selected("dietaryRequirements"),favoriteFoods:selected("mealFavorite"),mealsPerDay:el("mealMealsPerDay").value,dailyBudgetUsd:el("mealDailyBudget").value});
      return{mealPreferences:result.payload.mealPreferences,errors:result.errors.map((error)=>({node:preferenceNode(error.field),message:error.message}))};
    }
    function context(){const target=(data.week?.nutrition?.dailyTargets||[]).find((entry)=>entry.date===data.date)||null,log=data.logs.find((entry)=>entry.date===data.date)||null;return{target,log};}
    function unavailableForDate(){data.request+=1;renderRemaining(null);for(const surface of surfaces()){surface.options.textContent="";surface.options.setAttribute("aria-busy","false");surface.status.textContent="Meal suggestions use the current coaching week. Historical intake can still be logged or corrected without meal suggestions.";surface.refresh.disabled=true;}}
    function renderRemaining(remaining){
      for(const surface of surfaces()){
        const values=[ui.formatCalories(remaining?.calories),ui.formatGrams(remaining?.proteinG),ui.formatGrams(remaining?.carbsG),ui.formatGrams(remaining?.fatG)];[...surface.remaining.querySelectorAll("dd")].forEach((node,index)=>{node.textContent=values[index]||"—";});surface.remaining.querySelectorAll("[data-meal-macro]").forEach((node)=>{node.hidden=remaining?.proteinG==null;});
      }
    }
    function mealCard(option,index){
      const favoriteCount=option.meals.reduce((sum,meal)=>sum+meal.favoriteMatches.length,0),budget=option.withinEnteredBudget===null?"No budget entered":option.withinEnteredBudget?"Menu estimate is within the entered daily budget":`${ui.formatUsd(Math.max(0,option.budgetDifferenceCents))} over the entered daily budget`,fit=ui.optionFitSummary(option),fitLabel=option.withinNutritionFit?"Approximate fit for the remaining plan":"Partial idea: review the differences below";
      const meals=option.meals.map((meal)=>`<li><strong>${escape(meal.name)}</strong><span>${escape(meal.portion)} · about ${ui.formatCalories(meal.calories)} · ${ui.formatUsd(meal.estimatedCostCents)}</span><small><b>Amounts for this portion:</b> ${escape(meal.ingredients.join(", "))}. ${escape(meal.servingBasis)}</small></li>`).join(""),allergens=[...new Set(option.meals.flatMap((meal)=>meal.allergens))];
      return `<li class="coaching-meal-card"><header><div><span class="kicker">Option ${index+1}</span><h6>${option.meals.length} meal${option.meals.length===1?"":"s"} for what remains</h6></div></header><p>${escape(fitLabel)}. ${escape(budget)}.${favoriteCount?` ${favoriteCount} saved favorite match${favoriteCount===1?"":"es"}.`:""}</p><p class="coaching-meal-fit"><strong>Calories:</strong> ${escape(fit.calories)}. ${fit.macros?escape(fit.macros):"Macro differences are unavailable; this is a calorie-only comparison."}</p><ol class="coaching-meal-components">${meals}</ol><dl><div><dt>Est. calories</dt><dd>${ui.formatCalories(option.totals.calories)}</dd></div><div><dt>Est. protein</dt><dd>${ui.formatGrams(option.totals.proteinG)}</dd></div><div><dt>Est. carbs</dt><dd>${ui.formatGrams(option.totals.carbsG)}</dd></div><div><dt>Est. fat</dt><dd>${ui.formatGrams(option.totals.fatG)}</dd></div><div><dt>Est. cost</dt><dd>${ui.formatUsd(option.totals.estimatedCostCents)}</dd></div></dl><p class="coaching-meal-allergens">${allergens.length?`Catalog allergen tags: ${escape(allergens.map(title).join(", "))}.`:`No major allergens are tagged in these listed ingredients.`} Verify labels and cross-contact.</p></li>`;
    }
    function render(result){
      renderRemaining(result.remaining);const count=result.options?.length||0;
      for(const surface of surfaces()){surface.options.innerHTML=(result.options||[]).map(mealCard).join("");surface.options.setAttribute("aria-busy","false");surface.status.textContent=result.status==="ready"?`${count} approximate options use the selected day’s saved intake, targets, and food preferences. Actual spending is not logged; menu cost is compared with the entered daily budget.${result.remaining?.proteinG==null?" Optional macros were not fully logged, so these options match calories only.":""}`:result.reason||"No compatible food options are available.";surface.refresh.disabled=false;}
    }
    async function refresh({focusId=""}={}){
      const request=++data.request,{target}=context();if(!target){unavailableForDate();return;}if(!data.profile?.mealPreferences){for(const surface of surfaces()){surface.options.textContent="";surface.status.textContent="Save food preferences in your coaching profile to load options.";surface.refresh.disabled=!data.profile;}return;}
      const expected={userId:String(state.user?.id||""),csrfToken:String(state.csrfToken||"")};for(const surface of surfaces()){surface.refresh.disabled=true;surface.options.textContent="";surface.options.setAttribute("aria-busy","true");surface.status.textContent="Matching food options to what remains…";}
      try{const result=assertAccountResponse(await api(`/api/coaching/food-options/${encodeURIComponent(data.date)}`),{userId:state.user?.id,csrfToken:state.csrfToken},expected);if(request!==data.request)return;render(result);if(focusId)el(focusId)?.focus();}
      catch(error){if(onAccountError?.(error)||request!==data.request)return;for(const surface of surfaces()){surface.options.textContent="";surface.options.setAttribute("aria-busy","false");surface.status.textContent=error?.message||"Food options could not load. Try again.";surface.refresh.disabled=false;}}
    }
    function sync({profile,week,logs,date,refreshOptions=true}){
      data.profile=profile||null;data.week=week||null;data.logs=Array.isArray(logs)?logs:[];data.date=String(date||"");const {target,log}=context();if(!target){unavailableForDate();return;}const macrosKnown=!log||[log.proteinG,log.carbsG,log.fatG].every((item)=>Number.isFinite(item));if(target)renderRemaining({calories:Math.max(0,target.calories-(log?.calories||0)),proteinG:target.macros&&macrosKnown?Math.max(0,target.macros.proteinG-(log?.proteinG||0)):null,carbsG:target.macros&&macrosKnown?Math.max(0,target.macros.carbsG-(log?.carbsG||0)):null,fatG:target.macros&&macrosKnown?Math.max(0,target.macros.fatG-(log?.fatG||0)):null});if(refreshOptions)void refresh();
    }
    function clearPrivate(){data.profile=null;data.week=null;data.logs=[];data.date="";data.request+=1;for(const surface of surfaces()){surface.status.textContent="Save your food preferences to load options.";surface.options.textContent="";surface.options.setAttribute("aria-busy","false");surface.refresh.disabled=true;[...surface.remaining.querySelectorAll("dd")].forEach((node)=>{node.textContent="—";});}fillPreferences(null);}
    function bind(){if(data.bound)return;data.bound=true;document.querySelectorAll('input[name="mealAllergyStatus"]').forEach((input)=>input.addEventListener("change",updateAllergyFields));for(const surface of surfaces())surface.refresh.addEventListener("click",()=>refresh({focusId:`${surface.prefix}Title`}));}
    bind();return{clearPrivate,fillPreferences,profileInput,refresh,sync};
  }
  return{createController};
});
