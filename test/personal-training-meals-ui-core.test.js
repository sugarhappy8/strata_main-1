"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const Ui=require("../public/scripts/personal-training-meals-ui-core");
const {version:BUILD}=require("../package.json");

const ROOT=join(__dirname,"..");
function validDraft(overrides={}){return{allergyStatus:"listed",allergens:["sesame","peanuts"],otherAllergies:"",dietaryPattern:"vegetarian",dietaryRequirements:["dairy_free","gluten_free"],favoriteFoods:["tofu","rice","beans","tofu"],mealsPerDay:"4",dailyBudgetUsd:"12.50",...overrides};}

test("no-build meal UI core exposes the same frozen browser API",()=>{
  const context={Intl};context.globalThis=context;vm.createContext(context);
  vm.runInContext(readFileSync(join(ROOT,"public","scripts","personal-training-meals-ui-core.js"),"utf8"),context,{filename:"personal-training-meals-ui-core.js"});
  assert.equal(typeof context.StrataPersonalTrainingMealsUi.normalizeMealPreferencesDraft,"function");
  assert.equal(typeof context.StrataPersonalTrainingMealsUi.remainingNutrition,"function");
  assert.equal(Object.isFrozen(context.StrataPersonalTrainingMealsUi),true);
});

test("form drafts normalize to the exact nested meal-preferences API shape",()=>{
  const result=Ui.normalizeMealPreferencesDraft(validDraft());
  assert.equal(result.ok,true);assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.payload,{mealPreferences:{
    allergyStatus:"listed",allergens:["peanuts","sesame"],otherAllergies:"",dietaryPattern:"vegetarian",
    dietaryRequirements:["gluten_free","dairy_free"],favoriteFoods:["beans","rice","tofu"],mealsPerDay:4,dailyBudgetCents:1250
  }});
});

test("no-known and other-or-uncertain allergy states remain explicit and fail closed",()=>{
  const none=Ui.normalizeMealPreferencesDraft(validDraft({allergyStatus:"none_known",allergens:[],favoriteFoods:[],dailyBudgetUsd:""}));
  assert.equal(none.ok,true);assert.equal(none.payload.mealPreferences.allergyStatus,"none_known");assert.equal(none.payload.mealPreferences.dailyBudgetCents,null);
  const other=Ui.normalizeMealPreferencesDraft(validDraft({allergyStatus:"other_or_unsure",allergens:["milk"],otherAllergies:"Possible lupin allergy"}));
  assert.equal(other.ok,true);assert.deepEqual(other.payload.mealPreferences.allergens,["milk"]);assert.equal(other.payload.mealPreferences.otherAllergies,"Possible lupin allergy");
  for(const draft of [
    validDraft({allergyStatus:"",allergens:["milk"]}),
    validDraft({allergyStatus:"none_known",allergens:["milk"]}),
    validDraft({allergyStatus:"listed",allergens:[]}),
    validDraft({allergyStatus:"listed",otherAllergies:"lupin"}),
    validDraft({allergyStatus:"other_or_unsure",otherAllergies:""})
  ])assert.equal(Ui.normalizeMealPreferencesDraft(draft).ok,false);
});

test("preference bounds and catalog enums reject unsupported or lossy values",()=>{
  const result=Ui.normalizeMealPreferencesDraft(validDraft({dietaryPattern:"keto",dietaryRequirements:["low_sodium"],allergens:["mustard"],favoriteFoods:["candy"],mealsPerDay:"7",dailyBudgetUsd:"12.345"}));
  assert.equal(result.ok,false);
  for(const field of ["dietaryPattern","dietaryRequirements","allergens","favoriteFoods","mealsPerDay","dailyBudgetUsd"])assert.ok(result.errors.some((error)=>error.field===field),field);
  const minimum=Ui.normalizeMealPreferencesDraft(validDraft({dailyBudgetUsd:"0",mealsPerDay:"1"})).payload.mealPreferences;assert.equal(minimum.mealsPerDay,1);assert.equal(minimum.dailyBudgetCents,0);
  assert.equal(Ui.normalizeMealPreferencesDraft(validDraft({dailyBudgetCents:9999,dailyBudgetUsd:undefined})).payload.mealPreferences.dailyBudgetCents,9999);
  assert.equal(Ui.normalizeMealPreferencesDraft(validDraft({otherAllergies:"x".repeat(201),allergyStatus:"other_or_unsure"})).ok,false);
});

