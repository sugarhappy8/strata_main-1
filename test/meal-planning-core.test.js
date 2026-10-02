"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CATALOG,
  CATALOG_FINGERPRINT,
  DIETARY_PATTERNS,
  DIETARY_REQUIREMENTS,
  FAVORITE_FOODS,
  NUTRITION_PROVENANCE,
  TOP_9_ALLERGENS,
  generateRemainingDayFoodOptions,
  sanitizeMealPreferences,
  validateCatalog,
} = require("../src/meal-planning-core");

function preferences(overrides = {}) {
  return {
    allergyStatus: "none_known",
    allergens: [],
    otherAllergies: "",
    dietaryPattern: "omnivore",
    dietaryRequirements: [],
    favoriteFoods: ["chicken", "rice"],
    mealsPerDay: 3,
    dailyBudgetCents: 1800,
    ...overrides,
  };
}
function request(overrides = {}) {
  return {
    mealPreferences: preferences(),
    target: { calories: 2200, proteinG: 160, carbsG: 250, fatG: 70 },
    consumed: { calories: 600, proteinG: 40, carbsG: 70, fatG: 18, costCents: 400 },
    mealsRemaining: 2,
    seed: "2026-09-14:user-1",
    ...overrides,
  };
}

test("meal preferences strictly validate allergy state and bounded choices", () => {
  assert.deepEqual(sanitizeMealPreferences(preferences()), preferences());
  assert.deepEqual(
    sanitizeMealPreferences(
      preferences({
        allergyStatus: "listed",
        allergens: ["milk", "peanuts"],
        favoriteFoods: [],
        dailyBudgetCents: null,
      }),
    ).allergens,
    ["milk", "peanuts"],
  );
  assert.throws(
    () => sanitizeMealPreferences({ ...preferences(), userId: "untrusted" }),
    /unsupported fields: userId/,
  );
  assert.throws(() => sanitizeMealPreferences(preferences({ otherAllergies: 42 })), /must be text/);
  assert.throws(
    () =>
      sanitizeMealPreferences(preferences({ allergyStatus: "none_known", allergens: ["milk"] })),
    /cannot include/,
  );
  assert.throws(
    () => sanitizeMealPreferences(preferences({ allergyStatus: "listed", allergens: [] })),
    /at least one supported/,
  );
  assert.throws(
    () =>
      sanitizeMealPreferences(
        preferences({ allergyStatus: "other_or_unsure", otherAllergies: "" }),
      ),
    /Describe the other/,
  );
  assert.throws(
    () => sanitizeMealPreferences(preferences({ allergens: ["milk", "milk"] })),
    /invalid or repeated/,
  );
  assert.equal(sanitizeMealPreferences(preferences({ mealsPerDay: 1 })).mealsPerDay, 1);
  assert.throws(() => sanitizeMealPreferences(preferences({ mealsPerDay: 7 })), /1 to 6/);
  assert.throws(
    () => sanitizeMealPreferences(preferences({ dailyBudgetCents: 10.5 })),
    /whole number/,
  );
});

test("unknown allergies fail closed without generating automated suggestions", () => {
  const result = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({
        allergyStatus: "other_or_unsure",
        otherAllergies: "Must discuss an uncommon spice reaction",
      }),
    }),
  );
  assert.equal(result.status, "manual_review");
  assert.deepEqual(result.options, []);
  assert.match(result.reason, /cannot be matched safely/i);
  assert.match(result.safetyDisclaimer, /not medical nutrition therapy/i);
});

test("hard filters exclude allergens and enforce vegan, gluten-free, and dairy-free requirements", () => {
  const mealPreferences = preferences({
    allergyStatus: "listed",
    allergens: [
      "soy",
      "peanuts",
      "sesame",
      "wheat",
      "milk",
      "egg",
      "fish",
      "crustacean_shellfish",
      "tree_nuts",
    ],
    dietaryPattern: "vegan",
    dietaryRequirements: ["gluten_free", "dairy_free"],
    favoriteFoods: ["tofu", "nuts"],
  });
  const result = generateRemainingDayFoodOptions(request({ mealPreferences, mealsRemaining: 3 }));
  assert.equal(result.status, "limited");
  assert.equal(result.options.length, 3);
  assert.ok(result.options.some((option) => option.withinMacroFit === false));
  for (const option of result.options)
    for (const meal of option.meals) {
      assert.equal(meal.allergens.length, 0);
      assert.ok(meal.dietTags.includes("gluten_free"));
      assert.ok(meal.dietTags.includes("dairy_free"));
      assert.equal(
        meal.favoriteMatches.includes("tofu") || meal.favoriteMatches.includes("nuts"),
        false,
      );
    }
});

