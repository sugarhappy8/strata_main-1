"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Meals=require("../src/meal-planning-core"),Ui=require("../public/scripts/personal-training-meals-ui-core"),{createController}=require("../public/scripts/discover-coaching-meals"),{assertAccountResponse}=require("../public/scripts/discover-api");
const preferences={allergyStatus:"listed",allergens:["soy","peanuts","sesame"],otherAllergies:"",dietaryPattern:"vegan",dietaryRequirements:["gluten_free","dairy_free"],favoriteFoods:[],mealsPerDay:3,dailyBudgetCents:null};
function fixture(api){
  const elements=new Map(),element=(id)=>{
    if(!elements.has(id)){const children=Array.from({length:4},()=>({textContent:""})),macros=Array.from({length:3},()=>({hidden:false}));elements.set(id,{id,innerHTML:"",textContent:"",children,macros,attributes:{},querySelectorAll:(selector)=>selector==="dd"?children:selector==="[data-meal-macro]"?macros:[],addEventListener(){},setAttribute(name,value){this.attributes[name]=value;}});}
    return elements.get(id);
  };
  const state={user:{id:"member"},csrfToken:"csrf"},document={querySelectorAll:()=>[],querySelector:()=>null};
  const controller=createController({document,element,api,state,ui:Ui,assertAccountResponse});
  controller.sync({profile:{mealPreferences:preferences},week:{nutrition:{dailyTargets:[{date:"2026-09-14",calories:1800,macros:{proteinG:240,carbsG:120,fatG:40}}]}},logs:[],date:"2026-09-14",refreshOptions:false});
  return{controller,element,state};
}
function response(consumed={calories:0}){return {...Meals.generateRemainingDayFoodOptions({mealPreferences:preferences,target:{calories:1800,proteinG:240,carbsG:120,fatG:40},consumed,mealsRemaining:3,seed:"ui-fixture"}),csrfToken:"csrf"};}

test("the canonical Nutrition surface render scaled amounts and actual residuals for limited menus",async()=>{
  const result=response(),{controller,element}=fixture(async()=>result);assert.equal(result.status,"limited");await controller.refresh();
  for(const prefix of ["coachingFood"]){
    const markup=element(`${prefix}Options`).innerHTML;assert.match(markup,/Partial idea/);assert.match(markup,/Amounts for this portion:/);assert.match(markup,/Est\. calories/);assert.match(element(`${prefix}Status`).textContent,/partial meal ideas/i);
    for(const option of result.options){assert.ok(markup.includes(Ui.optionFitSummary(option).calories));assert.ok(markup.includes(Ui.optionFitSummary(option).macros));for(const meal of option.meals)for(const amount of meal.ingredients)assert.ok(markup.includes(amount));}
    assert.equal(element(`${prefix}Options`).attributes["aria-busy"],"false");assert.equal(element(`${prefix}Refresh`).disabled,false);
  }
});

test("calorie-only food options do not present unlogged macros as zero",async()=>{
  const result=response({calories:600}),{controller,element}=fixture(async()=>result);await controller.refresh();
  for(const prefix of ["coachingFood"]){assert.match(element(`${prefix}Options`).innerHTML,/Macro differences are unavailable/);assert.equal(element(`${prefix}Remaining`).children[1].textContent,"—");assert.ok(element(`${prefix}Remaining`).macros.every((node)=>node.hidden));}
});

test("late food results cannot restore private ingredients after reset",async()=>{
  let resolveResponse;const promise=new Promise((resolve)=>{resolveResponse=resolve;}),{controller,element}=fixture(()=>promise),pending=controller.refresh();controller.clearPrivate();resolveResponse(response());await pending;
  for(const prefix of ["coachingFood"]){assert.equal(element(`${prefix}Options`).textContent,"");assert.equal(element(`${prefix}Options`).innerHTML,"");assert.ok(element(`${prefix}Remaining`).children.every((node)=>node.textContent==="—"));assert.equal(element(`${prefix}Refresh`).disabled,true);}
});


test("switching to a historical diary date clears stale current-week food results",async()=>{
  let resolveResponse;const pending=new Promise(resolve=>{resolveResponse=resolve;}),{controller,element}=fixture(()=>pending),loading=controller.refresh();controller.sync({profile:{mealPreferences:preferences},week:{nutrition:{dailyTargets:[{date:"2026-09-14",calories:1800}]}},logs:[],date:"2026-09-07"});resolveResponse(response());await loading;
  for(const prefix of ["coachingFood"]){assert.equal(element(`${prefix}Options`).innerHTML,"");assert.equal(element(`${prefix}Refresh`).disabled,true);assert.match(element(`${prefix}Status`).textContent,/Historical intake/);assert.ok(element(`${prefix}Remaining`).children.every((node)=>node.textContent==="—"));}
});
