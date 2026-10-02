/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPersonalTrainingMealsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DIETARY_PATTERNS = Object.freeze(["omnivore", "pescatarian", "vegetarian", "vegan"]);
  const DIETARY_REQUIREMENTS = Object.freeze(["gluten_free", "dairy_free"]);
  const ALLERGENS = Object.freeze([
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

  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const cleanText = (value) =>
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " ");
  const finiteNumber = (value) => {
    if (
      value == null ||
      !["number", "string"].includes(typeof value) ||
      String(value).trim() === ""
    )
      return null;
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  function selectedValues(value) {
    return Array.isArray(value)
      ? value.map(cleanText).filter(Boolean)
      : value == null || value === ""
        ? []
        : [cleanText(value)].filter(Boolean);
  }
  function allowedList(value, allowed, field, errors) {
    const selected = [...new Set(selectedValues(value))],
      unknown = selected.filter((item) => !allowed.includes(item));
    if (unknown.length) errors.push({ field, message: "Choose only the listed options." });
    return allowed.filter((item) => selected.includes(item));
  }
  function budgetCents(source, errors) {
    if (source.dailyBudgetCents !== undefined) {
      const cents = finiteNumber(source.dailyBudgetCents);
      if (Number.isSafeInteger(cents) && cents >= 0 && cents <= 100_000) return cents;
      if (cents == null) return null;
      errors.push({
        field: "dailyBudgetUsd",
        message: "Enter a daily budget from $0.00–$1,000.00, or leave it blank.",
      });
      return null;
    }
    const raw = cleanText(source.dailyBudgetUsd ?? source.dailyBudget);
    if (!raw) return null;
    if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(raw)) {
      errors.push({
        field: "dailyBudgetUsd",
        message: "Enter a daily budget from $0.00–$1,000.00, or leave it blank.",
      });
      return null;
    }
    const [whole, fraction = ""] = raw.split("."),
      cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100_000) {
      errors.push({
        field: "dailyBudgetUsd",
        message: "Enter a daily budget from $0.00–$1,000.00, or leave it blank.",
      });
      return null;
    }
    return cents;
  }

  function normalizeMealPreferencesDraft(draft) {
    const source = isRecord(draft) ? draft : {},
      errors = [];
    const dietaryPattern = cleanText(source.dietaryPattern).toLowerCase();
    if (!DIETARY_PATTERNS.includes(dietaryPattern))
      errors.push({ field: "dietaryPattern", message: "Choose a dietary pattern." });
    const dietaryRequirements = allowedList(
      source.dietaryRequirements,
      DIETARY_REQUIREMENTS,
      "dietaryRequirements",
      errors,
    );
    const allergens = allowedList(source.allergens, ALLERGENS, "allergens", errors),
      otherAllergies = cleanText(source.otherAllergies);
    const explicitStatus = cleanText(source.allergyStatus),
      noneKnown = source.noKnownListedAllergies === true,
      otherOrUnsure = source.otherOrUnsureAllergies === true;
    if (explicitStatus && !["none_known", "listed", "other_or_unsure"].includes(explicitStatus))
      errors.push({ field: "allergyStatus", message: "Review the allergy acknowledgement." });
    const allergyStatus = ["none_known", "listed", "other_or_unsure"].includes(explicitStatus)
      ? explicitStatus
      : noneKnown
        ? "none_known"
        : otherOrUnsure
          ? "other_or_unsure"
          : "";
    if (allergyStatus === "none_known" && (allergens.length || otherOrUnsure || otherAllergies))
      errors.push({
        field: "allergyStatus",
        message: "Choose either no known listed allergies or the allergies that apply—not both.",
      });
    if (allergyStatus === "listed" && !allergens.length)
      errors.push({ field: "allergens", message: "Choose at least one listed allergen." });
    if (allergyStatus === "other_or_unsure" && !otherAllergies)
      errors.push({
        field: "otherAllergies",
        message:
          "Describe the other allergy or uncertainty so STRATA can withhold automatic matches.",
      });
    if (!allergyStatus)
      errors.push({
        field: "allergyStatus",
        message: "Confirm no known listed allergies or choose every allergen that applies.",
      });
    if (otherAllergies.length > 200)
      errors.push({
        field: "otherAllergies",
        message: "Keep the allergy note to 200 characters or fewer.",
      });
    if (allergyStatus !== "other_or_unsure" && otherAllergies)
      errors.push({
        field: "otherAllergies",
        message: "Use the other-or-unsure option before adding an allergy note.",
      });
    const favoriteFoods = allowedList(
        source.favoriteFoods,
        FAVORITE_FOODS,
        "favoriteFoods",
        errors,
      ),
      mealsPerDay = finiteNumber(source.mealsPerDay);
    if (!Number.isSafeInteger(mealsPerDay) || mealsPerDay < 1 || mealsPerDay > 6)
      errors.push({ field: "mealsPerDay", message: "Choose between 1 and 6 meals per day." });
    const dailyBudgetCents = budgetCents(source, errors);
    const mealPreferences = {
      allergyStatus: allergyStatus || "none_known",
      allergens: allergyStatus === "none_known" ? [] : allergens,
      otherAllergies: allergyStatus === "other_or_unsure" ? otherAllergies : "",
      dietaryPattern: DIETARY_PATTERNS.includes(dietaryPattern) ? dietaryPattern : "omnivore",
      dietaryRequirements,
      favoriteFoods,
      mealsPerDay: Number.isSafeInteger(mealsPerDay) ? mealsPerDay : 3,
      dailyBudgetCents,
    };
    return { ok: errors.length === 0, payload: { mealPreferences }, errors };
  }

  function nutrientProgress(target, consumed, label) {
    const targetValue = finiteNumber(target),
      consumedValue = finiteNumber(consumed ?? 0);
    if (targetValue == null || targetValue < 0)
      throw new TypeError(`${label} target must be zero or a positive number.`);
    if (consumedValue == null || consumedValue < 0)
      throw new TypeError(`${label} consumed must be zero or a positive number.`);
    const difference = targetValue - consumedValue;
    return {
      target: targetValue,
      consumed: consumedValue,
      remaining: Math.max(0, difference),
      overBy: Math.max(0, -difference),
    };
  }
  function remainingNutrition(target, consumed = {}) {
    if (!isRecord(target) || !isRecord(consumed))
      throw new TypeError("Nutrition target and intake must be objects.");
    const calories = nutrientProgress(
        target.calories ?? target.targetCalories,
        consumed.calories ?? consumed.consumedCalories,
        "Calories",
      ),
      macroTarget = isRecord(target.macros) ? target.macros : target;
    const hasMacros = ["proteinG", "carbsG", "fatG"].every(
      (key) => finiteNumber(macroTarget[key]) != null,
    );
    const consumedKnown =
      ["proteinG", "carbsG", "fatG"].every((key) => finiteNumber(consumed[key]) != null) ||
      (calories.consumed === 0 &&
        ["proteinG", "carbsG", "fatG"].every((key) => consumed[key] == null));
    const macros =
      hasMacros && consumedKnown
        ? {
            proteinG: nutrientProgress(macroTarget.proteinG, consumed.proteinG, "Protein"),
            carbsG: nutrientProgress(macroTarget.carbsG, consumed.carbsG, "Carbohydrate"),
            fatG: nutrientProgress(macroTarget.fatG, consumed.fatG, "Fat"),
          }
        : null;
    return { calories, macros };
  }
  function perMealTarget(remaining, mealsRemaining) {
    if (
      !isRecord(remaining) ||
      !isRecord(remaining.calories) ||
      !Number.isSafeInteger(mealsRemaining) ||
      mealsRemaining < 1 ||
      mealsRemaining > 6
    )
      throw new TypeError("One to six remaining meals are required.");
    const divide = (item) => Math.round(Number(item?.remaining || 0) / mealsRemaining),
      macros = remaining.macros
        ? {
            proteinG: divide(remaining.macros.proteinG),
            carbsG: divide(remaining.macros.carbsG),
            fatG: divide(remaining.macros.fatG),
          }
        : null;
    return { calories: divide(remaining.calories), macros, mealsRemaining };
  }
  function optionFitSummary(option) {
    const source = isRecord(option) ? option : {},
      difference = (value, unit) => {
        const amount = finiteNumber(value);
        return amount == null
          ? "unavailable"
          : amount === 0
            ? "matches the remaining plan"
            : `${Math.abs(Math.round(amount)).toLocaleString()} ${unit} ${amount < 0 ? "below" : "above"} the remaining plan`;
      };
    const macros =
      isRecord(source.macroDifference) &&
      ["proteinG", "carbsG", "fatG"].every(
        (key) => finiteNumber(source.macroDifference[key]) != null,
      )
        ? source.macroDifference
        : null;
    return {
      calories: difference(source.calorieDifference, "kcal"),
      macros: macros
        ? `Protein ${difference(macros.proteinG, "g")}; carbs ${difference(macros.carbsG, "g")}; fat ${difference(macros.fatG, "g")}.`
        : null,
    };
  }
  const formatCalories = (value) => {
    const amount = finiteNumber(value);
    return amount == null || amount < 0 ? "—" : `${Math.round(amount).toLocaleString()} kcal`;
  };
  const formatGrams = (value) => {
    const amount = finiteNumber(value);
    return amount == null || amount < 0 ? "—" : `${Math.round(amount).toLocaleString()} g`;
  };
  const formatUsd = (cents) => {
    if (cents == null) return "No daily budget";
    const amount = finiteNumber(cents);
    return amount == null || amount < 0
      ? "—"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
  };

  return Object.freeze({
    ALLERGENS,
    DIETARY_PATTERNS,
    DIETARY_REQUIREMENTS,
    FAVORITE_FOODS,
    formatCalories,
    formatGrams,
    formatUsd,
    normalizeMealPreferencesDraft,
    optionFitSummary,
    perMealTarget,
    remainingNutrition,
  });
});