test("remaining-day generation is deterministic, distinct, nutrient-aware, and transparent", () => {
  const first = generateRemainingDayFoodOptions(request()),
    replay = generateRemainingDayFoodOptions(request());
  assert.deepEqual(replay, first);
  assert.equal(first.options.length, 3);
  assert.equal(new Set(first.options.map((option) => option.id)).size, 3);
  assert.deepEqual(first.remaining, {
    calories: 1600,
    proteinG: 120,
    carbsG: 180,
    fatG: 52,
    budgetCents: 1400,
  });
  for (const option of first.options) {
    assert.equal(option.meals.length, 2);
    assert.ok(Math.abs(option.calorieDifference) <= 100);
    assert.ok(
      option.meals.every(
        (meal) => meal.ingredients.length && meal.calories > 0 && meal.estimatedCostCents > 0,
      ),
    );
    assert.ok(option.macroDifference);
  }
  assert.match(first.costDisclaimer, /not live store prices/i);
  assert.equal(first.nutritionProvenance.source, "STRATA editorial recipe estimates");
  assert.match(first.nutritionProvenance.url, /fdc\.nal\.usda\.gov/);
});

test("favorites and budget rank options but never weaken hard filters", () => {
  const chicken = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({ favoriteFoods: ["chicken"], dailyBudgetCents: null }),
      consumed: { calories: 0 },
      mealsRemaining: 2,
      seed: "favorite",
    }),
  );
  assert.ok(chicken.options[0].meals.some((meal) => meal.favoriteMatches.includes("chicken")));
  const budget = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({ favoriteFoods: [], dailyBudgetCents: 700 }),
      consumed: { calories: 0, costCents: 0 },
      mealsRemaining: 2,
      seed: "budget",
    }),
  );
  assert.equal(typeof budget.options[0].withinEnteredBudget, "boolean");
  assert.equal(typeof budget.options[0].budgetDifferenceCents, "number");
  const scaledBudget = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({ favoriteFoods: [], mealsPerDay: 2, dailyBudgetCents: 700 }),
      target: { calories: 1200 },
      consumed: { calories: 0, costCents: 0 },
      mealsRemaining: 2,
      seed: "budget",
    }),
  );
  assert.equal(
    scaledBudget.options[0].totals.estimatedCostCents,
    Math.min(...scaledBudget.options.map((option) => option.totals.estimatedCostCents)),
  );
});

test("all requested macros influence menu ranking", () => {
  const mealPreferences = preferences({ favoriteFoods: [], dailyBudgetCents: null }),
    base = { mealPreferences, consumed: { calories: 0 }, mealsRemaining: 3, seed: "macro-ranking" };
  const highProtein = generateRemainingDayFoodOptions({
    ...base,
    target: { calories: 1800, proteinG: 240, carbsG: 120, fatG: 40 },
  }).options[0].totals;
  const highCarb = generateRemainingDayFoodOptions({
    ...base,
    target: { calories: 1800, proteinG: 60, carbsG: 320, fatG: 30 },
  }).options[0].totals;
  const highFat = generateRemainingDayFoodOptions({
    ...base,
    target: { calories: 1800, proteinG: 80, carbsG: 100, fatG: 120 },
  }).options[0].totals;
  assert.ok(highProtein.proteinG > highCarb.proteinG);
  assert.ok(highCarb.carbsG > highProtein.carbsG);
  assert.ok(highFat.fatG > highCarb.fatG);
});