test("remaining nutrition keeps remaining and over-target amounts distinct",()=>{
  const remaining=Ui.remainingNutrition({calories:2200,macros:{proteinG:160,carbsG:250,fatG:70}},{calories:1750,proteinG:100,carbsG:200,fatG:75});
  assert.deepEqual(remaining,{calories:{target:2200,consumed:1750,remaining:450,overBy:0},macros:{proteinG:{target:160,consumed:100,remaining:60,overBy:0},carbsG:{target:250,consumed:200,remaining:50,overBy:0},fatG:{target:70,consumed:75,remaining:0,overBy:5}}});
  assert.deepEqual(Ui.perMealTarget(remaining,2),{calories:225,macros:{proteinG:30,carbsG:25,fatG:0},mealsRemaining:2});
  const calorieOnly=Ui.remainingNutrition({targetCalories:1800},{consumedCalories:1900});
  assert.deepEqual(calorieOnly,{calories:{target:1800,consumed:1900,remaining:0,overBy:100},macros:null});
  assert.deepEqual(Ui.perMealTarget(calorieOnly,1),{calories:0,macros:null,mealsRemaining:1});
});

test("meal presentation formatters are deliberate about units and missing data",()=>{
  assert.equal(Ui.formatCalories(1250.4),"1,250 kcal");assert.equal(Ui.formatGrams(37.6),"38 g");assert.equal(Ui.formatUsd(1250),"$12.50");
  assert.equal(Ui.formatCalories(null),"—");assert.equal(Ui.formatGrams(-1),"—");assert.equal(Ui.formatUsd(null),"No daily budget");
  assert.throws(()=>Ui.remainingNutrition({calories:-1},{}),/positive/);assert.throws(()=>Ui.perMealTarget({calories:{remaining:10}},0),/One to six/);
});

test("Discover markup supplies accessible preference and suggestion surfaces without example meals",()=>{
  const html=readFileSync(join(ROOT,"public","pages","discover.html"),"utf8"),css=readFileSync(join(ROOT,"public","styles","discover-coaching-meals.css"),"utf8");
  for(const asset of ["discover-coaching-meals.css","personal-training-meals-ui-core.js","discover-coaching-meals.js"])assert.match(html,new RegExp(`${asset.replaceAll(".","\\.")}\\?v=${BUILD.replaceAll(".","\\.")}`),asset);
  for(const id of ["mealAllergyNone","mealAllergyListed","mealAllergyOther","mealOtherAllergies","mealDietaryPattern","mealDietGlutenFree","mealDietDairyFree","mealMealsPerDay","mealDailyBudget","coachingFoodStatus","coachingFoodRemaining","coachingFoodOptions","coachingFoodRefresh"])assert.match(html,new RegExp(`id="${id}"`),id);
  assert.equal((html.match(/name="mealAllergen"/g)||[]).length,9);assert.equal((html.match(/name="mealFavorite"/g)||[]).length,Ui.FAVORITE_FOODS.length);
  assert.equal((html.match(/aria-label="Meal suggestions"/g)||[]).length,1);assert.equal((html.match(/USDA FoodData Central reference data/g)||[]).length,1);assert.equal((html.match(/cross-contact risk/g)||[]).length,1);
  assert.match(html,/id="coachingFoodOptions"[^>]*><\/ul>/);assert.doesNotMatch(html,/id="progressCoachingFoodOptions"/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);assert.match(css,/@media\(max-width:560px\)/);assert.match(css,/\.coaching-meal-list[^}]*grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/@media\(forced-colors:active\)/);
});


test("remaining macro display distinguishes missing intake from a recorded zero",()=>{
  const target={calories:2200,macros:{proteinG:160,carbsG:250,fatG:70}};
  assert.equal(Ui.remainingNutrition(target,{calories:600,proteinG:null,carbsG:null,fatG:null}).macros,null);
  assert.equal(Ui.remainingNutrition(target,{calories:600,proteinG:40,carbsG:null,fatG:null}).macros,null);
  assert.equal(Ui.remainingNutrition(target,{calories:600,proteinG:0,carbsG:0,fatG:0}).macros.proteinG.remaining,160);
  assert.equal(Ui.remainingNutrition(target).macros.proteinG.remaining,160);
  assert.equal(Ui.formatCalories("   "),"—");assert.equal(Ui.formatGrams(NaN),"—");assert.equal(Ui.formatGrams(true),"—");
});

test("menu fit copy exposes signed calorie and macro residuals without inventing missing values",()=>{
  const result=Ui.optionFitSummary({calorieDifference:-8,macroDifference:{proteinG:-43,carbsG:55,fatG:0}});
  assert.equal(result.calories,"8 kcal below the remaining plan");assert.equal(result.macros,"Protein 43 g below the remaining plan; carbs 55 g above the remaining plan; fat matches the remaining plan.");
  assert.deepEqual(Ui.optionFitSummary({calorieDifference:0,macroDifference:null}),{calories:"matches the remaining plan",macros:null});
  assert.deepEqual(Ui.optionFitSummary({calorieDifference:NaN,macroDifference:{proteinG:null,carbsG:0,fatG:0}}),{calories:"unavailable",macros:null});
});
