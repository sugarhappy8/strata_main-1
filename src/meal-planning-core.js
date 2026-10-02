// @ts-check
"use strict";

const { createHash } = require("node:crypto");

const DIETARY_PATTERNS = Object.freeze(["omnivore", "pescatarian", "vegetarian", "vegan"]);
const DIETARY_REQUIREMENTS = Object.freeze(["gluten_free", "dairy_free"]);
const TOP_9_ALLERGENS = Object.freeze([
  "milk",
  "egg",
  "fish",
  "crustacean_shellfish",
  "tree_nuts",
  "peanuts",
  "wheat",
  "soy",
  "sesame",
]);
const FAVORITE_FOODS = Object.freeze([
  "beans",
  "beef",
  "chicken",
  "eggs",
  "fish",
  "fruit",
  "grains",
  "lentils",
  "nuts",
  "pasta",
  "potatoes",
  "rice",
  "shellfish",
  "tofu",
  "turkey",
  "vegetables",
  "yogurt",
]);
const SAFETY_DISCLAIMER =
  "Food suggestions are planning ideas, not medical nutrition therapy or a guarantee that a product is allergen-free. Check every label, preparation surface, and cross-contact warning; ask a qualified clinician or dietitian when allergy safety is uncertain.";
const COST_DISCLAIMER =
  "Costs are rough USD ingredient estimates, not live store prices. Brand, portion, season, location, tax, delivery, and waste can change the amount.";
const NUTRITION_PROVENANCE = Object.freeze({
  source: "STRATA editorial recipe estimates",
  referenceSource: "USDA FoodData Central",
  url: "https://fdc.nal.usda.gov/",
  method:
    "Approximate STRATA recipes informed by generic FoodData Central information. No live lookup, specific FDC record, or branded product is verified; household amounts are not converted to grams without a measured basis.",
});