test("met targets stop suggestions and catalog metadata remains stable and complete", () => {
  const met = generateRemainingDayFoodOptions(
    request({ target: { calories: 1000 }, consumed: { calories: 1100 }, mealsRemaining: 2 }),
  );
  assert.equal(met.status, "target_met");
  assert.deepEqual(met.options, []);
  assert.match(CATALOG_FINGERPRINT, /^[a-f0-9]{16}$/);
  assert.equal(NUTRITION_PROVENANCE.source, "STRATA editorial recipe estimates");
  assert.ok(CATALOG.length >= 18);
  assert.ok(
    Object.isFrozen(CATALOG) &&
      CATALOG.every((meal) => Object.isFrozen(meal) && Object.isFrozen(meal.allergens)),
  );
  for (const meal of CATALOG) {
    assert.match(meal.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(meal.ingredients.length);
    assert.match(
      meal.ingredients.join(" "),
      /[0-9½¾⅓¼]/,
      `${meal.id} needs an approximate base amount`,
    );
    assert.ok(meal.allergens.every((value) => TOP_9_ALLERGENS.includes(value)));
    assert.ok(meal.dietTags.every((value) => DIETARY_REQUIREMENTS.includes(value)));
    assert.ok(meal.patterns.every((value) => DIETARY_PATTERNS.includes(value)));
    assert.ok(meal.favorites.every((value) => FAVORITE_FOODS.includes(value)));
    assert.ok(
      meal.calories === meal.proteinG * 4 + meal.carbsG * 4 + meal.fatG * 9 ||
        Math.abs(meal.calories - (meal.proteinG * 4 + meal.carbsG * 4 + meal.fatG * 9)) <= 75,
      meal.id,
    );
  }
  assert.throws(
    () => validateCatalog([{ ...CATALOG[0], allergens: ["milkk"] }]),
    /metadata is invalid/,
  );
});

test("extreme remaining targets never claim a close menu fit", () => {
  const result = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({ mealsPerDay: 2, dailyBudgetCents: null }),
      target: { calories: 8500 },
      consumed: { calories: 0 },
      mealsRemaining: 2,
      seed: "extreme-target",
    }),
  );
  assert.equal(result.status, "limited");
  assert.match(result.reason, /cannot closely match/i);
  assert.ok(result.options.length > 0);
  assert.ok(
    result.options.every(
      (option) =>
        !option.withinCalorieFit && Math.abs(option.calorieDifference) > option.calorieFitTolerance,
    ),
  );
});

test("portion ingredient quantities and nutrition use the same multiplier", () => {
  const result = generateRemainingDayFoodOptions(request());
  let scaled = 0;
  for (const option of result.options) {
    assert.deepEqual(
      option.totals,
      option.meals.reduce(
        (sum, meal) => ({
          calories: sum.calories + meal.calories,
          proteinG: sum.proteinG + meal.proteinG,
          carbsG: sum.carbsG + meal.carbsG,
          fatG: sum.fatG + meal.fatG,
          estimatedCostCents: sum.estimatedCostCents + meal.estimatedCostCents,
        }),
        { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, estimatedCostCents: 0 },
      ),
    );
    for (const meal of option.meals) {
      const base = CATALOG.find((item) => item.id === meal.id);
      assert.ok(base);
      assert.deepEqual(meal.baseIngredients, base.ingredients);
      assert.equal(meal.calories, Math.round(base.calories * meal.servings));
      assert.equal(meal.proteinG, Math.round(base.proteinG * meal.servings));
      for (const [index, amount] of meal.ingredientQuantities.entries()) {
        const original = base.components[index];
        assert.equal(amount.food, original.food);
        assert.equal(amount.unit, original.unit);
        if (original.quantity === null) {
          assert.equal(amount.quantity, null);
          assert.equal(meal.ingredients[index], original.food);
        } else {
          assert.ok(Math.abs(amount.quantity - original.quantity * meal.servings) < 1e-9);
          assert.ok(meal.ingredients[index].startsWith(String(Number(amount.quantity.toFixed(3)))));
        }
      }
      assert.match(meal.servingBasis, /scaled for this portion/);
      if (meal.servings !== 1) {
        scaled++;
        assert.notDeepEqual(meal.ingredients, meal.baseIngredients);
      }
    }
  }
  assert.ok(scaled > 0);
  assert.equal(
    CATALOG.find((meal) => meal.id === "black-bean-sweet-potato-bowl").components.find(
      (item) => item.food === "corn",
    ).quantity,
    1 / 3,
    "a household third is not prematurely rounded or invented as grams",
  );
});

test("catalog validation rejects missing, negative, non-finite, or out-of-range nutrients and quantities", () => {
  for (const key of ["proteinG", "carbsG", "fatG"])
    for (const value of [undefined, null, NaN, Infinity, -1, 3001, "20"]) {
      assert.throws(() => validateCatalog([{ ...CATALOG[0], [key]: value }]), /nutrients/);
    }
  assert.throws(() => validateCatalog([{ ...CATALOG[0], fatG: 1001 }]), /nutrients/);
  for (const quantity of [undefined, NaN, Infinity, -1, 0, 10001])
    assert.throws(
      () =>
        validateCatalog([
          {
            ...CATALOG[0],
            components: CATALOG[0].components.map((item, index) =>
              index ? item : { ...item, quantity },
            ),
          },
        ]),
      /quantities/,
    );
  assert.throws(
    () =>
      validateCatalog([
        {
          ...CATALOG[0],
          components: CATALOG[0].components.map((item, index) =>
            index ? item : { ...item, unit: "scoop" },
          ),
        },
      ]),
    /quantities/,
  );
  validateCatalog([{ ...CATALOG[0], proteinG: 0, carbsG: 0, fatG: 0 }]);
});

