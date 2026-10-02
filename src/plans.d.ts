import type { JsonObject, TrainingPreferences, WeeklyPlan } from "./domain-types";

export const DAYS: string[];
export const EXERCISES: JsonObject[];
export const EXERCISE_IDS: Set<string>;
export const EQUIPMENT: string[];
export function cleanText(value: unknown, max: number): string;
export function defaultPlan(): WeeklyPlan;
export function defaultPreferences(): TrainingPreferences;
export function expectedPlanRevision(value: unknown): number;
export function planStats(plan: WeeklyPlan): { planCount: number; workoutDays: number };
export function sanitizePlan(input: unknown, options?: { repair?: boolean }): WeeklyPlan;
export function sanitizePreferences(input: unknown): TrainingPreferences;
export function sanitizeRating(input: unknown): Record<string, number>;
export function sanitizeMonthlyPlan(input: unknown, options?: { generatedAt?: number }): JsonObject;