/** @typedef {{quantity:number|null,unit:string,food:string}} Ingredient */
/** @typedef {{id:string,name:string,ingredients:readonly string[],components:readonly Ingredient[],calories:number,proteinG:number,carbsG:number,fatG:number,costCents:number,allergens:readonly string[],dietTags:readonly string[],patterns:readonly string[],favorites:readonly string[]}} CatalogMeal */
/** @typedef {CatalogMeal&{_favorites:string[]}} CandidateMeal */
/** @param {number|null} quantity @param {string} unit @param {string} food @returns {Ingredient} */
function ingredient(quantity, unit, food) {
  return Object.freeze({ quantity, unit, food });
}
/** @param {Ingredient} item */
function ingredientLabel(item) {
  if (item.quantity == null) return item.food;
  const amount = Number(item.quantity.toFixed(3)),
    unit = item.unit === "cup" && amount !== 1 ? "cups" : item.unit;
  return `${amount} ${unit} ${item.food}`;
}
const ALL_PATTERNS = DIETARY_PATTERNS;
/** @type {readonly CatalogMeal[]} */
const CATALOG = Object.freeze(
  [
    {
      id: "chickpea-quinoa-garden-bowl",
      name: "Chickpea quinoa garden bowl",
      components: [
        ingredient(1, "cup", "cooked chickpeas"),
        ingredient(0.75, "cup", "cooked quinoa"),
        ingredient(2, "cup", "tomato, cucumber, and spinach"),
        ingredient(1, "tsp", "olive oil"),
        ingredient(null, "", "lemon to taste"),
      ],
      calories: 520,
      proteinG: 20,
      carbsG: 82,
      fatG: 14,
      costCents: 475,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["beans", "grains", "vegetables"],
    },
    {
      id: "lentil-rice-spinach-bowl",
      name: "Lentil rice and spinach bowl",
      components: [
        ingredient(1, "cup", "cooked lentils"),
        ingredient(1, "cup", "cooked brown rice"),
        ingredient(1, "cup", "spinach and tomato"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 560,
      proteinG: 23,
      carbsG: 96,
      fatG: 10,
      costCents: 390,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["lentils", "rice", "vegetables"],
    },
    {
      id: "black-bean-sweet-potato-bowl",
      name: "Black bean sweet potato bowl",
      components: [
        ingredient(1, "cup", "cooked black beans"),
        ingredient(200, "g", "cooked sweet potato"),
        ingredient(1 / 3, "cup", "corn"),
        ingredient(1, "cup", "tomato and lettuce"),
        ingredient(1, "tsp", "olive oil"),
        ingredient(null, "", "lime to taste"),
      ],
      calories: 530,
      proteinG: 18,
      carbsG: 98,
      fatG: 8,
      costCents: 410,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["beans", "potatoes", "vegetables"],
    },
    {
      id: "white-bean-potato-stew",
      name: "White bean potato stew",
      components: [
        ingredient(0.75, "cup", "cooked white beans"),
        ingredient(250, "g", "cooked potato"),
        ingredient(1.5, "cup", "carrot, celery, and tomato"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 480,
      proteinG: 20,
      carbsG: 78,
      fatG: 10,
      costCents: 350,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["beans", "potatoes", "vegetables"],
    },
    {
      id: "pea-quinoa-herb-bowl",
      name: "Green pea quinoa herb bowl",
      components: [
        ingredient(1.25, "cup", "cooked green peas"),
        ingredient(1, "cup", "cooked quinoa"),
        ingredient(1, "cup", "spinach and tomato"),
        ingredient(2, "tsp", "olive oil"),
        ingredient(null, "", "lemon and herbs to taste"),
      ],
      calories: 500,
      proteinG: 22,
      carbsG: 75,
      fatG: 13,
      costCents: 465,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["grains", "vegetables"],
    },
    {
      id: "banana-berry-chia-cup",
      name: "Banana berry chia cup",
      components: [
        ingredient(1, "medium", "banana"),
        ingredient(1, "cup", "berries"),
        ingredient(2, "tbsp", "chia seeds"),
        ingredient(null, "", "water and cinnamon to taste"),
      ],
      calories: 330,
      proteinG: 7,
      carbsG: 57,
      fatG: 10,
      costCents: 340,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["fruit"],
    },
    {
      id: "red-lentil-rice-porridge",
      name: "Red lentil rice porridge",
      components: [
        ingredient(0.75, "cup", "cooked red lentils"),
        ingredient(0.75, "cup", "cooked rice"),
        ingredient(1.5, "cup", "carrot, spinach, and tomato"),
        ingredient(null, "", "water as needed"),
      ],
      calories: 410,
      proteinG: 19,
      carbsG: 75,
      fatG: 4,
      costCents: 285,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["lentils", "rice", "vegetables"],
    },
    {
      id: "chicken-rice-broccoli",
      name: "Chicken rice and broccoli",
      components: [
        ingredient(150, "g", "cooked chicken breast"),
        ingredient(1, "cup", "cooked rice"),
        ingredient(1.5, "cup", "broccoli"),
        ingredient(1, "tsp", "olive oil"),
        ingredient(null, "", "lemon to taste"),
      ],
      calories: 600,
      proteinG: 48,
      carbsG: 70,
      fatG: 14,
      costCents: 575,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore"],
      favorites: ["chicken", "rice", "vegetables"],
    },
    {
      id: "turkey-potato-greens",
      name: "Turkey potato and greens plate",
      components: [
        ingredient(150, "g", "cooked turkey breast"),
        ingredient(300, "g", "cooked potato"),
        ingredient(1, "cup", "green beans"),
        ingredient(2, "tsp", "olive oil"),
      ],
      calories: 560,
      proteinG: 45,
      carbsG: 65,
      fatG: 13,
      costCents: 610,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore"],
      favorites: ["turkey", "potatoes", "vegetables"],
    },
    {
      id: "beef-quinoa-peppers",
      name: "Beef quinoa and pepper bowl",
      components: [
        ingredient(150, "g", "cooked lean beef"),
        ingredient(1, "cup", "cooked quinoa"),
        ingredient(1.5, "cup", "bell pepper and spinach"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 610,
      proteinG: 43,
      carbsG: 59,
      fatG: 22,
      costCents: 725,
      allergens: [],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore"],
      favorites: ["beef", "grains", "vegetables"],
    },
    {
      id: "salmon-potato-peas",
      name: "Salmon potato and peas",
      components: [
        ingredient(150, "g", "cooked salmon"),
        ingredient(225, "g", "cooked potato"),
        ingredient(0.75, "cup", "cooked green peas"),
        ingredient(null, "", "lemon to taste"),
      ],
      calories: 590,
      proteinG: 42,
      carbsG: 56,
      fatG: 22,
      costCents: 790,
      allergens: ["fish"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore", "pescatarian"],
      favorites: ["fish", "potatoes", "vegetables"],
    },
    {
      id: "tuna-rice-cucumber",
      name: "Tuna rice and cucumber bowl",
      components: [
        ingredient(150, "g", "drained tuna"),
        ingredient(1.25, "cup", "cooked rice"),
        ingredient(1.5, "cup", "cucumber and tomato"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 510,
      proteinG: 39,
      carbsG: 66,
      fatG: 10,
      costCents: 550,
      allergens: ["fish"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore", "pescatarian"],
      favorites: ["fish", "rice", "vegetables"],
    },
    {
      id: "shrimp-rice-vegetables",
      name: "Shrimp rice and vegetable bowl",
      components: [
        ingredient(170, "g", "cooked shrimp"),
        ingredient(1.5, "cup", "cooked rice"),
        ingredient(1.5, "cup", "zucchini and bell pepper"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 540,
      proteinG: 38,
      carbsG: 72,
      fatG: 11,
      costCents: 700,
      allergens: ["crustacean_shellfish"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore", "pescatarian"],
      favorites: ["shellfish", "rice", "vegetables"],
    },
    {
      id: "egg-potato-spinach",
      name: "Egg potato and spinach plate",
      components: [
        ingredient(3, "large", "eggs"),
        ingredient(250, "g", "cooked potato"),
        ingredient(1.5, "cup", "spinach and tomato"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 500,
      proteinG: 25,
      carbsG: 52,
      fatG: 22,
      costCents: 450,
      allergens: ["egg"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ["omnivore", "pescatarian", "vegetarian"],
      favorites: ["eggs", "potatoes", "vegetables"],
    },
    {
      id: "yogurt-oats-fruit",
      name: "Yogurt oats and fruit bowl",
      components: [
        ingredient(1, "cup", "plain Greek yogurt"),
        ingredient(0.5, "cup", "dry oats"),
        ingredient(1, "medium", "banana"),
        ingredient(0.5, "cup", "berries"),
      ],
      calories: 430,
      proteinG: 28,
      carbsG: 66,
      fatG: 7,
      costCents: 425,
      allergens: ["milk"],
      dietTags: [],
      patterns: ["omnivore", "pescatarian", "vegetarian"],
      favorites: ["yogurt", "grains", "fruit"],
    },
    {
      id: "tofu-rice-vegetables",
      name: "Tofu rice and vegetable bowl",
      components: [
        ingredient(150, "g", "firm tofu"),
        ingredient(1.25, "cup", "cooked rice"),
        ingredient(2, "cup", "broccoli and carrot"),
        ingredient(null, "", "lime to taste"),
      ],
      calories: 550,
      proteinG: 27,
      carbsG: 77,
      fatG: 15,
      costCents: 500,
      allergens: ["soy"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["tofu", "rice", "vegetables"],
    },
    {
      id: "peanut-oat-banana-bowl",
      name: "Peanut oat and banana bowl",
      components: [
        ingredient(0.5, "cup", "dry oats"),
        ingredient(2, "tbsp", "peanut butter"),
        ingredient(1, "medium", "banana"),
        ingredient(0.5, "cup", "berries"),
        ingredient(null, "", "water as needed"),
      ],
      calories: 490,
      proteinG: 17,
      carbsG: 70,
      fatG: 18,
      costCents: 330,
      allergens: ["peanuts"],
      dietTags: ["dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["nuts", "grains", "fruit"],
    },
    {
      id: "whole-wheat-tomato-pasta",
      name: "Whole-wheat tomato and bean pasta",
      components: [
        ingredient(2, "cup", "cooked whole-wheat pasta"),
        ingredient(0.5, "cup", "cooked white beans"),
        ingredient(1.5, "cup", "tomato and spinach"),
        ingredient(1, "tsp", "olive oil"),
      ],
      calories: 570,
      proteinG: 24,
      carbsG: 91,
      fatG: 13,
      costCents: 390,
      allergens: ["wheat"],
      dietTags: ["dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["pasta", "beans", "vegetables"],
    },
    {
      id: "sesame-chickpea-rice",
      name: "Sesame chickpea rice bowl",
      components: [
        ingredient(0.75, "cup", "cooked chickpeas"),
        ingredient(1, "cup", "cooked rice"),
        ingredient(1.5, "cup", "cucumber and carrot"),
        ingredient(2, "tbsp", "sesame seeds"),
      ],
      calories: 560,
      proteinG: 19,
      carbsG: 87,
      fatG: 16,
      costCents: 420,
      allergens: ["sesame"],
      dietTags: ["gluten_free", "dairy_free"],
      patterns: ALL_PATTERNS,
      favorites: ["beans", "rice", "vegetables"],
    },
  ].map((meal) =>
    Object.freeze({
      ...meal,
      ingredients: Object.freeze(meal.components.map(ingredientLabel)),
      components: Object.freeze([...meal.components]),
      allergens: Object.freeze([...meal.allergens]),
      dietTags: Object.freeze([...meal.dietTags]),
      patterns: Object.freeze([...meal.patterns]),
      favorites: Object.freeze([...meal.favorites]),
    }),
  ),
);

/** @param {readonly string[]} values @param {readonly string[]} allowed @param {boolean} [required] */
function validTags(values, allowed, required = false) {
  return (
    (!required || values.length > 0) &&
    new Set(values).size === values.length &&
    values.every((value) => allowed.includes(value))
  );
}
/** Fail closed if an edited catalog contains an unknown or ambiguous safety tag. @param {readonly CatalogMeal[]} catalog */
function validateCatalog(catalog) {
  const ids = new Set();
  for (const meal of catalog) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meal.id) || ids.has(meal.id))
      throw new TypeError(`Meal catalog ID is invalid or repeated: ${meal.id}.`);
    ids.add(meal.id);
    if (
      !meal.name ||
      !meal.ingredients.length ||
      !Number.isSafeInteger(meal.calories) ||
      meal.calories < 1 ||
      meal.calories > 20000 ||
      !Number.isSafeInteger(meal.costCents) ||
      meal.costCents < 0 ||
      meal.costCents > 100000
    )
      throw new TypeError(`Meal catalog entry is incomplete: ${meal.id}.`);
    if (
      ![meal.proteinG, meal.carbsG, meal.fatG].every(
        (value, index) =>
          Number.isSafeInteger(value) && value >= 0 && value <= ([2000, 3000, 1000][index] ?? 0),
      )
    )
      throw new TypeError(`Meal catalog nutrients are missing or invalid: ${meal.id}.`);
    if (
      !Array.isArray(meal.components) ||
      !meal.components.length ||
      meal.components.length !== meal.ingredients.length ||
      meal.components.some(
        (item) =>
          !item ||
          typeof item.food !== "string" ||
          !item.food.trim() ||
          !["g", "cup", "tsp", "tbsp", "medium", "large", ""].includes(item.unit) ||
          (item.quantity === null
            ? item.unit !== ""
            : !Number.isFinite(item.quantity) ||
              item.quantity <= 0 ||
              item.quantity > 10000 ||
              !item.unit),
      )
    )
      throw new TypeError(`Meal catalog quantities are missing or invalid: ${meal.id}.`);
    if (
      !validTags(meal.allergens, TOP_9_ALLERGENS) ||
      !validTags(meal.dietTags, DIETARY_REQUIREMENTS) ||
      !validTags(meal.patterns, DIETARY_PATTERNS, true) ||
      !validTags(meal.favorites, FAVORITE_FOODS)
    )
      throw new TypeError(`Meal catalog safety or preference metadata is invalid: ${meal.id}.`);
  }
}
validateCatalog(CATALOG);

const CATALOG_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(CATALOG))
  .digest("hex")
  .slice(0, 16);

/** @param {string} message @param {string} [code] */
function mealError(message, code = "INVALID_MEAL_PREFERENCES") {
  return Object.assign(new Error(message), { status: 400, code });
}
/** @param {unknown} value @param {string} label @returns {Record<string,any>} */
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw mealError(`${label} must be an object.`);
  return value;
}
/** @param {Record<string,any>} value @param {string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw mealError(`${label} contains unsupported fields: ${extra.join(", ")}.`);
}
/** @template {string} T @param {unknown} value @param {readonly T[]} allowed @param {string} label @returns {T} */
function choice(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(/** @type {T} */ (value)))
    throw mealError(`${label} is invalid.`);
  return /** @type {T} */ (value);
}
/** @param {unknown} value @param {readonly string[]} allowed @param {string} label */
function choices(value, allowed, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !allowed.includes(item)) ||
    new Set(value).size !== value.length
  )
    throw mealError(`${label} contains an invalid or repeated option.`);
  return allowed.filter((item) => value.includes(item));
}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label */
function integer(value, min, max, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw mealError(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** @param {unknown} value */
function sanitizeMealPreferences(value) {
  const input = record(value, "Meal preferences");
  exactKeys(
    input,
    [
      "allergyStatus",
      "allergens",
      "otherAllergies",
      "dietaryPattern",
      "dietaryRequirements",
      "favoriteFoods",
      "mealsPerDay",
      "dailyBudgetCents",
    ],
    "Meal preferences",
  );
  if (typeof input.otherAllergies !== "string")
    throw mealError("Other allergy details must be text.");
  const allergyStatus = choice(
      input.allergyStatus,
      ["none_known", "listed", "other_or_unsure"],
      "Allergy status",
    ),
    allergens = choices(input.allergens, TOP_9_ALLERGENS, "Allergens"),
    otherAllergies = input.otherAllergies.trim();
  if (otherAllergies.length > 200)
    throw mealError("Other allergy details must be 200 characters or fewer.");
  if (allergyStatus === "none_known" && (allergens.length || otherAllergies))
    throw mealError("No-known-allergy status cannot include listed allergy details.");
  if (allergyStatus === "listed" && (!allergens.length || otherAllergies))
    throw mealError(
      "Listed allergy status requires at least one supported allergen and no unreviewed allergy text.",
    );
  if (allergyStatus === "other_or_unsure" && !otherAllergies)
    throw mealError("Describe the other or uncertain allergy so STRATA can fail closed.");
  return {
    allergyStatus,
    allergens,
    otherAllergies,
    dietaryPattern: choice(input.dietaryPattern, DIETARY_PATTERNS, "Dietary pattern"),
    dietaryRequirements: choices(
      input.dietaryRequirements,
      DIETARY_REQUIREMENTS,
      "Dietary requirements",
    ),
    favoriteFoods: choices(input.favoriteFoods, FAVORITE_FOODS, "Favorite foods"),
    mealsPerDay: integer(input.mealsPerDay, 1, 6, "Meals per day"),
    dailyBudgetCents:
      input.dailyBudgetCents == null
        ? null
        : integer(input.dailyBudgetCents, 0, 100000, "Daily food budget"),
  };
}

/** @param {unknown} value @param {string} label @param {boolean} requireCalories */
function nutrientSet(value, label, requireCalories) {
  const input = value == null ? {} : record(value, label);
  exactKeys(input, ["calories", "proteinG", "carbsG", "fatG", "costCents"], label);
  const calories =
      input.calories == null && !requireCalories
        ? 0
        : integer(input.calories, requireCalories ? 1 : 0, 20000, `${label} calories`),
    macroValues = [input.proteinG, input.carbsG, input.fatG],
    provided = macroValues.filter((item) => item != null).length;
  if (provided !== 0 && provided !== 3)
    throw mealError(
      `${label} must include protein, carbohydrates, and fat together or omit all three.`,
      "INVALID_MEAL_TARGET",
    );
  return {
    calories,
    proteinG: provided ? integer(input.proteinG, 0, 2000, `${label} protein`) : null,
    carbsG: provided ? integer(input.carbsG, 0, 3000, `${label} carbohydrates`) : null,
    fatG: provided ? integer(input.fatG, 0, 1000, `${label} fat`) : null,
    costCents: input.costCents == null ? 0 : integer(input.costCents, 0, 100000, `${label} cost`),
  };
}
/** @param {number} value */
function rounded(value) {
  return Math.max(0, Math.round(value));
}
/** @param {string} value */
function hash(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}
/** @param {CatalogMeal} meal @param {ReturnType<typeof sanitizeMealPreferences>} preferences */
function eligible(meal, preferences) {
  return (
    meal.patterns.includes(preferences.dietaryPattern) &&
    preferences.allergens.every((allergen) => !meal.allergens.includes(allergen)) &&
    preferences.dietaryRequirements.every((requirement) => meal.dietTags.includes(requirement))
  );
}
/** @param {number} calorieShare @param {number} calories */
function servingsFor(calorieShare, calories) {
  return Math.max(0.25, Math.min(3.5, Math.round((calorieShare / calories) * 20) / 20));
}
/** @param {CandidateMeal} meal @param {number} calorieShare */
function portion(meal, calorieShare) {
  const servings = servingsFor(calorieShare, meal.calories),
    ingredientQuantities = meal.components.map((item) => ({
      ...item,
      quantity: item.quantity == null ? null : item.quantity * servings,
    }));
  return {
    id: meal.id,
    name: meal.name,
    servings,
    portion: `${servings.toFixed(servings % 1 ? 2 : 0)} × base recipe`,
    servingBasis:
      "Amounts below are scaled for this portion. Nutrition and costs remain approximate recipe estimates; weigh or measure the listed prepared food and check product labels.",
    calories: rounded(meal.calories * servings),
    proteinG: rounded(meal.proteinG * servings),
    carbsG: rounded(meal.carbsG * servings),
    fatG: rounded(meal.fatG * servings),
    estimatedCostCents: rounded(meal.costCents * servings),
    ingredients: ingredientQuantities.map(ingredientLabel),
    ingredientQuantities,
    baseIngredients: [...meal.ingredients],
    allergens: [...meal.allergens],
    dietTags: [...meal.dietTags],
    favoriteMatches: [...meal.favorites.filter((tag) => meal._favorites?.includes(tag))],
  };
}
/** @param {number} count */
function shares(count) {
  const presets = /** @type {Record<number,number[]>} */ ({
    2: [0.45, 0.55],
    3: [0.25, 0.35, 0.4],
    4: [0.2, 0.3, 0.15, 0.35],
    5: [0.2, 0.25, 0.15, 0.25, 0.15],
    6: [0.17, 0.2, 0.13, 0.2, 0.13, 0.17],
  });
  return presets[count] || Array(count).fill(1 / count);
}
/** @param {any[]} meals */
function totals(meals) {
  return meals.reduce(
    (sum, meal) => ({
      calories: sum.calories + meal.calories,
      proteinG: sum.proteinG + meal.proteinG,
      carbsG: sum.carbsG + meal.carbsG,
      fatG: sum.fatG + meal.fatG,
      estimatedCostCents: sum.estimatedCostCents + meal.estimatedCostCents,
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, estimatedCostCents: 0 },
  );
}

/** These tolerances rank approximate recipes; they are not dietary safety limits. @param {any} target */
function fitTolerance(target) {
  return {
    calories: Math.max(50, Math.round(target.calories * 0.1)),
    proteinG: Math.max(10, Math.round((target.proteinG || 0) * 0.15)),
    carbsG: Math.max(20, Math.round((target.carbsG || 0) * 0.2)),
    fatG: Math.max(8, Math.round((target.fatG || 0) * 0.2)),
  };
}
/** @param {any[]} meals @param {any} target @param {number} fraction */
function menuScore(meals, target, fraction) {
  const sum = totals(meals),
    part = {
      calories: target.calories * fraction,
      proteinG: target.proteinG == null ? null : target.proteinG * fraction,
      carbsG: target.carbsG == null ? null : target.carbsG * fraction,
      fatG: target.fatG == null ? null : target.fatG * fraction,
    },
    tolerance = fitTolerance(part);
  /** @param {"calories"|"proteinG"|"carbsG"|"fatG"} key @param {number} weight */
  const error = (key, weight) => {
    const gap = Math.abs(sum[key] - Number(part[key])) / tolerance[key];
    return weight * gap + (gap > 1 ? 4 : 0);
  };
  let score = error("calories", 4);
  if (part.proteinG != null) score += error("proteinG", 2) + error("carbsG", 1) + error("fatG", 1);
  if (target.budgetCents != null)
    score += Math.max(0, sum.estimatedCostCents - target.budgetCents * fraction) / 100;
  return (
    score - meals.reduce((sum, meal) => sum + Math.min(2, meal.favoriteMatches.length) * 0.35, 0)
  );
}
/** A bounded beam compares whole menus so a favorite cannot mask a large macro gap. @param {CandidateMeal[]} candidates @param {any} remaining @param {number} count @param {string} seed */
function rankedMenus(candidates, remaining, count, seed) {
  /** @type {{meals:any[],score:number,tie:number}[]} */ let beam = [
    { meals: [], score: 0, tie: 0 },
  ];
  let fraction = 0;
  for (const weight of shares(count)) {
    fraction += weight;
    const next = [];
    for (const current of beam)
      for (const candidate of candidates) {
        if (candidates.length >= count && current.meals.some((meal) => meal.id === candidate.id))
          continue;
        const meals = [...current.meals, portion(candidate, remaining.calories * weight)],
          key = meals.map((meal) => `${meal.id}:${meal.servings}`).join("|");
        next.push({
          meals,
          score: menuScore(meals, remaining, fraction),
          tie: hash(`${seed}\0${key}`),
        });
      }
    next.sort((a, b) => a.score - b.score || a.tie - b.tie);
    beam = next.slice(0, 48);
  }
  return beam;
}

/**
 * Generate deterministic alternatives for the unconsumed part of one day.
 * Allergies and dietary rules filter before ranking; favorites and price only rank.
 * @param {unknown} value
 */
function generateRemainingDayFoodOptions(value) {
  const input = record(value, "Meal option request");
  exactKeys(
    input,
    ["mealPreferences", "target", "consumed", "mealsRemaining", "seed"],
    "Meal option request",
  );
  const preferences = sanitizeMealPreferences(input.mealPreferences),
    target = nutrientSet(input.target, "Daily target", true),
    consumed = nutrientSet(input.consumed, "Consumed intake", false),
    mealsRemaining =
      input.mealsRemaining == null
        ? preferences.mealsPerDay
        : integer(input.mealsRemaining, 1, preferences.mealsPerDay, "Meals remaining"),
    seed = String(input.seed ?? "");
  if (seed.length > 200)
    throw mealError("Meal option seed must be 200 characters or fewer.", "INVALID_MEAL_TARGET");
  const macrosKnown =
    target.proteinG != null && (consumed.calories === 0 || consumed.proteinG != null);
  const remaining = {
    calories: Math.max(0, target.calories - consumed.calories),
    proteinG: !macrosKnown ? null : Math.max(0, (target.proteinG ?? 0) - (consumed.proteinG || 0)),
    carbsG: !macrosKnown ? null : Math.max(0, (target.carbsG ?? 0) - (consumed.carbsG || 0)),
    fatG: !macrosKnown ? null : Math.max(0, (target.fatG ?? 0) - (consumed.fatG || 0)),
    budgetCents:
      preferences.dailyBudgetCents == null
        ? null
        : Math.max(0, preferences.dailyBudgetCents - consumed.costCents),
  };
  const common = {
    catalogFingerprint: CATALOG_FINGERPRINT,
    nutritionProvenance: NUTRITION_PROVENANCE,
    safetyDisclaimer: SAFETY_DISCLAIMER,
    costDisclaimer: COST_DISCLAIMER,
    remaining,
  };
  if (preferences.allergyStatus === "other_or_unsure")
    return {
      ...common,
      status: "manual_review",
      reason:
        "Other or uncertain allergy information cannot be matched safely to STRATA’s supported allergen tags. Review food choices manually with a qualified professional.",
      options: [],
    };
  if (remaining.calories === 0)
    return {
      ...common,
      status: "target_met",
      reason: "The entered calories already meet or exceed this day’s planning target.",
      options: [],
    };
  const candidates = /** @type {CandidateMeal[]} */ (
    CATALOG.filter((meal) => eligible(meal, preferences)).map((meal) => ({
      ...meal,
      _favorites: preferences.favoriteFoods,
    }))
  );
  if (!candidates.length)
    return {
      ...common,
      status: "no_compatible_options",
      reason:
        "No catalog meal passed every saved allergy and dietary requirement. STRATA did not relax those safety filters.",
      options: [],
    };
  const options = [],
    keys = new Set(),
    tolerance = fitTolerance(remaining);
  for (const candidate of rankedMenus(candidates, remaining, mealsRemaining, seed)) {
    const selected = candidate.meals,
      key = selected
        .map((meal) => meal.id)
        .sort()
        .join("|");
    if (keys.has(key)) continue;
    keys.add(key);
    const summary = totals(selected),
      macroGap =
        remaining.proteinG == null
          ? null
          : {
              proteinG: summary.proteinG - (remaining.proteinG ?? 0),
              carbsG: summary.carbsG - (remaining.carbsG ?? 0),
              fatG: summary.fatG - (remaining.fatG ?? 0),
            };
    const calorieDifference = summary.calories - remaining.calories,
      withinCalorieFit = Math.abs(calorieDifference) <= tolerance.calories,
      withinMacroFit =
        macroGap == null
          ? null
          : Math.abs(macroGap.proteinG) <= tolerance.proteinG &&
            Math.abs(macroGap.carbsG) <= tolerance.carbsG &&
            Math.abs(macroGap.fatG) <= tolerance.fatG;
    options.push({
      id: createHash("sha256")
        .update(`${CATALOG_FINGERPRINT}\0${seed}\0${key}`)
        .digest("hex")
        .slice(0, 16),
      meals: selected,
      totals: summary,
      calorieDifference,
      calorieFitTolerance: tolerance.calories,
      withinCalorieFit,
      macroDifference: macroGap,
      macroFitTolerance:
        macroGap == null
          ? null
          : { proteinG: tolerance.proteinG, carbsG: tolerance.carbsG, fatG: tolerance.fatG },
      withinMacroFit,
      withinNutritionFit: withinCalorieFit && withinMacroFit !== false,
      budgetDifferenceCents:
        remaining.budgetCents == null ? null : summary.estimatedCostCents - remaining.budgetCents,
      withinEnteredBudget:
        remaining.budgetCents == null ? null : summary.estimatedCostCents <= remaining.budgetCents,
    });
    if (options.length === 3) break;
  }
  const allFit = options.every((option) => option.withinNutritionFit),
    ready = options.length === 3 && allFit,
    reason = !allFit
      ? "These are partial meal ideas: the catalog cannot closely match all remaining calorie and macro targets. Review the differences and actual portions; the fit tolerances are planning heuristics, not dietary safety limits."
      : options.length === 3
        ? null
        : "Fewer than three distinct menus passed every hard filter; STRATA did not relax those filters.";
  return { ...common, status: ready ? "ready" : "limited", reason, options };
}

module.exports = {
  CATALOG,
  CATALOG_FINGERPRINT,
  COST_DISCLAIMER,
  DIETARY_PATTERNS,
  DIETARY_REQUIREMENTS,
  FAVORITE_FOODS,
  NUTRITION_PROVENANCE,
  SAFETY_DISCLAIMER,
  TOP_9_ALLERGENS,
  generateRemainingDayFoodOptions,
  sanitizeMealPreferences,
  validateCatalog,
};