test("unknown consumed macros stay unknown while explicit zero macros are preserved", () => {
  const unknown = generateRemainingDayFoodOptions(request({ consumed: { calories: 600 } }));
  assert.equal(unknown.remaining.proteinG, null);
  assert.equal(unknown.remaining.carbsG, null);
  assert.equal(unknown.remaining.fatG, null);
  assert.ok(
    unknown.options.every(
      (option) => option.macroDifference === null && option.withinMacroFit === null,
    ),
  );
  const zero = generateRemainingDayFoodOptions(
    request({ consumed: { calories: 600, proteinG: 0, carbsG: 0, fatG: 0 } }),
  );
  assert.equal(zero.remaining.proteinG, 160);
  assert.ok(zero.options.every((option) => option.macroDifference !== null));
  assert.throws(
    () =>
      generateRemainingDayFoodOptions(
        request({ consumed: { calories: 600, proteinG: NaN, carbsG: 0, fatG: 0 } }),
      ),
    /protein/,
  );
});

test("whole-menu ranking improves protein fit without masking unavoidable macro gaps", () => {
  const result = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({ favoriteFoods: ["fruit"] }),
      consumed: { calories: 600, proteinG: 40, carbsG: 70, fatG: 18 },
      seed: "audit",
    }),
  );
  assert.ok(
    Math.abs(result.options[0].macroDifference.proteinG) < 43,
    "fruit preference must not recreate the former 43 g protein shortfall",
  );
  const limited = generateRemainingDayFoodOptions(
    request({
      mealPreferences: preferences({
        dietaryPattern: "vegan",
        dietaryRequirements: ["gluten_free", "dairy_free"],
        allergyStatus: "listed",
        allergens: ["soy", "peanuts", "sesame"],
        favoriteFoods: [],
      }),
      target: { calories: 1800, proteinG: 240, carbsG: 120, fatG: 40 },
      consumed: { calories: 0 },
      mealsRemaining: 3,
    }),
  );
  assert.equal(limited.status, "limited");
  assert.match(limited.reason, /partial meal ideas/i);
  assert.ok(
    limited.options.every(
      (option) => option.withinCalorieFit && !option.withinMacroFit && !option.withinNutritionFit,
    ),
  );
  for (const option of limited.options) {
    assert.ok(option.macroDifference.proteinG < -option.macroFitTolerance.proteinG);
    assert.ok(
      option.meals.every((meal) =>
        meal.allergens.every((allergen) => !["soy", "peanuts", "sesame"].includes(allergen)),
      ),
    );
  }
});

test("concrete cooked-weight and household portions stay numerically consistent", () => {
  const input = {
    mealPreferences: preferences({
      favoriteFoods: ["turkey"],
      mealsPerDay: 1,
      dailyBudgetCents: null,
    }),
    consumed: { calories: 0 },
    mealsRemaining: 1,
    seed: "numeric",
  };
  const turkey = generateRemainingDayFoodOptions({
    ...input,
    target: { calories: 700, proteinG: 56, carbsG: 81, fatG: 16 },
  }).options[0].meals[0];
  assert.equal(turkey.id, "turkey-potato-greens");
  assert.equal(turkey.servings, 1.25);
  assert.deepEqual(turkey.ingredients, [
    "187.5 g cooked turkey breast",
    "375 g cooked potato",
    "1.25 cups green beans",
    "2.5 tsp olive oil",
  ]);
  assert.deepEqual(
    [turkey.calories, turkey.proteinG, turkey.carbsG, turkey.fatG],
    [700, 56, 81, 16],
  );
  const beans = generateRemainingDayFoodOptions({
    ...input,
    target: { calories: 875, proteinG: 30, carbsG: 162, fatG: 13 },
  }).options[0].meals[0];
  assert.equal(beans.id, "black-bean-sweet-potato-bowl");
  assert.equal(beans.servings, 1.65);
  assert.ok(beans.ingredients.includes("330 g cooked sweet potato"));
  assert.ok(beans.ingredients.includes("0.55 cups corn"));
  assert.equal(beans.ingredients.at(-1), "lime to taste");
  assert.deepEqual([beans.calories, beans.proteinG, beans.carbsG, beans.fatG], [875, 30, 162, 13]);
});
