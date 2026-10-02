// @ts-check
"use strict";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** @param {any} schema */
const nullable = (schema) => ({ anyOf: [{ type: "null" }, schema] });
/** @param {number} maxLength */
const shortString = (maxLength) => ({ type: "string", minLength: 1, maxLength });

// Atomic Chat uses llama.cpp's schema field inside json_object. Per-request codes and day counts
// constrain generation itself, before STRATA performs its independent semantic validation.
/** @param {{codes?:string[],requireWeek?:boolean,trainingDays?:number|null,trainingDayNames?:string[]|null,answerOnly?:boolean}} [options] */
function aiResponseFormat(options = {}) {
  const {
    codes = [],
    requireWeek = false,
    trainingDays = null,
    trainingDayNames = [],
    answerOnly = false,
  } = options;
  const names = [...new Set((trainingDayNames || []).filter((day) => DAYS.includes(day)))];
  const count =
    typeof trainingDays === "number" &&
    Number.isInteger(trainingDays) &&
    trainingDays >= 1 &&
    trainingDays <= 6
      ? trainingDays
      : names.length || null;
  const code = codes.length
    ? { type: "string", enum: [...new Set(codes.map(String))] }
    : shortString(80);
  const exercise = {
    type: "object",
    additionalProperties: false,
    properties: { code, sets: { type: "integer", minimum: 1, maximum: 6 }, reps: shortString(20) },
    required: ["code", "sets", "reps"],
  };
  const day = {
    type: "object",
    additionalProperties: false,
    properties: {
      day: { type: "string", enum: names.length ? names : DAYS },
      name: shortString(40),
      exercises: { type: "array", minItems: 2, maxItems: 8, items: exercise },
    },
    required: ["day", "name", "exercises"],
  };
  const week = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: shortString(60),
      focus: { type: "string", enum: ["balanced", "strength", "hypertrophy"] },
      days: { type: "array", minItems: count ?? 1, maxItems: count ?? 6, items: day },
    },
    required: ["title", "focus", "days"],
  };
  const nutrition = {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string", enum: ["fat_loss", "maintenance", "muscle_gain"] },
      pace: { type: "string", enum: ["gentle", "moderate"] },
      pattern: { type: "string", enum: ["steady", "zigzag", "flexible_day"] },
      flexibleDay: nullable({ type: "string", enum: DAYS }),
      macros: nullable({ type: "string", enum: ["balanced", "higher_protein"] }),
    },
    required: ["goal", "pace", "pattern", "flexibleDay", "macros"],
  };
  const suggestion = {
    type: "object",
    additionalProperties: false,
    properties: {
      text: shortString(240),
      swap: nullable({
        type: "object",
        additionalProperties: false,
        properties: {
          day: { type: "string", enum: DAYS },
          from: shortString(80),
          to: shortString(80),
        },
        required: ["day", "from", "to"],
      }),
    },
    required: ["text", "swap"],
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: shortString(900),
      week: answerOnly ? { const: null } : requireWeek ? week : nullable(week),
      nutrition: answerOnly ? { const: null } : nullable(nutrition),
      suggestions: answerOnly ? { const: [] } : { type: "array", maxItems: 3, items: suggestion },
      search: answerOnly ? { const: [] } : { type: "array", maxItems: 6, items: shortString(60) },
    },
    required: ["reply", "week", "nutrition", "suggestions", "search"],
  };
  return { type: "json_object", schema };
}

module.exports = { aiResponseFormat };
